import { jinjaTruthy } from '../../runtime/parse.ts';
import type { Verbatim } from '../../runtime/verbatim.ts';
import type { Effect, HouseView } from '../../runtime/effects.ts';
import type { BulbId, RoomId } from '../../domain/types/ids.ts';
import { hasValue } from './schedule.ts';
import { bulbEffect, runningIn } from './transport.ts';
import { timestamp } from '../../parse/accessors.ts';
import type { OpaqueMap, StoredFact, StoredValue } from '../../parse/overrides.ts';
import { attributeFact, attributeMapping, overridesRevision } from '../../parse/sensors.ts';
import { mappingAttribute } from '../../parse/planning.ts';
import type { StoredChannels } from '../../parse/transport.ts';
import { areaOf, dueFullVersion, roomCacheGradients, roomKeys } from '../../parse/dispatch-render.ts';
import type { DispatchRuntime, FullPlan, RoomPlanView } from '../../parse/dispatch-render.ts';
import type { LampOrRoom } from '../../domain/types/lighting-state.ts';

const runtime = 'sensor.ls_effects_runtime';
const overrideSensor = 'sensor.ls_overrides';

/** One resolved target, as `ls_dispatch` reads it before handing it on. */
export interface DispatchTarget {
  /** The target as resolved, forwarded and stored unchanged. */
  document: Verbatim;
  lampOrRoom: LampOrRoom;
  /** Compared by identity with the remote rooms. */
  area: StoredFact;
  on: boolean;
  channels: StoredChannels;
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
    return effect === undefined ? [] : [bulbEffect(effect).start];
  });
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

/**
 * The lamps to send: on, not rooms, inside the output targets, sendable
 * (requested, in a remote room, or the baseline sends it), and not already
 * showing what the target needs. `applied` is the only record of what a lamp
 * shows, a bulb effect included: a lamp sent here gets its start after its
 * light ({@link bulbStartCommands}), and a lamp not sent is not touched, so a
 * steady candle is never restarted.
 */
export function ordinaryTargets(view: HouseView, details: DispatchDetails, previous: DispatchRuntime): OpaqueMap {
  const { targetViews, requested, outputTargets, remoteRooms } = details;
  const ordinary: OpaqueMap = {};
  for (const target of Object.values(targetViews)) {
    if (target.lampOrRoom.kind === 'room') continue;
    const lamp = target.lampOrRoom.lamp;
    if (outputTargets.length > 0 && !outputTargets.includes(lamp)) continue;
    if (view.get(lamp) !== 'on') continue;
    if (!(requested.includes(lamp) || remoteRooms.includes(target.area ?? null) || details.baselineSend(lamp))) continue;
    if (requested.includes(lamp) || (previous.hadEffect(lamp) && !details.assigned(lamp))
      || !previous.applied(lamp, target.document)) ordinary[lamp] = target.document;
  }
  return ordinary;
}
/**
 * `ls_dispatch`'s result. `null` is one of its real answers -- every
 * revision-moved and stale-plan guard returns it -- so it is in the type rather
 * than hidden behind a lenient read at the caller.
 */
export type DispatchOutcome = { completed: boolean; published_at: number[] } | null;
/**
 * How far a dispatch caps its lamps' transitions: a remote press caps them
 * everywhere, a render for rooms a remote changed caps them in those rooms,
 * anything else not at all.
 */
export type TransitionCap = { kind: 'none' } | { kind: 'everywhere' } | { kind: 'rooms'; rooms: StoredValue[] };

type StartCommand = { topic: string; payload: { effect: string }; members: BulbId[]; owners: string[]; group: null };
export interface DispatchRequest {
  revision: string;
  planOrder: number;
  details: () => DispatchDetails;
}

/**
 * The plan `ls_render` builds from the room plans it merged. Every field is
 * constructed here; the stored and planned documents inside it are carried.
 */
export type RoomsPlan = {
  base: OpaqueMap;
  resolved: { targets: OpaqueMap; assignments: OpaqueMap };
  switches: OpaqueMap;
  mirror: Verbatim[];
  stale_keys: string[];
  revision: string;
  plan_order: number;
  remote: false;
  remote_rooms: RoomId[];
  sara_mirror: StoredValue;
  output_targets: string[];
};

