/**
 * The port's share of the house during a room-by-room rollout.
 *
 * A room is the port's -- driven -- when it is in the `--live-rooms` list and
 * its port switch `input_boolean.ls_<room>_on_port` is on. The list is what
 * this process may take; the switch is the one place a person hands a room
 * over or back. The old scripts skip a room whose switch is on, and the port
 * skips a room whose switch is off, so switching it off is the rollback.
 *
 * The port still computes the whole house. This module only answers, at the
 * edge, which of that output is the port's to send and which inputs are the
 * port's to act on.
 */
import type { JsonObject, JsonValue, ServiceCall, Snapshot } from './context.ts';
import type { Origin, OutputScope } from './host.ts';
import type { Catalog } from './catalog.ts';
import type { RoomId } from '../domain/types/ids.ts';
import type { Rooms } from '../domain/types/rooms.ts';
import type { LiveRooms } from '../parse/live-rooms.ts';
import { emptyCatalog, parseCatalog } from './catalog.ts';
import { parseRooms } from '../parse/rooms.ts';
import { toBulbId } from '../parse/ids.ts';
import { nativeSourceFor } from '../parse/automations.ts';
import { controlTopic } from '../domain/automations.ts';

/** The render bookkeeping the old scripts keep in the same sensor. */
const RUNTIME = 'sensor.ls_effects_runtime';
const ROOM_CACHE = 'sensor.ls_cache_';
const SWITCH_PREFIX = 'input_boolean.ls_', SWITCH_SUFFIX = '_on_port';
/** The services that switch a lamp, a bulb or a switch. */
const SWITCHING = new Set(['light.turn_on', 'light.turn_off', 'light.toggle', 'switch.turn_on', 'switch.turn_off', 'switch.toggle',
  'homeassistant.turn_on', 'homeassistant.turn_off', 'homeassistant.toggle']);

/** A room's port switch: on hands the room to the port, off hands it back to the old scripts. */
export function portSwitch(room: RoomId): string {
  return `${SWITCH_PREFIX}${room}${SWITCH_SUFFIX}`;
}

interface House { rooms: Rooms; catalog: Catalog; lampOfBulb: ReadonlyMap<string, string>; bulbsOfTopic: ReadonlyMap<string, string[]> }
const houses = new WeakMap<Snapshot['areas'], WeakMap<JsonObject, House>>();
const noCatalog: JsonObject = {};

/** The snapshot's rooms and catalog, parsed once per areas map and catalog document. */
function houseOf(snapshot: Snapshot): House {
  const document = snapshot.catalog === undefined ? noCatalog : snapshot.catalog;
  let byCatalog = houses.get(snapshot.areas);
  if (byCatalog === undefined) { byCatalog = new WeakMap(); houses.set(snapshot.areas, byCatalog); }
  const known = byCatalog.get(document);
  if (known !== undefined) return known;
  const catalog = snapshot.catalog === undefined ? emptyCatalog() : parseCatalog(snapshot.catalog);
  const lampOfBulb = new Map<string, string>(), bulbsOfTopic = new Map<string, string[]>();
  for (const [lamp, bulbs] of Object.entries(catalog.members)) for (const bulb of bulbs) lampOfBulb.set(bulb, lamp);
  for (const [bulb, topic] of Object.entries(catalog.topics)) {
    const sharing = bulbsOfTopic.get(topic);
    if (sharing === undefined) bulbsOfTopic.set(topic, [bulb]); else sharing.push(bulb);
  }
  const parsed = { rooms: parseRooms(snapshot.areas), catalog, lampOfBulb, bulbsOfTopic };
  byCatalog.set(document, parsed);
  return parsed;
}

/** The live rooms whose port switch is on. */
export function drivenRooms(live: LiveRooms, snapshot: Snapshot): ReadonlySet<RoomId> {
  return new Set([...live].filter(room => snapshot.state[portSwitch(room)]?.state === 'on'));
}

/** Every room a catalog lamp is in. A lamp the registry puts in no room makes no room. */
function houseRooms(house: House): Set<RoomId> {
  const rooms = new Set<RoomId>();
  for (const lamp of Object.keys(house.catalog.members)) {
    const room = house.rooms.ofId[lamp];
    if (room !== undefined) rooms.add(room);
  }
  return rooms;
}

/**
 * Refuse a live room that holds none of the house's lamps: a misspelt room
 * (`bedrom`) would be skipped by neither system's switch check and driven by
 * neither. Asked once the registry's areas are read.
 */
export function refuseUnknownRooms(live: LiveRooms, snapshot: Snapshot): void {
  const rooms = houseRooms(houseOf(snapshot)), unknown = [...live].filter(room => !rooms.has(room));
  if (unknown.length > 0) {
    throw new Error(`--live-rooms names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'holds' : 'hold'} no lamp of the house; `
      + `its rooms are ${[...rooms].sort().join(', ')}`);
  }
}

/** The port drives every room of the house, so nothing is left to the old scripts. */
function wholeHouse(live: LiveRooms, snapshot: Snapshot): boolean {
  const driven = drivenRooms(live, snapshot), rooms = houseRooms(houseOf(snapshot));
  return driven.size > 0 && [...rooms].every(room => driven.has(room));
}

