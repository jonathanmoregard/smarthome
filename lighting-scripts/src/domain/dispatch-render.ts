import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { isObject, jinjaTruthy, object, ParseError, requireArray, requireBoolean, requireNumber, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import { hasValue, list, strings, timestamp } from './schedule.ts';

const runtime = 'sensor.ls_effects_runtime';
const overrideSensor = 'sensor.ls_overrides';
function revisionOf(ctx: ScriptContext): string { return ctx.state[overrideSensor]?.last_updated ?? ''; }

/** HA uses null for an entity attribute with no value; a present revision is a timestamp token. */
function optionalRevisionAttribute(value: JsonValue | undefined, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new ParseError(`${context} must be a non-empty string`);
  return value;
}

interface DispatchDetails {
  base: JsonObject;
  targets: JsonObject;
  targetViews: Record<string, { raw: JsonObject; isRoom: boolean; area: JsonValue | undefined }>;
  assignments: JsonObject;
  requested: JsonValue[];
  outputTargets: JsonValue[];
  remoteRooms: JsonValue[];
  remote: boolean;
  switches: () => Array<() => { entity: string; on: boolean }>;
  mirrors: () => Array<() => { option: string; entity: string }>;
  staleKeys: () => JsonValue[];
  saraMirror: JsonValue | undefined;
}
interface DispatchArgs {
  revision: string;
  planOrder: number;
  details: () => DispatchDetails;
}

function lazy<T>(parse: () => T): () => T {
  let parsed = false;
  let value: T;
  return () => {
    if (!parsed) {
      value = parse();
      parsed = true;
    }
    return value;
  };
}

function parseRequestedLights(value: JsonValue | undefined): JsonValue[] {
  const requested = value === undefined ? null : value; // captured `| default(none)`
  return Array.isArray(requested) ? requested : jinjaTruthy(requested) ? [requested] : [];
}

function parseDispatchDetails(plan: JsonObject, lights: JsonValue | undefined): DispatchDetails {
  const resolved = requireObject(plan, 'resolved', 'ls_dispatch.plan');
  const base = requireObject(plan, 'base', 'ls_dispatch.plan');
  const targets = requireObject(resolved, 'targets', 'ls_dispatch.plan.resolved');
  const targetViews = Object.fromEntries(Object.entries(targets).map(([lamp, raw]) => {
    const target = requireObject({ raw }, 'raw', `ls_dispatch.plan.resolved.targets.${lamp}`);
    return [lamp, { raw: target, isRoom: jinjaTruthy(target.is_room), area: target.area }];
  }));
  return {
    base,
    targets,
    targetViews,
    assignments: requireObject(resolved, 'assignments', 'ls_dispatch.plan.resolved'),
    requested: parseRequestedLights(lights),
    // Both are read unfiltered in the captured script, but an unfiltered read
    // is not the same as a required field: Jinja's Undefined iterates as empty
    // and reports `| length` 0, raising only in arithmetic or a coercion
    // filter. These two are iterated, and `ls_render` only sets
    // `output_targets` on the partial-plan path, so absence is legal and
    // requiring them broke seven parity modules.
    outputTargets: plan.output_targets === undefined ? [] : requireArray(plan, 'output_targets', 'ls_dispatch.plan'),
    remoteRooms: plan.remote_rooms === undefined ? [] : requireArray(plan, 'remote_rooms', 'ls_dispatch.plan'),
    remote: jinjaTruthy(plan.remote),
    // These stages run only after effect assignment and publication. All three
    // collections are iterated rather than used arithmetically, and the
    // captured script guards them (`switches` has a `| default(...)` site,
    // `stale_keys` two `is defined` tests), so an absent key is silently empty
    // in the oracle and must be here too.
    switches: lazy(() => Object.entries(plan.switches === undefined ? {} : requireObject(plan, 'switches', 'ls_dispatch.plan')).map(([entity, raw]) => lazy(() => {
        const value = requireObject({ raw }, 'raw', `ls_dispatch.plan.switches.${entity}`);
        return { entity, on: jinjaTruthy(value.on) };
      }))),
    mirrors: lazy(() => (plan.mirror === undefined ? [] : requireArray(plan, 'mirror', 'ls_dispatch.plan')).map((raw, index) => lazy(() => {
        const value = requireObject({ raw }, 'raw', `ls_dispatch.plan.mirror[${index}]`);
        return {
          option: requireString(value, 'option', `ls_dispatch.plan.mirror[${index}]`),
          entity: requireString(value, 'entity', `ls_dispatch.plan.mirror[${index}]`),
        };
      }))),
    staleKeys: lazy(() => plan.stale_keys === undefined ? [] : requireArray(plan, 'stale_keys', 'ls_dispatch.plan')),
    saraMirror: plan.sara_mirror,
  };
}

function baselineSend(base: JsonObject, lamp: string): boolean {
  if (base[lamp] === undefined) return true;
  const baseline = requireObject(base, lamp, 'ls_dispatch.plan.base');
  return baseline.send === undefined ? true : jinjaTruthy(baseline.send);
}

/** Delta output actor: invalidate touched lamps before sending, acknowledge only complete batches. */
/**
 * `ls_dispatch`'s result. `null` is one of its real answers -- every
 * revision-moved and stale-plan guard returns it -- so it is in the type rather
 * than hidden behind a lenient read at the caller.
 */
export type DispatchResult = { completed: boolean; published_at: number[] } | null;

export function dispatch(ctx: ScriptContext, args: DispatchArgs): DispatchResult {
  const revision = args.revision;
  if (revision !== revisionOf(ctx) || args.planOrder < requireNumber({ plan_order: ctx.attr(runtime, 'plan_order') ?? 0 }, 'plan_order', 'ls_dispatch runtime')) return null;
  const { base, targets, targetViews, assignments, requested, outputTargets, remoteRooms,
    remote, switches, mirrors, staleKeys, saraMirror } = args.details();
  const catalog = ctx.run('effects_catalog');
  const applied = ctx.attr(runtime, 'applied');
  const previous = object(applied === null || applied === undefined ? ctx.attr(runtime, 'targets') : applied);
  const previousEffects = object(ctx.attr(runtime, 'assignments'));
  const ordinary: JsonObject = {};
  for (const [lamp, target] of Object.entries(targetViews)) {
    if (target.isRoom || (outputTargets.length && !outputTargets.includes(lamp))) continue;
    if (ctx.get(lamp) !== 'on') continue;
    if (!(requested.includes(lamp) || remoteRooms.includes(target.area ?? null) || baselineSend(base, lamp))) continue;
    if (requested.includes(lamp) || (Object.hasOwn(previousEffects, lamp) && !Object.hasOwn(assignments, lamp)) || !isDeepStrictEqual(target.raw, previous[lamp])) ordinary[lamp] = target.raw;
  }
  const assigned = ctx.call('effects_assign', { targets, assignments, revision, invalidate: Object.keys(ordinary), plan_order: args.planOrder });
  const batch = object(ctx.run('effects_frame_plan', { targets: ordinary, catalog, timestamp: timestamp(ctx.now),
    transition_cap: remote || remoteRooms.length ? 0.5 : null, transition_rooms: remote ? null : remoteRooms }));
  const emission = ctx.call('effects_emit', { commands: batch.commands ?? [], revision, generation: assigned.generation });
  // `requireBoolean(emission.completed)`, `?? null` on the generation and
  // `?? []` on published_at are all gone: `emitCommands` builds both fields
  // every time and `assignEffects` already normalises an absent generation to
  // null, so none of the three could fire for the real handlers.
  const completed = emission.completed;
  const generation = assigned.generation;
  if (revision !== revisionOf(ctx) || generation !== ctx.attr(runtime, 'generation')) return null;
  if (Object.keys(ordinary).length && completed) {
    ctx.emit('variable.update_sensor', { value: generation, replace_attributes: false,
      attributes: { applied: { ...object(ctx.attr(runtime, 'applied')), ...ordinary } } }, { entity_id: runtime },
    { revision, generation, requiresOutputSuccess: true });
  }
  for (const parseSwitch of switches()) {
    const { entity, on } = parseSwitch();
    const state = on ? 'on' : 'off';
    if (revision === revisionOf(ctx) && ctx.get(entity) !== state) ctx.emit(`homeassistant.turn_${state}`, {}, { entity_id: entity }, { revision, generation });
  }
  if (revision !== revisionOf(ctx)) return null;
  for (const parseMirror of mirrors()) {
    const mirror = parseMirror();
    ctx.emit('input_select.select_option', { option: mirror.option }, { entity_id: mirror.entity }, { revision, generation });
  }
  if (saraMirror === 'on' || saraMirror === 'off') ctx.emit(`input_boolean.turn_${saraMirror}`, {}, { entity_id: 'input_boolean.ls_sara_mode_mirror' }, { revision, generation });
  const parsedStaleKeys = staleKeys();
  if (parsedStaleKeys.length) ctx.fire('ls_override', { op: 'clear', keys: parsedStaleKeys, via: 'rule_next_block', expected_revision: revision });
  return { completed: completed && revision === revisionOf(ctx) && generation === ctx.attr(runtime, 'generation'), published_at: emission.published_at };
}

/** Coalesce pending room versions, preserving unrelated rooms and retrying incomplete output. */
export function render(ctx: ScriptContext): JsonValue {
  const started = timestamp(ctx.now), revision = revisionOf(ctx);
  const received = ctx.attr(overrideSensor, 'received_at') ?? null, request = ctx.attr(overrideSensor, 'last_request') ?? null;
  const pending = object(ctx.attr(overrideSensor, 'pending_rooms')), handled = object(ctx.attr(runtime, 'handled_rooms'));
  const fullVersion = optionalRevisionAttribute(ctx.attr(overrideSensor, 'full_version'), 'ls_render.full_version');
  const full = fullVersion !== undefined && fullVersion !== ctx.attr(runtime, 'handled_full');
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
  const emission = ctx.call('ls_dispatch', { plan, lights });
  // `requireObject`, `requireBoolean` and `?? []` below are gone: `null` is in
  // the type, and `dispatch` builds both fields whenever it returns an object.
  if (emission === null || !emission.completed || revision !== revisionOf(ctx)) return null;
  const generation = ctx.attr(runtime, 'generation') ?? null;
  ctx.emit('variable.update_sensor', { value: ctx.now, replace_attributes: false, attributes: {
    handled_rooms: pending,
    handled_full: fullVersion === undefined ? ctx.attr(runtime, 'handled_full') ?? null : fullVersion,
    last_latency: { request_id: request, received_at: received, started_at: started, planned_at: plannedAt, published_at: emission.published_at, completed_at: timestamp(ctx.now), rooms, full },
  } }, { entity_id: runtime }, { revision, generation, requiresOutputSuccess: true });
  return null;
}
export const dispatchHandlers: ScriptHandlers = {
  // Captured `plan` is raw at 20 sites. Its revision/resolved/base/plan_order,
  // assignments/output_targets/remote_rooms/targets/switches/mirror/stale_keys
  // fields are all raw (9/5/1/3/3/2/3/5/2/3/2 sites), so they use strict
  // object/number/array parsers. Nested area/option/entity/sara_mirror are raw
  // (1/1/1/2); option/entity are required strings while comparison-only area
  // and sara_mirror retain their raw values. Boolean-context fields is_room,
  // send, remote, on use Python truthiness (1/1/2/5 raw sites). `lights` has
  // four raw uses and one `| default(none)`, preserved by its domain parser.
  ls_dispatch: typed('ls_dispatch', {
    parse: args => {
      const plan = requireObject(args, 'plan', 'ls_dispatch');
      return {
        revision: requireString(plan, 'revision', 'ls_dispatch.plan'),
        planOrder: requireNumber(plan, 'plan_order', 'ls_dispatch.plan'),
        // Keep captured early-return evaluation order for the remaining fields.
        details: () => parseDispatchDetails(plan, args.lights),
      };
    },
    run: dispatch,
  }),
  ls_render: ctx => render(ctx),
};
