import { jinjaTruthy } from '../runtime/parse.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { Effect, HouseView, Plan } from '../runtime/effects.ts';
import type { BulbId, RoomId } from './types/ids.ts';
import type { GroupCommand, GroupedCommands } from './grouping.ts';
import { hasValue } from './schedule.ts';
import { bulbEffect, runningIn, stillCurrent } from './transport.ts';
import type { AssignedGeneration, EmitOutcome } from './transport.ts';
import { timestamp } from '../parse/accessors.ts';
import type { OpaqueMap, StoredFact, StoredValue } from '../parse/overrides.ts';
import { attributeFact, attributeMapping, overridesRevision } from '../parse/sensors.ts';
import { mappingAttribute } from '../parse/planning.ts';
import type { StoredChannels } from '../parse/transport.ts';
import { areaOf, dispatchPlanOrder, dispatchRuntime, dueFullVersion, roomCacheGradients, roomKeys } from '../parse/dispatch-render.ts';
import type { DispatchRuntime, FullPlan, RoomPlanView } from '../parse/dispatch-render.ts';
import type { LampOrRoom } from './types/lighting-state.ts';

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
/** The room selects, the Sara mirror and the stale-key clear. Each mirror parses where it is sent. */
export function* tailEffects(details: DispatchDetails, revision: string, generation: AssignedGeneration['generation']): Plan<void> {
  for (const parseMirror of details.mirrors()) {
    const mirror = parseMirror();
    yield { kind: 'service', service: 'input_select.select_option', data: { option: mirror.option }, target: { entity_id: mirror.entity },
      guard: { revision, generation } };
  }
  const saraMirror = details.saraMirror;
  if (saraMirror === 'on' || saraMirror === 'off') {
    yield { kind: 'service', service: `input_boolean.turn_${saraMirror}`, data: {}, target: { entity_id: 'input_boolean.ls_sara_mode_mirror' },
      guard: { revision, generation } };
  }
  const staleKeys = details.staleKeys();
  if (staleKeys.length > 0) yield { kind: 'event', event: 'ls_override', data: { op: 'clear', keys: staleKeys, via: 'rule_next_block',
    expected_revision: revision } };
}
/**
 * `ls_dispatch`'s result. `null` is one of its real answers -- every
 * revision-moved and stale-plan guard returns it -- so it is in the type rather
 * than hidden behind a lenient read at the caller.
 */
export type DispatchOutcome = { completed: boolean; published_at: number[] } | null;
/** What a dispatch carries once its plan is accepted. */
type Accepted = { revision: string; planOrder: number; details: DispatchDetails };
/** ...once the catalog is fetched and the lamps to send are chosen against the runtime as it stood. */
type Chosen = Accepted & { catalog: Verbatim; previous: DispatchRuntime; ordinary: OpaqueMap };

/** Each sent lamp with the starts its bulbs need. */
function sentStarts(run: Chosen): Array<[string, string[]]> {
  return Object.keys(run.ordinary).map(lamp => [lamp, bulbStarts(run.details.targetViews[lamp]!)]);
}
/** ...once the assignment answered its generation. */
type Assigned = Chosen & { generation: AssignedGeneration['generation'] };
/** ...once the light went out. */
type Lit = Assigned & { emission: EmitOutcome };
/** ...once every publish is done: whether all completed, and when each went out. */
type Settled = Assigned & { completed: boolean; publishedAt: number[] };
/**
 * `ls_dispatch` as a state machine, one phase per answer it waits for. The
 * order is the captured script's: revision and plan-order stop, details,
 * catalog, the lamps to send, `effects_assign`, `effects_frame_plan`,
 * `effects_emit` (the light), `effects_emit` again (the bulb-effect starts),
 * then the guarded runtime record, the switches one by one, and the tail.
 */
export type DispatchModel =
  | { tag: 'opening'; args: DispatchRequest }
  | { tag: 'cataloguing'; run: Accepted }
  | { tag: 'assigning'; run: Chosen }
  | { tag: 'framing'; run: Assigned }
  | { tag: 'emitting'; run: Assigned }
  | { tag: 'starting'; run: Lit }
  /** The switches from `next` on are still to be checked. */
  | { tag: 'switching'; run: Settled; next: number }
  | { tag: 'finishing'; run: Settled }
  | { tag: 'done'; answer: DispatchOutcome };

/**
 * Every message carries the house as it stands after the command that
 * answered: a step's reads are made on it, and never cross the commands that
 * step returns.
 */