function entityIds(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function targetsOf(call: ServiceCall): string[] {
  return entityIds(call.target === undefined ? call.data.entity_id : call.target.entity_id);
}
/** The call narrowed to some of its entities, named where the call named them. */
function withTargets(call: ServiceCall, entities: string[]): ServiceCall {
  return call.target === undefined ? { ...call, data: { ...call.data, entity_id: entities } }
    : { ...call, target: { ...call.target, entity_id: entities } };
}

/** A bulb is in its lamp's room; a bulb no lamp claims is in its own. */
function bulbRoom(house: House, bulb: string): RoomId | undefined {
  const lamp = house.lampOfBulb.get(bulb);
  return lamp === undefined ? house.rooms.ofId[bulb] : house.rooms.ofId[lamp];
}
/** A catalog lamp or bulb, or anything the registry puts in a room. Anything else (a dashboard proxy) is the house's. */
function placed(house: House, entity: string): boolean {
  return Object.hasOwn(house.catalog.members, entity) || house.lampOfBulb.has(entity) || house.rooms.ofId[entity] !== undefined;
}

/** The house room a room cache's name spells, if the house has it. */
function roomNamed(house: House, name: string): RoomId | undefined {
  return [...houseRooms(house)].find(room => room === name);
}

/**
 * What the port may send right now. The lamps, bulbs, switches and room
 * caches of the rooms it drives are always its own. The rest of the house's
 * state is shared with the old scripts while any room is still theirs, and
 * each part has one writer: the records an input leaves (the overlay store,
 * a remote's helpers, a saved profile) belong to the input's owner, so they
 * are the port's only for an input from rooms it still drives; the displays
 * of that state (the dashboard rows, the block selects, the Sara mirror) and
 * the render bookkeeping stay with the old scripts.
 */
interface Share { inRoom(room: RoomId | undefined): boolean; records: boolean; whole: boolean }
function shareOf(live: LiveRooms, snapshot: Snapshot, origin: Origin): Share {
  const driven = drivenRooms(live, snapshot), whole = wholeHouse(live, snapshot);
  const fromDriven = origin.kind === 'rooms' && origin.rooms.length > 0 && origin.rooms.every(room => driven.has(room));
  return { inRoom: room => room !== undefined && driven.has(room), records: whole || fromDriven, whole };
}

/** Calls this process runs itself rather than sends; what they run is scoped in turn. */
const IN_PROCESS = new Set(['script.turn_on', 'script.turn_off']);

/** A switching call's share: each lamp, bulb or switch by its room, anything unplaced as a record. */
function switchingShare(house: House, share: Share, call: ServiceCall): ServiceCall[] {
  const targets = targetsOf(call);
  if (targets.length === 0) return share.records ? [call] : [];
  const kept = targets.filter(entity => placed(house, entity) ? share.inRoom(bulbRoom(house, entity)) : share.records);
  if (kept.length === targets.length) return [call];
  return kept.length === 0 ? [] : [withTargets(call, kept)];
}

/**
 * A bulb publish's share. One that reaches only driven rooms goes out as it
 * is; a group publish over driven and old-scripts rooms becomes the same
 * payload on each driven bulb's own topic, since a group topic cannot be
 * narrowed.
 */
function publishShare(house: House, share: Share, call: ServiceCall): ServiceCall[] {
  const guard = call.guard, owners = guard?.owners;
  if (guard !== undefined && owners !== undefined && owners.length > 0) {
    const rooms = owners.map(owner => house.rooms.ofId[owner]);
    if (rooms.every(room => share.inRoom(room))) return [call];
    if (!rooms.some(room => share.inRoom(room))) return [];
    return (guard.members === undefined ? [] : guard.members).flatMap(bulb => {
      const topic = house.catalog.topics[toBulbId(bulb)], lamp = house.lampOfBulb.get(bulb);
      if (topic === undefined || !share.inRoom(bulbRoom(house, bulb))) return [];
      return [{ ...call, data: { ...call.data, topic }, guard: { ...guard, owners: [lamp === undefined ? bulb : lamp], members: [bulb] } }];
    });
  }
  const topic = call.data.topic, bulbs = typeof topic === 'string' ? house.bulbsOfTopic.get(topic) : undefined;
  // Not a bulb topic: the dashboard mirror.
  if (bulbs === undefined) return share.whole ? [call] : [];
  return bulbs.every(bulb => share.inRoom(bulbRoom(house, bulb))) ? [call] : [];
}

function sensorShare(house: House, share: Share, call: ServiceCall): ServiceCall[] {
  const targets = targetsOf(call);
  if (targets.includes(RUNTIME)) return share.whole ? [call] : [];
  const caches = targets.filter(entity => entity.startsWith(ROOM_CACHE));
  if (caches.length === 0) return share.records ? [call] : [];
  const kept = caches.filter(entity => share.inRoom(roomNamed(house, entity.slice(ROOM_CACHE.length))));
  if (kept.length === targets.length) return [call];
  return kept.length === 0 ? [] : [withTargets(call, kept)];
}

/** The displays the old scripts publish: the block selects and the Sara mirror. */
function mirrors(call: ServiceCall): boolean {
  return call.service === 'input_select.select_option' || call.service.startsWith('input_boolean.');
}

/** Who owns an input: its rooms, when every one of them is driven; the house for anything not from a room. */
function inputOrigin(live: LiveRooms, script: string, args: JsonObject, snapshot: Snapshot): Origin | undefined {
  const house = houseOf(snapshot), driven = drivenRooms(live, snapshot);
  const ofRooms = (rooms: Array<RoomId | undefined>): Origin | undefined =>
    rooms.length > 0 && rooms.every((room): room is RoomId => room !== undefined && driven.has(room))
      ? { kind: 'rooms', rooms: [...new Set(rooms)] } : undefined;
  const named = /^ls_remote_(?:gesture|power_quiet)_(.+)$/.exec(script);
  const byRoom = script.startsWith('automation.') || script === 'ls_remote_gesture';
  const remote = named !== null ? named[1] : byRoom && typeof args.room === 'string' ? args.room : undefined;
  if (remote !== undefined) {
    const entry = house.catalog.remotes[remote];
    return entry === undefined ? undefined : ofRooms([house.rooms.ofRemote[entry.device_id]]);
  }
  const trigger = objectOf(args.trigger);
  if (script === 'automation.effects_native_light_controls') {
    const control = typeof trigger.topic === 'string' ? controlTopic(trigger.topic) : undefined;
    if (control === undefined) return undefined;
    const row = nativeSourceFor(house.catalog.ui_rows, control.alias);
    const fallback = objectOf(args.sources)[control.alias];
    const source = row.matched ? row.source : typeof fallback === 'string' ? fallback : undefined;
    return source === undefined ? undefined : ofRooms([house.rooms.ofId[source]]);
  }
  if (script === 'automation.lighting_schedule_lamp_change_detector') {
    const lamps = entityIds(objectOf(objectOf(objectOf(trigger.event).data).service_data).entity_id);
    return ofRooms(lamps.map(lamp => house.rooms.ofId[lamp]));
  }
  if (script === 'automation.lighting_schedule_engine' && trigger.id === 'lamp_on') {
    const lamp = trigger.entity_id;
    return typeof lamp === 'string' ? ofRooms([house.rooms.ofId[lamp]]) : undefined;
  }
  return { kind: 'house' };
}

/** The scope a `--live-rooms` list gives the host. */
export function liveScope(live: LiveRooms): OutputScope {
  return {
    origin: (script, args, snapshot) => inputOrigin(live, script, args, snapshot),
    keeps: (entity, snapshot) => entity === RUNTIME && !wholeHouse(live, snapshot),
    share(call, snapshot, origin) {
      if (IN_PROCESS.has(call.service)) return [call];
      const house = houseOf(snapshot), share = shareOf(live, snapshot, origin);
      if (SWITCHING.has(call.service)) return switchingShare(house, share, call);
      if (call.service === 'mqtt.publish') return publishShare(house, share, call);
      if (call.service === 'variable.update_sensor') return sensorShare(house, share, call);
      if (mirrors(call)) return share.whole ? [call] : [];
      return share.records ? [call] : [];
    },
  };
}

function objectOf(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** The catalog lamps in the given driven rooms (every driven room by default), for the re-send when a room is handed over. */
export function drivenLamps(live: LiveRooms, snapshot: Snapshot, only?: ReadonlySet<RoomId>): string[] {
  const house = houseOf(snapshot), driven = drivenRooms(live, snapshot);
  return Object.keys(house.catalog.members).filter(lamp => {
    const room = house.rooms.ofId[lamp];
    return room !== undefined && driven.has(room) && (only === undefined || only.has(room));
  });
}

/**
 * The rooms the port drives, each with the time its port switch last
 * changed. Two looks at the house that differ for a room mean the room
 * changed hands in between, even when both looks find it driven: the switch
 * went off (the old scripts drove the room) and on again.
 */
export type Handed = ReadonlyMap<RoomId, string | undefined>;
export function handedRooms(live: LiveRooms, snapshot: Snapshot): Handed {
  const handed = new Map<RoomId, string | undefined>();
  for (const room of drivenRooms(live, snapshot)) {
    const state = snapshot.state[portSwitch(room)];
    handed.set(room, state === undefined ? undefined : state.last_changed !== undefined ? state.last_changed : state.last_updated);
  }
  return handed;
}
/** The rooms handed to the port between two looks. */
export function newlyHanded(before: Handed, after: Handed): Set<RoomId> {
  return new Set([...after].filter(([room, changed]) => !before.has(room) || before.get(room) !== changed).map(([room]) => room));
}
/** Whether an entity is some room's port switch. */
export function isPortSwitch(entity: string): boolean {
  return entity.startsWith(SWITCH_PREFIX) && entity.endsWith(SWITCH_SUFFIX) && entity.length > SWITCH_PREFIX.length + SWITCH_SUFFIX.length;
}
