/**
 * The rooms this process drives, read from its command line.
 *
 * The setting is required. A missing list must not mean every room: during a
 * room-by-room rollout the old scripts still drive the rest of the house, and
 * a port that silently took the whole house would fight them in every room.
 * An empty value is a real answer: the port drives no room and sends no lamp
 * or switch command.
 */
import type { RoomId } from '../domain/types/ids.ts';
import { roomOfText } from './codecs/rooms.ts';
import type { Rooms } from './codecs/rooms.ts';
import type { Catalog } from './codecs/catalog.ts';
import type { ServiceCall } from './ha-client.ts';

export type LiveRooms = ReadonlySet<RoomId>;

export const LIVE_ROOMS_FLAG = '--live-rooms';

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
 * Refuse a live-room list that is not the whole house: every room a catalog lamp is in, and no other. A misspelt room
 * would be driven by neither system; and until rooms can be shared with the old scripts again (M6), the port drives
 * every room or none, so a partial list is refused rather than half-honoured.
 */
export function refuseUnlessWholeHouse(live: LiveRooms, catalog: Catalog, rooms: Rooms): void {
  const house = new Set(Object.keys(catalog.members).flatMap(lamp => {
    const room = rooms.ofId[lamp];
    return room === undefined ? [] : [room];
  }));
  const unknown = [...live].filter(room => !house.has(room)), missing = [...house].filter(room => !live.has(room));
  const list = [...house].sort().join(', ');
  if (unknown.length > 0) {
    throw new Error(`${LIVE_ROOMS_FLAG} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'holds' : 'hold'} no lamp of the house; `
      + `its rooms are ${list}`);
  }
  if (missing.length > 0) {
    throw new Error(`${LIVE_ROOMS_FLAG} leaves out ${missing.sort().join(', ')}: the port drives the whole house (${list}) until rooms `
      + 'can be shared with the old scripts again');
  }
}

/** The text helper the port's heartbeat writes. */
const HEARTBEAT = 'input_text.ls_port_heartbeat';

/**
 * The port's heartbeat: `<unix seconds>|<live rooms>`. Home Assistant's
 * watchdog turns off every port switch on for a room this does not name, or
 * every one once it stops changing, so a port that stopped, crashed or was
 * started without a room hands those rooms back to the old scripts. The time
 * makes every beat a change; staleness is judged by Home Assistant's own
 * clock. A port with no live room beats nothing, so it sends nothing at all.
 */
export function heartbeatCall(live: LiveRooms, nowMs: number): ServiceCall | undefined {
  if (live.size === 0) return undefined;
  return { service: 'input_text.set_value', data: { value: `${Math.floor(nowMs / 1000)}|${[...live].sort().join(',')}` },
    target: { entity_id: HEARTBEAT } };
}
