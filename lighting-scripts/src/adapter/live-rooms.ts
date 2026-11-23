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
