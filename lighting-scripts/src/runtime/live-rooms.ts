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
import type { EntityState, JsonObject, JsonValue, ServiceCall, Snapshot } from './context.ts';
import type { OutputScope } from './host.ts';
import type { Catalog } from './catalog.ts';
import type { RoomId } from '../domain/types/ids.ts';
import type { Rooms } from '../domain/types/rooms.ts';
import type { LiveRooms } from '../parse/live-rooms.ts';
import { emptyCatalog, parseCatalog } from './catalog.ts';
import { parseRooms } from '../parse/rooms.ts';
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

/**
 * Where a call lands: the house as a whole, or the rooms of the lamps,
 * bulbs and switches it reaches (`undefined` for one the registry puts in no
 * room).
 */
type Place = { kind: 'house' } | { kind: 'rooms'; rooms: Array<RoomId | undefined> };

/** A bulb is in its lamp's room; a bulb no lamp claims is in its own. */
function bulbRoom(house: House, bulb: string): RoomId | undefined {
  const lamp = house.lampOfBulb.get(bulb);
  return lamp === undefined ? house.rooms.ofId[bulb] : house.rooms.ofId[lamp];
}

function placeOf(call: ServiceCall, snapshot: Snapshot): Place {
  const house = houseOf(snapshot);
  if (SWITCHING.has(call.service)) {
    // A light or switch the catalog does not list and the registry puts in no
    // room is no lamp (a dashboard proxy), so it is the house's.
    const reached = targetsOf(call).filter(entity => Object.hasOwn(house.catalog.members, entity) || house.lampOfBulb.has(entity)
      || house.rooms.ofId[entity] !== undefined);
    return reached.length === 0 ? { kind: 'house' } : { kind: 'rooms', rooms: reached.map(entity => bulbRoom(house, entity)) };
  }
  if (call.service === 'mqtt.publish') {
    const owners = call.guard?.owners;
    if (owners !== undefined && owners.length > 0) return { kind: 'rooms', rooms: owners.map(owner => house.rooms.ofId[owner]) };
    const topic = call.data.topic, bulbs = typeof topic === 'string' ? house.bulbsOfTopic.get(topic) : undefined;
    return bulbs === undefined ? { kind: 'house' } : { kind: 'rooms', rooms: bulbs.map(bulb => bulbRoom(house, bulb)) };
  }
  if (call.service === 'variable.update_sensor') {
    const caches = targetsOf(call).filter(entity => entity.startsWith(ROOM_CACHE));
    if (caches.length > 0) return { kind: 'rooms', rooms: caches.map(entity => roomNamed(house, entity.slice(ROOM_CACHE.length))) };
  }
  return { kind: 'house' };
}

/** The house room a room cache's name spells, if the house has it. */
function roomNamed(house: House, name: string): RoomId | undefined {
  return [...houseRooms(house)].find(room => room === name);
}

/** The scope a `--live-rooms` list gives the host. */
export function liveScope(live: LiveRooms): OutputScope {
  const keeps = (entity: string, snapshot: Snapshot) => entity === RUNTIME && !wholeHouse(live, snapshot);
  return {
    keeps,
    sends(call, snapshot) {
      const place = placeOf(call, snapshot);
      if (place.kind === 'house') return !targetsOf(call).some(entity => keeps(entity, snapshot));
      const driven = drivenRooms(live, snapshot);
      return place.rooms.length > 0 && place.rooms.every(room => room !== undefined && driven.has(room));
    },
  };
}

function objectOf(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Whether an input from Home Assistant is the port's to act on. A remote
 * press, a dashboard control, a lamp switched from the app or a lamp switched
 * on is the port's only in a room it drives; anything else (the schedule
 * tick, house modes, recovery) is the house's, and its lamp output is scoped
 * by {@link liveScope}.
 */
export function drivesInput(live: LiveRooms, script: string, args: JsonObject, snapshot: Snapshot): boolean {
  const house = houseOf(snapshot), driven = drivenRooms(live, snapshot);
  const inDriven = (room: RoomId | undefined) => room !== undefined && driven.has(room);
  const named = /^ls_remote_(?:gesture|power_quiet)_(.+)$/.exec(script);
  const remote = named !== null ? named[1] : script.startsWith('automation.') && typeof args.room === 'string' ? args.room : undefined;
  if (remote !== undefined) {
    const entry = house.catalog.remotes[remote];
    return entry !== undefined && inDriven(house.rooms.ofRemote[entry.device_id]);
  }
  const trigger = objectOf(args.trigger);
  if (script === 'automation.effects_native_light_controls') {
    const control = typeof trigger.topic === 'string' ? controlTopic(trigger.topic) : undefined;
    if (control === undefined) return false;
    const row = nativeSourceFor(house.catalog.ui_rows, control.alias);
    const fallback = objectOf(args.sources)[control.alias];
    const source = row.matched ? row.source : typeof fallback === 'string' ? fallback : undefined;
    return source !== undefined && inDriven(house.rooms.ofId[source]);
  }
  if (script === 'automation.lighting_schedule_lamp_change_detector') {
    const lamps = entityIds(objectOf(objectOf(objectOf(trigger.event).data).service_data).entity_id);
    return lamps.length > 0 && lamps.every(lamp => inDriven(house.rooms.ofId[lamp]));
  }
  if (script === 'automation.lighting_schedule_engine' && trigger.id === 'lamp_on') {
    const lamp = trigger.entity_id;
    return typeof lamp === 'string' && inDriven(house.rooms.ofId[lamp]);
  }
  return true;
}

/** The catalog lamps in the rooms the port drives, for the re-send when a room is handed over. */
export function drivenLamps(live: LiveRooms, snapshot: Snapshot, only?: RoomId): string[] {
  const house = houseOf(snapshot), driven = drivenRooms(live, snapshot);
  return Object.keys(house.catalog.members).filter(lamp => {
    const room = house.rooms.ofId[lamp];
    return room !== undefined && driven.has(room) && (only === undefined || room === only);
  });
}

/** The live room whose port switch just turned on, if this change is one. */
export function switchedOnRoom(live: LiveRooms, entity: string, before: EntityState | undefined,
  after: EntityState | null | undefined): RoomId | undefined {
  if (after === null || after === undefined || after.state !== 'on' || before?.state === 'on') return undefined;
  return [...live].find(room => portSwitch(room) === entity);
}
