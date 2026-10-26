import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, isObject } from './scale.ts';
import { hasValue, list, num, strings, timestamp } from './schedule.ts';

const runtime = 'sensor.ls_effects_runtime';
const overrideSensor = 'sensor.ls_overrides';
function revisionOf(ctx: ScriptContext): string { return ctx.state[overrideSensor]?.last_updated ?? ''; }

/** Delta output actor: invalidate touched lamps before sending, acknowledge only complete batches. */
export function dispatch(ctx: ScriptContext, args: JsonObject): JsonValue {
  const plan = object(args.plan), revision = String(plan.revision ?? ''), resolved = object(plan.resolved), base = object(plan.base);
  if (revision !== revisionOf(ctx) || num(plan.plan_order) < num(ctx.attr(runtime, 'plan_order'))) return null;
  const catalog = ctx.run('effects_catalog');
  const applied = ctx.attr(runtime, 'applied');
  const previous = object(applied === null || applied === undefined ? ctx.attr(runtime, 'targets') : applied);
  const previousEffects = object(ctx.attr(runtime, 'assignments'));
  const assignments = object(resolved.assignments);
  const requested = Array.isArray(args.lights) ? strings(args.lights) : args.lights ? [String(args.lights)] : [];
  const outputTargets = strings(plan.output_targets), remoteRooms = strings(plan.remote_rooms);
  const ordinary: JsonObject = {};
  for (const [lamp, raw] of Object.entries(object(resolved.targets))) {
    const target = object(raw);
    if (target.is_room || (outputTargets.length && !outputTargets.includes(lamp))) continue;
    if (ctx.get(lamp) !== 'on') continue;
    if (!(requested.includes(lamp) || remoteRooms.includes(String(target.area)) || (object(base[lamp]).send ?? true))) continue;
    if (requested.includes(lamp) || (Object.hasOwn(previousEffects, lamp) && !Object.hasOwn(assignments, lamp)) || !isDeepStrictEqual(target, previous[lamp])) ordinary[lamp] = target;
  }
  const assigned = object(ctx.run('effects_assign', { targets: resolved.targets ?? {}, assignments, revision, invalidate: Object.keys(ordinary), plan_order: plan.plan_order ?? 0 }));
  const batch = object(ctx.run('effects_frame_plan', { targets: ordinary, catalog, timestamp: timestamp(ctx.now),
    transition_cap: plan.remote || remoteRooms.length ? 0.5 : null, transition_rooms: plan.remote ? null : remoteRooms }));
  const emission = object(ctx.run('effects_emit', { commands: batch.commands ?? [], revision, generation: assigned.generation ?? null }));
  const generation = assigned.generation ?? null;
  if (revision !== revisionOf(ctx) || generation !== ctx.attr(runtime, 'generation')) return null;
  if (Object.keys(ordinary).length && emission.completed) {
    ctx.emit('variable.update_sensor', { value: generation, replace_attributes: false,
      attributes: { applied: { ...object(ctx.attr(runtime, 'applied')), ...ordinary } } }, { entity_id: runtime },
    { revision, generation, requiresOutputSuccess: true });
  }
  for (const [entity, raw] of Object.entries(object(plan.switches))) {
    const state = object(raw).on ? 'on' : 'off';
    if (revision === revisionOf(ctx) && ctx.get(entity) !== state) ctx.emit(`homeassistant.turn_${state}`, {}, { entity_id: entity }, { revision, generation });
  }
  if (revision !== revisionOf(ctx)) return null;
  for (const raw of list(plan.mirror)) {
    const mirror = object(raw);
    ctx.emit('input_select.select_option', { option: mirror.option ?? '' }, { entity_id: mirror.entity ?? '' }, { revision, generation });
  }
  if (plan.sara_mirror === 'on' || plan.sara_mirror === 'off') ctx.emit(`input_boolean.turn_${plan.sara_mirror}`, {}, { entity_id: 'input_boolean.ls_sara_mode_mirror' }, { revision, generation });
  if (list(plan.stale_keys).length) ctx.fire('ls_override', { op: 'clear', keys: plan.stale_keys!, via: 'rule_next_block', expected_revision: revision });
  return { completed: Boolean(emission.completed) && revision === revisionOf(ctx) && generation === ctx.attr(runtime, 'generation'), published_at: emission.published_at ?? [] };
}