/** What `ls_render` reads first: the clock, the bare revision, and what is pending. */
export interface RenderOpening {
  started: number;
  revision: string;
  received: StoredValue;
  request: StoredValue;
  pending: OpaqueMap;
  /** The full render's version, when one is due (see `dueFullVersion`). */
  fullVersion: StoredValue | undefined;
  /** A full render is pending that the runtime has not handled. */
  full: boolean;
  /** The rooms whose pending version the runtime has not handled. */
  rooms: RoomId[];
}
/** The opening reads, or `undefined` when nothing is pending. */
export function renderOpening(view: HouseView): RenderOpening | undefined {
  const started = timestamp(view.now), revision = overridesRevision(view, 'ls_render');
  const received = attributeFact(view, overrideSensor, 'received_at') ?? null, request = attributeFact(view, overrideSensor, 'last_request') ?? null;
  const pending = attributeMapping(view, overrideSensor, 'pending_rooms'), handled = attributeMapping(view, runtime, 'handled_rooms');
  const fullVersion = dueFullVersion(view);
  const full = fullVersion !== undefined;
  const rooms = roomKeys(pending).filter(room => pending[room] !== handled[room]);
  if (!full && rooms.length === 0) return undefined;
  return { started, revision, received, request, pending, fullVersion, full, rooms };
}

/** The room plans merged so far over the runtime's stored targets and assignments. */
export type MergedRooms = {
  targets: OpaqueMap;
  assignments: OpaqueMap;
  bases: OpaqueMap;
  switches: OpaqueMap;
  mirrors: Verbatim[];
  stale: string[];
  saraMirror: StoredFact;
  /** Each planned room's cache update, by room. */
  updates: Record<RoomId, Verbatim>;
};

/** The runtime's stored targets and assignments, read before any room is planned. */
export function roomsStart(view: HouseView): MergedRooms {
  return { targets: attributeMapping(view, runtime, 'targets'), assignments: attributeMapping(view, runtime, 'assignments'),
    bases: {}, switches: {}, mirrors: [], stale: [], saraMirror: undefined, updates: {} };
}

/** One room's plan over the merge: its stored targets replaced in place, the rest accumulated. */
export function mergeRoomPlan(merged: MergedRooms, room: RoomId, planned: RoomPlanView): MergedRooms {
  const elsewhere = (map: OpaqueMap) => Object.fromEntries(Object.entries(map).filter(([, t]) => areaOf(t) !== room));
  return {
    targets: { ...elsewhere(merged.targets), ...planned.targets },
    assignments: { ...elsewhere(merged.assignments), ...planned.assignments },
    bases: { ...merged.bases, ...planned.base },
    switches: { ...merged.switches, ...planned.switches },
    mirrors: [...merged.mirrors, ...planned.mirror],
    stale: [...new Set([...merged.stale, ...planned.staleKeys])],
    saraMirror: planned.saraMirror,
    updates: planned.cacheUpdate === undefined ? merged.updates : { ...merged.updates, [room]: planned.cacheUpdate },
  };
}


export function transitionCap(details: DispatchDetails): TransitionCap {
  if (details.remote) return { kind: 'everywhere' };
  return details.remoteRooms.length > 0 ? { kind: 'rooms', rooms: details.remoteRooms } : { kind: 'none' };
}

/**
 * Start the effects the bulbs run themselves on lamps that were just sent
 * their light. A second emission, after the first, so every bulb receives its
 * colour and level before the start: the candle flickers under the level the
 * lamp is at and keeps whatever colour it shows. Same members and topics the
 * frame plan addressed, through the same guarded emitter.
 */
export function bulbStartCommands(view: HouseView, details: DispatchDetails, sent: OpaqueMap): StartCommand[] {
  const lamps = Object.entries(details.targetViews).filter(([lamp]) => Object.hasOwn(sent, lamp));
  return lamps.map(([lamp, target]) => ({ lamp, starts: bulbStarts(target) }))
    .filter(({ lamp, starts }) => starts.length > 0 && view.get(lamp) === 'on').flatMap(({ lamp, starts }) =>
      startableMembers(view, lamp).flatMap(({ member, topic }) =>
        starts.map(effect => ({ topic, payload: { effect }, members: [member], owners: [lamp], group: null }))));
}
/** The members a start can reach now: on, with a topic. */
function startableMembers(view: HouseView, lamp: string): Array<{ member: BulbId; topic: string }> {
  return membersOf(view, lamp).flatMap(member => {
    const topic = view.catalog.topics[member];
    return view.get(member) === 'on' && topic !== undefined ? [{ member, topic }] : [];
  });
}

