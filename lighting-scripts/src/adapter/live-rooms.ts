/**
 * The rooms this process drives (spec 5.4).
 *
 * The harness runs the whole house. The live port drives the rooms named by `--live-rooms` whose port switch is on;
 * the old scripts drive the rest, and skip a room whose switch is on. The switch is where a person, or Home
 * Assistant's watchdog over the port's heartbeat, hands a room over or back.
 *
 * The setting is required. A missing list must not mean every room: during a room-by-room rollout the old scripts
 * still drive the rest of the house, and a port that silently took the whole house would fight them in every room.
 * An empty value is a real answer: the port drives no room and sends no lamp or switch command. The whole house is
 * the port's only by `--live-rooms all`, the full cutover; a list naming every room is still a list, so the old
 * house-wide automations keep the dashboard, the mode and the house's overlays until then.
 */
import type { Config } from '../domain/config.ts';
import type { RoomId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import { drives, portSwitch, portSwitchesMissing, roomOfText } from './codecs/rooms.ts';
import type { EntityState } from './ha-client.ts';
import type { Share } from './codecs/rooms.ts';
import type { Msg, OverlayRequest } from '../domain/update.ts';

export type LiveRooms = ReadonlySet<RoomId>;

/** `--live-rooms <list>` from the arguments; the flag is required and its value may be `''`. */
export function readLiveRoomsFlag(argv: readonly string[]): LiveRooms {
  const index = argv.indexOf(LIVE_ROOMS_FLAG);
  if (index < 0) return parseLiveRooms(undefined);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${LIVE_ROOMS_FLAG}`);
  return parseLiveRooms(value);
}

/** A comma-separated list of room ids (Home Assistant area ids); `''` is none. */
export function parseLiveRooms(raw: string | undefined): LiveRooms {
  if (raw === undefined) {
    throw new Error(`Missing ${LIVE_ROOMS_FLAG}: name the rooms this process drives, comma-separated, or give '' to drive none`);
  }
  if (raw.trim() === '') return new Set();
  const rooms = new Set<RoomId>();
  for (const item of raw.split(',')) {
    const room = roomOfText(item.trim());
    if (room === undefined) throw new Error(`${LIVE_ROOMS_FLAG} has an empty room in '${raw}'`);
    rooms.add(room);
  }
  return rooms;
}

/**
 * Refuse a live room that holds none of the house's lamps: a misspelt room (`bedrom`) would be skipped by neither
 * system's switch check and driven by neither.
 */
export function refuseUnknownRooms(live: LiveRooms, config: Config): void {
  const house = lampRooms(config);
  const unknown = [...live].filter(room => !house.has(room));
  if (unknown.length > 0) {
    throw new Error(`${LIVE_ROOMS_FLAG} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'holds' : 'hold'} no lamp of the house; `
      + `its rooms are ${[...house].sort().join(', ')}`);
  }
}

/** The rooms that hold a lamp of the house: the config's lamps, its one owner. */
export function lampRooms(config: Config): LiveRooms {
  return new Set(entriesOf(config.lamps).flatMap(([, lamp]) => lamp.room === undefined ? [] : [lamp.room]));
}

/**
 * Refuse a live room Home Assistant has no port switch for: the old scripts read the room as not handed over and keep
 * driving it, and the port, never handed it, would drive nothing there and say nothing.
 */
export function refuseRoomsWithoutSwitch(live: LiveRooms, state: Readonly<Record<string, EntityState>>): void {
  const missing = portSwitchesMissing(state, live);
  if (missing.length > 0) throw new Error(noPortSwitch(missing));
}

/** What a live room with no port switch is told as: the rooms, and the helpers to make. */
export function noPortSwitch(missing: readonly RoomId[]): string {
  return `${LIVE_ROOMS_FLAG} names ${missing.join(', ')}, which ${missing.length === 1 ? 'has' : 'have'} no port switch `
    + `${missing.map(portSwitch).join(', ')} in Home Assistant; create it to hand the room over`;
}

/** The rooms a process is given: the whole house (the harness), or those its command line lists (the live port). */
export type RoomsGiven = { kind: 'house' } | { kind: 'listed'; rooms: LiveRooms };

/** The rooms the command line gives: the whole house for `--live-rooms all`, else the list. */
export function roomsGiven(argv: readonly string[]): RoomsGiven {
  const index = argv.indexOf(LIVE_ROOMS_FLAG);
  return index >= 0 && argv[index + 1] === ALL_ROOMS ? { kind: 'house' } : { kind: 'listed', rooms: readLiveRoomsFlag(argv) };
}

/**
 * The turn's share of the house: the whole house only when given it (`--live-rooms all`); otherwise the handed rooms,
 * even every one of them, so a lamp in no room and a plug in a room with no lamp stay the old scripts'.
 */
export function shareOf(given: RoomsGiven, handed: ReadonlySet<RoomId>): Share {
  return given.kind === 'house' ? given : { kind: 'rooms', rooms: handed };
}

export const LIVE_ROOMS_FLAG = '--live-rooms';

/** The flag's value that gives the port the whole house: the full cutover. */
const ALL_ROOMS = 'all';

/** The rooms a heartbeat names: those the command line lists, or with the whole house, each room of the config's lamps. */
export function beatRooms(given: RoomsGiven, config: Config): LiveRooms {
  return given.kind === 'listed' ? given.rooms : lampRooms(config);
}

/**
 * The part of a message the turn acts on, or none. The clock and the config read again always are the turn's. A
 * person's light call is the one owner of its reach: the bridge passes every one, and the turn takes the lamps and the
 * rooms it drives, leaving the rest to the old scripts. Another message about rooms is the turn's when it drives every
 * room the message is about; one about the house (the mode, the house's block, clearing every overlay, the range
 * defaults) only when the turn drives the whole house: the old scripts commit it, and the port follows it from the store.
 */
export function ownPart(share: Share, msg: Msg, config: Config): Msg | undefined {
  const all = (rooms: readonly (RoomId | undefined)[]) => rooms.length > 0 && rooms.every(room => drives(share, room));
  const owned = (whole: boolean) => whole ? msg : undefined;
  switch (msg.kind) {
    case 'clock': case 'configChanged': return msg;
    case 'overlayRequested': return owned(ownsRequest(share, msg.request, config));
    case 'lampChangedByPerson': {
      const lamps = msg.lamps.filter(lamp => drives(share, config.lamps[lamp]?.room));
      return lamps.length === 0 ? undefined : { ...msg, lamps, rooms: msg.rooms.filter(room => drives(share, room)) };
    }
    case 'remotePressed': case 'remoteButtonPressed': return owned(all([config.remotes[msg.remote]?.room]));
    case 'switchButtonPressed': return owned(all([config.switches[msg.switch]?.room]));
    case 'rangeSaved': return owned(all([msg.room]));
    case 'lampProfileSaved': return owned(all([config.lamps[msg.lamp]?.room]));
    case 'switchProfileSaved': return owned(all([config.switches[msg.switch]?.room]));
    case 'modeToggled': case 'rangeDefaultsSaved': return owned(share.kind === 'house');
    case 'plantsAllOffSet': return msg;
  }
}

function ownsRequest(share: Share, request: OverlayRequest, config: Config): boolean {
  switch (request.kind) {
    case 'clear all': return share.kind === 'house';
    case 'hold block': return request.over === 'house' ? share.kind === 'house' : drives(share, request.over);
    case 'room power': return drives(share, request.room);
    case 'dashboard control':
      return drives(share, request.over.kind === 'room' ? request.over.room : config.lamps[request.over.lamp]?.room);
  }
}