/** Coalesce pending room versions, preserving unrelated rooms and retrying incomplete output. */
export function render(ctx: ScriptContext): JsonValue {
  const started = timestamp(ctx.now), revision = revisionOf(ctx);
  const received = ctx.attr(overrideSensor, 'received_at') ?? null, request = ctx.attr(overrideSensor, 'last_request') ?? null;
  const pending = object(ctx.attr(overrideSensor, 'pending_rooms')), handled = object(ctx.attr(runtime, 'handled_rooms'));
  const fullVersion = ctx.attr(overrideSensor, 'full_version') ?? null;
  const full = Boolean(fullVersion) && fullVersion !== ctx.attr(runtime, 'handled_full');
  const rooms = Object.keys(pending).filter(room => pending[room] !== handled[room]);
  if (!full && !rooms.length) return null;
  let plan: JsonObject, lights: JsonValue = [], updates: JsonObject = {};
  if (full) {
    const planned = object(ctx.run('ls_plan', { reason: ctx.attr(overrideSensor, 'full_reason') || 'config' }));
    plan = { ...object(planned.plan), remote_rooms: rooms };
    lights = ctx.attr(overrideSensor, 'full_lights') || [];
    const bases = object(plan.base), gradients = object(plan.gradients);
    const areas = [...new Set(Object.values(bases).map(t => object(t).area).filter((area): area is string => typeof area === 'string' && area.length > 0))];
    for (const room of areas) {
      const old = object(ctx.attr(`sensor.ls_cache_${room}`, 'cache'));
      const values = Object.fromEntries(Object.entries(bases).filter(([key, t]) => object(t).area === room && Object.hasOwn(gradients, key)).map(([key]) => [key, gradients[key]!]));
      if (!isDeepStrictEqual(values, old.gradients)) updates[room] = { ...old, gradients: values };
    }
  } else {
    let targets = object(ctx.attr(runtime, 'targets')), assignments = object(ctx.attr(runtime, 'assignments'));
    let bases: JsonObject = {}, switches: JsonObject = {}, mirrors: JsonValue[] = [], stale: string[] = [];
    let lastPlan: JsonObject = {};
    for (const room of rooms) {
      const planned = object(ctx.run('ls_room_plan', { room, overrides: object(ctx.attr(overrideSensor, 'overrides')), cache: object(ctx.attr(`sensor.ls_cache_${room}`, 'cache')), reason: 'remote' }));
      lastPlan = object(planned.plan);
      const resolved = object(lastPlan.resolved);
      targets = { ...Object.fromEntries(Object.entries(targets).filter(([, t]) => object(t).area !== room)), ...object(resolved.targets) };
      assignments = { ...Object.fromEntries(Object.entries(assignments).filter(([, t]) => object(t).area !== room)), ...object(resolved.assignments) };
      bases = { ...bases, ...object(lastPlan.base) }; switches = { ...switches, ...object(lastPlan.switches) };
      mirrors.push(...list(lastPlan.mirror)); stale = [...new Set([...stale, ...strings(lastPlan.stale_keys)])];
      if (isObject(planned.cache_update)) updates[room] = planned.cache_update;
    }
    plan = { base: bases, resolved: { targets, assignments }, switches, mirror: mirrors, stale_keys: stale, revision, plan_order: started, remote: false, remote_rooms: rooms, sara_mirror: lastPlan.sara_mirror ?? null };
  }
  if (revision !== revisionOf(ctx)) return null;
  for (const [room, cache] of Object.entries(updates)) {
    const entity = `sensor.ls_cache_${room}`;
    if (hasValue(ctx, entity)) ctx.emit('variable.update_sensor', { value: ctx.now, attributes: { cache }, replace_attributes: false }, { entity_id: entity });
  }
  if (!full) plan = { ...plan, output_targets: Object.keys(object(plan.base)) };
  const plannedAt = timestamp(ctx.now);
  const emission = object(ctx.run('ls_dispatch', { plan, lights }));
  if (!emission.completed || revision !== revisionOf(ctx)) return null;
  const generation = ctx.attr(runtime, 'generation') ?? null;
  ctx.emit('variable.update_sensor', { value: ctx.now, replace_attributes: false, attributes: {
    handled_rooms: pending, handled_full: full ? fullVersion : ctx.attr(runtime, 'handled_full') ?? null,
    last_latency: { request_id: request, received_at: received, started_at: started, planned_at: plannedAt, published_at: emission.published_at ?? [], completed_at: timestamp(ctx.now), rooms, full },
  } }, { entity_id: runtime }, { revision, generation, requiresOutputSuccess: true });
  return null;
}
export const dispatchHandlers: ScriptHandlers = { ls_dispatch: dispatch, ls_render: ctx => render(ctx) };