export type DispatchMsg =
  | { tag: 'start'; house: HouseView }
  | { tag: 'catalog'; catalog: Verbatim; house: HouseView }
  | { tag: 'assigned'; result: AssignedGeneration; house: HouseView }
  | { tag: 'framed'; batch: GroupedCommands; house: HouseView }
  | { tag: 'emitted'; result: EmitOutcome; house: HouseView }
  | { tag: 'performed'; house: HouseView };
type StartCommand = { topic: string; payload: { effect: string }; members: BulbId[]; owners: string[]; group: null };

/**
 * Start the effects the bulbs run themselves on lamps that were just sent
 * their light. A second emission, after the first, so every bulb receives its
 * colour and level before the start: the candle flickers under the level the
 * lamp is at and keeps whatever colour it shows. Same members and topics the
 * frame plan addressed, through the same guarded emitter.
 */
export function bulbStartCommands(view: HouseView, lamps: Array<[string, string[]]>): StartCommand[] {
  return lamps.filter(([lamp, starts]) => starts.length > 0 && view.get(lamp) === 'on').flatMap(([lamp, starts]) =>
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

export type DispatchCmd =
  /** Run `effects_catalog`; answers `catalog`. */
  | { tag: 'catalog' }
  /** Call `effects_assign`; answers `assigned`. */
  | { tag: 'assign'; args: { targets: Verbatim; assignments: Verbatim; revision: string; invalidate: string[]; plan_order: number } }
  /** Call `effects_frame_plan`; answers `framed`. */
  | { tag: 'frame'; args: {
    targets: OpaqueMap; catalog: Verbatim; timestamp: number; transition_cap: number | null; transition_rooms: StoredValue[] | null;
  } }
  /** Call `effects_emit`; answers `emitted`. */
  | { tag: 'emit'; args: { commands: GroupCommand[] | StartCommand[]; revision: string; generation: AssignedGeneration['generation'] } }
  /** Perform one effect; answers `performed`. */
  | { tag: 'effect'; effect: Effect }
  /** Perform a lazy plan, whose raising reads sit between its effects; answers `performed`. */
  | { tag: 'plan'; plan: Plan<void> };

type Transition = [DispatchModel, DispatchCmd[]];

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

export function dispatchInit(args: DispatchRequest): DispatchModel {
  return { tag: 'opening', args };
}


export function dispatchUpdate(model: DispatchModel, msg: DispatchMsg): Transition {
  switch (model.tag) {
    case 'opening': {
      if (msg.tag !== 'start') return throwUnexpected(model, msg);
      const { args } = model, revision = args.revision, house = msg.house;
      if (revision !== overridesRevision(house, 'ls_dispatch') || args.planOrder < dispatchPlanOrder(house)) return done(null);
      return [{ tag: 'cataloguing', run: { revision, planOrder: args.planOrder, details: args.details() } }, [{ tag: 'catalog' }]];
    }
    case 'cataloguing': {
      if (msg.tag !== 'catalog') return throwUnexpected(model, msg);
      const { revision, planOrder, details } = model.run;
      const previous = dispatchRuntime(msg.house);
      const ordinary = ordinaryTargets(msg.house, details, previous);
      return [{ tag: 'assigning', run: { ...model.run, catalog: msg.catalog, previous, ordinary } }, [{ tag: 'assign', args: {
        targets: details.targets, assignments: details.assignments, revision, invalidate: Object.keys(ordinary), plan_order: planOrder,
      } }]];
    }
    case 'assigning': {
      if (msg.tag !== 'assigned') return throwUnexpected(model, msg);
      const run = { ...model.run, generation: msg.result.generation };
      const { remote, remoteRooms } = run.details;
      return [{ tag: 'framing', run }, [{ tag: 'frame', args: {
        targets: run.ordinary, catalog: run.catalog, timestamp: timestamp(msg.house.now),
        transition_cap: remote || remoteRooms.length > 0 ? 0.5 : null, transition_rooms: remote ? null : remoteRooms,
      } }]];
    }
    case 'framing': {
      if (msg.tag !== 'framed') return throwUnexpected(model, msg);
      const run = model.run;
      return [{ tag: 'emitting', run }, [{ tag: 'emit', args: { commands: msg.batch.commands, revision: run.revision,
        generation: run.generation } }]];
    }
    case 'emitting': {
      if (msg.tag !== 'emitted') return throwUnexpected(model, msg);
      const commands = bulbStartCommands(msg.house, sentStarts(model.run));
      const run: Lit = { ...model.run, emission: msg.result };
      if (commands.length === 0) return settle(msg.house, run, { published_at: [], completed: true });
      return [{ tag: 'starting', run }, [{ tag: 'emit', args: { commands, revision: run.revision, generation: run.generation } }]];
    }
    case 'starting': {
      if (msg.tag !== 'emitted') return throwUnexpected(model, msg);
      return settle(msg.house, model.run, msg.result);
    }
    case 'switching': {
      if (msg.tag !== 'performed') return throwUnexpected(model, msg);
      return switching(msg.house, model.run, model.next);
    }
    case 'finishing': {
      if (msg.tag !== 'performed') return throwUnexpected(model, msg);
      const { revision, generation, completed, publishedAt } = model.run;
      return done({ completed: completed && stillCurrent(msg.house, 'ls_dispatch', revision, generation), published_at: publishedAt });
    }
    case 'done':
      return throwUnexpected(model, msg);
    default: {
      const unknown: never = model;
      throw new Error(`Unhandled ls_dispatch phase ${JSON.stringify(unknown)}`);
    }
  }
}

function throwUnexpected(model: DispatchModel, msg: DispatchMsg): never {
  throw new Error(`ls_dispatch: phase ${model.tag} cannot take ${msg.tag}`);
}

function done(answer: DispatchOutcome): Transition {
  return [{ tag: 'done', answer }, []];
}

/**
 * Every publish is done. Stop if the revision or the generation moved;
 * otherwise record a complete output's applied lights under the generation,
 * then go on to the switches. An incomplete output records nothing, so
 * `applied` keeps what `effects_assign` left: the lamps it sent are not in it,
 * and the next dispatch sends them again, bulb-effect starts included.
 *
 * A member that was off (or unavailable) when its lamp was sent got nothing,
 * but its lamp is recorded: a lamp whose member is permanently dead would
 * otherwise never be recorded, and every sendable dispatch -- each tick of a
 * fade, every non-tick render -- would send the lamp again and restart the
 * candle on its live members. Known gap: such a member, back on while its lamp
 * stays on, waits for the lamp's next send (a target change, a request, or the
 * lamp itself coming back on, which `lamp_on` requests).
 */
function settle(house: HouseView, run: Lit, started: EmitOutcome): Transition {
  const { revision, generation, ordinary } = run;
  // `requireBoolean(emission.completed)`, `?? null` on the generation and
  // `?? []` on published_at are all gone: `emitCommands` builds both fields
  // every time and `assignEffects` already normalises an absent generation to
  // null, so none of the three could fire for the real handlers.
  const completed = run.emission.completed && started.completed;
  if (!stillCurrent(house, 'ls_dispatch', revision, generation)) return done(null);
  const settled: Settled = { ...run, completed, publishedAt: [...run.emission.published_at, ...started.published_at] };
  if (Object.keys(ordinary).length === 0 || !completed) return switching(house, settled, 0);
  return [{ tag: 'switching', run: settled, next: 0 }, [{ tag: 'effect', effect: {
    kind: 'service', service: 'variable.update_sensor',
    data: { value: generation, replace_attributes: false,
      attributes: { applied: { ...attributeMapping(house, runtime, 'applied'), ...ordinary } } },
    target: { entity_id: runtime }, guard: { revision, generation, requiresOutputSuccess: true },
  } }]];
}

/**
 * The switches from `next` on: each is parsed, then switched when the
 * revision still holds and its state differs. One switch per step, so the
 * house is re-read after each switch. Then, if the revision still holds, the tail.
 */
function switching(house: HouseView, run: Settled, next: number): Transition {
  const { revision, generation, details } = run;
  const switches = details.switches();
  for (let index = next; index < switches.length; index++) {
    const { entity, on } = switches[index]!();
    const state = on ? 'on' : 'off';
    if (revision === overridesRevision(house, 'ls_dispatch') && house.get(entity) !== state) {
      return [{ tag: 'switching', run, next: index + 1 }, [{ tag: 'effect', effect: {
        kind: 'service', service: `homeassistant.turn_${state}`, data: {}, target: { entity_id: entity }, guard: { revision, generation },
      } }]];
    }
  }
  if (revision !== overridesRevision(house, 'ls_dispatch')) return done(null);
  return [{ tag: 'finishing', run }, [{ tag: 'plan', plan: tailEffects(details, revision, generation) }]];
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
