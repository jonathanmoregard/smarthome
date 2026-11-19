import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { typed } from '../runtime/entrypoints.ts';
import { jinjaTruthy } from '../runtime/parse.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { hasValue } from './schedule.ts';
import { runningIn } from './transport.ts';
import type { AssignResult, EmitResult } from './transport.ts';
import { timestamp } from '../parse/accessors.ts';
import type { OpaqueMap, StoredFact, StoredValue } from '../parse/overrides.ts';
import { attributeFact, attributeMapping, overridesRevision } from '../parse/sensors.ts';
import { mappingAttribute } from '../parse/planning.ts';
import type { StoredChannels } from '../parse/transport.ts';
import {
  areaOf, dispatchPlanOrder, dispatchRuntime, fullPlan, optionalRevisionAttribute, parseDispatchArgs, roomCacheGradients, roomPlanView,
} from '../parse/dispatch-render.ts';

const runtime = 'sensor.ls_effects_runtime';
const overrideSensor = 'sensor.ls_overrides';

/** One resolved target, as `ls_dispatch` reads it before handing it on. */
export interface DispatchTarget {
  /** The target as resolved, forwarded and stored unchanged. */
  document: Verbatim;
  isRoom: boolean;
  /** Compared by identity with the remote rooms. */
  area: StoredFact;
  on: boolean;
  channels: StoredChannels;
}
export interface DispatchDetails {
  /** The resolved targets, forwarded to `effects_assign` unread. */
  targets: Verbatim;
  targetViews: Record<string, DispatchTarget>;
  /** The resolved assignments, forwarded to `effects_assign` unread. */
  assignments: Verbatim;
  assigned(lamp: string): boolean;
  /** The lamp's baseline `send`; raises on a present non-mapping baseline entry. */
  baselineSend(lamp: string): boolean;
  requested: StoredValue[];
  outputTargets: StoredValue[];
  remoteRooms: StoredValue[];
  remote: boolean;
  switches: () => Array<() => { entity: string; on: boolean }>;
  mirrors: () => Array<() => { option: string; entity: string }>;
  staleKeys: () => StoredValue[];
  saraMirror: StoredFact;
}
export interface DispatchArgs {
  revision: string;
  planOrder: number;
  details: () => DispatchDetails;
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
  if (revision !== overridesRevision(ctx, 'ls_dispatch') || args.planOrder < dispatchPlanOrder(ctx)) return null;
  const details = args.details();
  const { targets, targetViews, assignments, requested, outputTargets, remoteRooms,
    remote, switches, mirrors, staleKeys, saraMirror } = details;
  const catalog = ctx.run('effects_catalog');
  const previous = dispatchRuntime(ctx);
  const ordinary: OpaqueMap = {};
  for (const [lamp, target] of Object.entries(targetViews)) {
    if (target.isRoom || (outputTargets.length && !outputTargets.includes(lamp))) continue;
    if (ctx.get(lamp) !== 'on') continue;
    if (!(requested.includes(lamp) || remoteRooms.includes(target.area ?? null) || details.baselineSend(lamp))) continue;
    if (requested.includes(lamp) || (previous.hadEffect(lamp) && !details.assigned(lamp)) || !previous.applied(lamp, target.document)
      || !sameStarts(recordedStarts(previous.bulbEffects, lamp), bulbStarts(target))) ordinary[lamp] = target.document;
  }
  const assigned = ctx.call('effects_assign', { targets, assignments, revision, invalidate: Object.keys(ordinary), plan_order: args.planOrder });
  const batch = ctx.call('effects_frame_plan', { targets: ordinary, catalog, timestamp: timestamp(ctx.now),
    transition_cap: remote || remoteRooms.length ? 0.5 : null, transition_rooms: remote ? null : remoteRooms });
  // `object(...)` and `?? []` are gone: `planGroups` builds all five fields on
  // every path, so both could only fire for a stub, and `decodeGroupPlan` is
  // where that case is handled now -- strictly, rather than as an empty batch.
  const emission = ctx.call('effects_emit', { commands: batch.commands, revision, generation: assigned.generation });
  const started = startBulbEffects(ctx, Object.keys(ordinary).map(lamp => [lamp, bulbStarts(targetViews[lamp]!)]), revision, assigned.generation);
  // `requireBoolean(emission.completed)`, `?? null` on the generation and
  // `?? []` on published_at are all gone: `emitCommands` builds both fields
  // every time and `assignEffects` already normalises an absent generation to
  // null, so none of the three could fire for the real handlers.
  const completed = emission.completed && started.completed;
  const generation = assigned.generation;
  if (revision !== overridesRevision(ctx, 'ls_dispatch') || generation !== ctx.attr(runtime, 'generation')) return null;
  if (Object.keys(ordinary).length && completed) {
    const bulbEffects = recordStarts(previous.bulbEffects, Object.keys(ordinary).map(lamp => [lamp, bulbStarts(targetViews[lamp]!)]));
    ctx.emit('variable.update_sensor', { value: generation, replace_attributes: false,
      attributes: { applied: { ...attributeMapping(ctx, runtime, 'applied'), ...ordinary },
        ...(bulbEffects === undefined ? {} : { bulb_effects: bulbEffects }) } }, { entity_id: runtime },
    { revision, generation, requiresOutputSuccess: true });
  }
  for (const parseSwitch of switches()) {
    const { entity, on } = parseSwitch();
    const state = on ? 'on' : 'off';
    if (revision === overridesRevision(ctx, 'ls_dispatch') && ctx.get(entity) !== state) ctx.emit(`homeassistant.turn_${state}`, {}, { entity_id: entity }, { revision, generation });
  }
  if (revision !== overridesRevision(ctx, 'ls_dispatch')) return null;
  for (const parseMirror of mirrors()) {
    const mirror = parseMirror();
    ctx.emit('input_select.select_option', { option: mirror.option }, { entity_id: mirror.entity }, { revision, generation });
  }
  if (saraMirror === 'on' || saraMirror === 'off') ctx.emit(`input_boolean.turn_${saraMirror}`, {}, { entity_id: 'input_boolean.ls_sara_mode_mirror' }, { revision, generation });
  const parsedStaleKeys = staleKeys();
  if (parsedStaleKeys.length) ctx.fire('ls_override', { op: 'clear', keys: parsedStaleKeys, via: 'rule_next_block', expected_revision: revision });
  return { completed: completed && revision === overridesRevision(ctx, 'ls_dispatch') && generation === ctx.attr(runtime, 'generation'), published_at: [...emission.published_at, ...started.published_at] };
}