/** A lamp's catalog members; a lamp the catalog does not list has none. */
function membersOf(view: HouseView, lamp: string): BulbId[] {
  // The lamp is a lighting-state entry key, plain text until those lists are parsed; look it up as text.
  const byText: Readonly<Record<string, BulbId[] | undefined>> = view.catalog.members;
  const members = byText[lamp];
  return members === undefined ? [] : members;
}

/** Captured: `full_reason or 'config'`, Jinja's `or` (`[]`/`{}` fall back, NaN does not). */
export function fullReason(view: HouseView): StoredValue {
  const storedReason = attributeFact(view, overrideSensor, 'full_reason');
  return storedReason !== undefined && jinjaTruthy(storedReason) ? storedReason : 'config';
}

/** Captured: `full_lights or []`, Jinja's `or`. */
export function fullLights(view: HouseView): StoredValue | StoredValue[] {
  const storedLights = attributeFact(view, overrideSensor, 'full_lights');
  return storedLights !== undefined && jinjaTruthy(storedLights) ? storedLights : [];
}

/** Each baseline room's cache whose gradients the full plan changed, with the new gradients. */
export function gradientUpdates(view: HouseView, planned: FullPlan): Record<RoomId, Verbatim> {
  const updates: Record<RoomId, Verbatim> = {};
  for (const room of planned.areas) {
    const old = roomCacheGradients(view.attr(`sensor.ls_cache_${room}`, 'cache'));
    const values = planned.gradientsIn(room);
    if (!old.holds(values)) updates[room] = old.withGradients(values);
  }
  return updates;
}

/** `ls_room_plan`'s arguments for one room, read as the previous room's plan left the house. */
export function roomPlanRequest(view: HouseView, room: RoomId): { room: RoomId; overrides: Verbatim; cache: Verbatim; reason: 'remote' } {
  return { room, overrides: mappingAttribute(view.attr(overrideSensor, 'overrides')),
    cache: mappingAttribute(view.attr(`sensor.ls_cache_${room}`, 'cache')), reason: 'remote' };
}

/** The plan `ls_dispatch` gets from merged room plans. */
export function roomsPlan(merged: MergedRooms, opening: Pick<RenderOpening, 'revision' | 'started' | 'rooms'>): RoomsPlan {
  return { base: merged.bases, resolved: { targets: merged.targets, assignments: merged.assignments }, switches: merged.switches,
    mirror: merged.mirrors, stale_keys: merged.stale, revision: opening.revision, plan_order: opening.started, remote: false,
    remote_rooms: opening.rooms, sara_mirror: merged.saraMirror ?? null, output_targets: Object.keys(merged.bases) };
}

/** A room cache write, when the room's cache sensor has a value. */
export function cacheWrite(view: HouseView, room: RoomId, cache: Verbatim): Effect | undefined {
  const entity = `sensor.ls_cache_${room}`;
  if (!hasValue(view, entity)) return undefined;
  return { kind: 'service', service: 'variable.update_sensor', data: { value: view.now, attributes: { cache }, replace_attributes: false },
    target: { entity_id: entity } };
}

/**
 * The runtime's acknowledgement of a complete dispatch under an unchanged
 * revision: the handled versions and the latency record, guarded on output
 * success. `undefined` for a stale plan, incomplete output or a moved revision.
 */
export function renderAck(view: HouseView, opening: RenderOpening, plannedAt: number, emission: DispatchOutcome): Effect | undefined {
  // `requireObject`, `requireBoolean` and `?? []` are gone: `null` is in the
  // type, and `dispatch` builds both fields whenever it returns an object.
  if (emission === null || !emission.completed || opening.revision !== overridesRevision(view, 'ls_render')) return undefined;
  const { revision, fullVersion } = opening;
  const generation = attributeFact(view, runtime, 'generation') ?? null;
  return { kind: 'service', service: 'variable.update_sensor', data: { value: view.now, replace_attributes: false, attributes: {
    handled_rooms: opening.pending,
    handled_full: fullVersion === undefined ? attributeFact(view, runtime, 'handled_full') ?? null : fullVersion,
    last_latency: { request_id: opening.request, received_at: opening.received, started_at: opening.started, planned_at: plannedAt,
      published_at: emission.published_at, completed_at: timestamp(view.now), rooms: opening.rooms, full: opening.full },
  } }, target: { entity_id: runtime }, guard: { revision, generation, requiresOutputSuccess: true } };
}