/**
 * Start the effects the bulbs run themselves on lamps that were just sent
 * their light. A second emission, after the first, so every bulb receives its
 * colour and level before the start: the candle flickers under the level the
 * lamp is at and keeps whatever colour it shows. Same members and topics the
 * frame plan addressed, through the same guarded emitter.
 */
function startBulbEffects(ctx: ScriptContext, lamps: Array<[string, string[]]>, revision: string, generation: AssignResult['generation']): EmitResult {
  const commands = lamps.filter(([lamp, starts]) => starts.length > 0 && ctx.get(lamp) === 'on').flatMap(([lamp, starts]) =>
    (ctx.catalog.members[lamp] ?? []).flatMap(member => {
      const topic = ctx.catalog.topics[member];
      return ctx.get(member) === 'on' && topic !== undefined
        ? starts.map(effect => ({ topic, payload: { effect }, members: [member], owners: [lamp], group: null }))
        : [];
    }));
  if (commands.length === 0) return { published_at: [], completed: true };
  return ctx.call('effects_emit', { commands, revision, generation });
}

/**
 * Is a lamp's bulb running what its target needs? `applied` cannot answer
 * that for a bulb effect: the original engine wrote `applied` too, after
 * streaming software candle frames, so at cutover a Candle lamp reads as
 * applied while its bulbs run nothing. Only the port's own record of the
 * starts it sent (`bulb_effects`) says the firmware effect is running; a lamp
 * whose target needs a start that record lacks is sent its light and start.
 * A lamp whose record matches is left alone, so an unchanged candle is never
 * restarted. A lamp with no bulb effect and no record compares `[]` with `[]`.
 */
function recordedStarts(recorded: Record<string, string[]>, lamp: string): string[] {
  return Object.hasOwn(recorded, lamp) ? recorded[lamp]! : [];
}
function sameStarts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((start, index) => start === b[index]);
}
/**
 * `bulb_effects` after a completed dispatch sent these lamps their light (and
 * starts): a lamp with starts records them, a lamp with none drops its entry.
 * `undefined` when nothing changed, so a dispatch that touches no bulb effect
 * writes exactly what it wrote before the record existed.
 */
function recordStarts(recorded: Record<string, string[]>, sent: Array<[string, string[]]>): Record<string, string[]> | undefined {
  const next = { ...recorded };
  let changed = false;
  for (const [lamp, starts] of sent) {
    if (starts.length > 0) {
      if (!sameStarts(recordedStarts(next, lamp), starts)) { next[lamp] = starts; changed = true; }
    } else if (Object.hasOwn(next, lamp)) { delete next[lamp]; changed = true; }
  }
  return changed ? next : undefined;
}

/**
 * The starts an on lamp's bulbs need, brightness channel first. Read without
 * raising: `effects_frame_plan` parses this target strictly, and raises there,
 * before anything here acts on the answer.
 */
function bulbStarts(target: DispatchTarget): string[] {
  if (!target.on) return [];
  return (['brightness', 'color'] as const).flatMap(channel => {
    const effect = runningIn(channel, target.channels);
    return effect === undefined ? [] : [effect.start];
  });
}

/**
 * The plan `ls_render` builds from the room plans it merged. Every field is
 * constructed here; the stored and planned documents inside it are carried.
 */
type RoomsPlan = {
  base: OpaqueMap;
  resolved: { targets: OpaqueMap; assignments: OpaqueMap };
  switches: OpaqueMap;
  mirror: Verbatim[];
  stale_keys: string[];
  revision: string;
  plan_order: number;
  remote: false;
  remote_rooms: string[];
  sara_mirror: StoredValue;
  output_targets: string[];
};

/** Coalesce pending room versions, preserving unrelated rooms and retrying incomplete output. */
export function render(ctx: ScriptContext): null {
  const started = timestamp(ctx.now), revision = overridesRevision(ctx, 'ls_render');
  const received = attributeFact(ctx, overrideSensor, 'received_at') ?? null, request = attributeFact(ctx, overrideSensor, 'last_request') ?? null;
  const pending = attributeMapping(ctx, overrideSensor, 'pending_rooms'), handled = attributeMapping(ctx, runtime, 'handled_rooms');
  const fullVersion = optionalRevisionAttribute(ctx.attr(overrideSensor, 'full_version'), 'ls_render.full_version');
  const full = fullVersion !== undefined && fullVersion !== attributeFact(ctx, runtime, 'handled_full');
  const rooms = Object.keys(pending).filter(room => pending[room] !== handled[room]);
  if (!full && !rooms.length) return null;
  let plan: Verbatim | RoomsPlan, lights: StoredValue | StoredValue[] = [];
  const updates: OpaqueMap = {};
  if (full) {
    // Captured: `full_reason or 'config'` and `full_lights or []`, Jinja's `or`
    // (`[]`/`{}` fall back, NaN does not).
    const storedReason = attributeFact(ctx, overrideSensor, 'full_reason');
    const planned = fullPlan(ctx.run('ls_plan', { reason: storedReason !== undefined && jinjaTruthy(storedReason) ? storedReason : 'config' }), rooms);
    plan = planned.document;
    const storedLights = attributeFact(ctx, overrideSensor, 'full_lights');
    lights = storedLights !== undefined && jinjaTruthy(storedLights) ? storedLights : [];
    for (const room of planned.areas) {
      const old = roomCacheGradients(ctx.attr(`sensor.ls_cache_${room}`, 'cache'));
      const values = planned.gradientsIn(room);
      if (!old.holds(values)) updates[room] = old.withGradients(values);
    }
  } else {
    let targets = attributeMapping(ctx, runtime, 'targets'), assignments = attributeMapping(ctx, runtime, 'assignments');
    let bases: OpaqueMap = {}, switches: OpaqueMap = {}, stale: string[] = [];
    let saraMirror: StoredFact = undefined;
    const mirrors: Verbatim[] = [];
    for (const room of rooms) {
      const planned = roomPlanView(ctx.run('ls_room_plan', { room, overrides: mappingAttribute(ctx.attr(overrideSensor, 'overrides')),
        cache: mappingAttribute(ctx.attr(`sensor.ls_cache_${room}`, 'cache')), reason: 'remote' }));
      targets = { ...Object.fromEntries(Object.entries(targets).filter(([, t]) => areaOf(t) !== room)), ...planned.targets };
      assignments = { ...Object.fromEntries(Object.entries(assignments).filter(([, t]) => areaOf(t) !== room)), ...planned.assignments };
      bases = { ...bases, ...planned.base }; switches = { ...switches, ...planned.switches };
      mirrors.push(...planned.mirror); stale = [...new Set([...stale, ...planned.staleKeys])];
      if (planned.cacheUpdate !== undefined) updates[room] = planned.cacheUpdate;
      saraMirror = planned.saraMirror;
    }
    plan = { base: bases, resolved: { targets, assignments }, switches, mirror: mirrors, stale_keys: stale, revision, plan_order: started, remote: false, remote_rooms: rooms, sara_mirror: saraMirror ?? null,
      output_targets: Object.keys(bases) };
  }
  if (revision !== overridesRevision(ctx, 'ls_render')) return null;
  for (const [room, cache] of Object.entries(updates)) {
    const entity = `sensor.ls_cache_${room}`;
    if (hasValue(ctx, entity)) ctx.emit('variable.update_sensor', { value: ctx.now, attributes: { cache }, replace_attributes: false }, { entity_id: entity });
  }
  const plannedAt = timestamp(ctx.now);
  const emission = ctx.call('ls_dispatch', { plan, lights });
  // `requireObject`, `requireBoolean` and `?? []` below are gone: `null` is in
  // the type, and `dispatch` builds both fields whenever it returns an object.
  if (emission === null || !emission.completed || revision !== overridesRevision(ctx, 'ls_render')) return null;
  const generation = attributeFact(ctx, runtime, 'generation') ?? null;
  ctx.emit('variable.update_sensor', { value: ctx.now, replace_attributes: false, attributes: {
    handled_rooms: pending,
    handled_full: fullVersion === undefined ? attributeFact(ctx, runtime, 'handled_full') ?? null : fullVersion,
    last_latency: { request_id: request, received_at: received, started_at: started, planned_at: plannedAt, published_at: emission.published_at, completed_at: timestamp(ctx.now), rooms, full },
  } }, { entity_id: runtime }, { revision, generation, requiresOutputSuccess: true });
  return null;
}
export const dispatchHandlers: ScriptHandlers = {
  ls_dispatch: typed('ls_dispatch', { parse: parseDispatchArgs, run: dispatch }),
  ls_render: ctx => render(ctx),
};
