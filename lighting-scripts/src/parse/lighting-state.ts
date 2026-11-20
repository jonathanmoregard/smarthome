/**
 * Parsers for the lighting state's entries (the `targets` maps the scripts
 * hand each other).
 */
import type { LampOrRoom } from '../domain/types/lighting-state.ts';
import type { JsonValue } from '../runtime/context.ts';
import { jinjaTruthy } from '../runtime/parse.ts';
import { toLampId, toRoomId } from './ids.ts';

/** The key prefix of a room's entry: the schedule keys a room's target `room:<room>`. */
const ROOM_KEY = 'room:';

/**
 * Which thing the entry under `key` is about. The stored `is_room` picks the
 * case exactly as the scripts' Jinja `if target.is_room` does (Jinja
 * truthiness, so a missing flag is a lamp). A room's entry is keyed
 * `room:<room>`; a key flagged as a room without that prefix is taken whole
 * as the room's name. A lamp's entry is keyed by the lamp.
 */
export function lampOrRoom(key: string, isRoom: JsonValue | undefined): LampOrRoom {
  if (!jinjaTruthy(isRoom)) return { kind: 'lamp', lamp: toLampId(key) };
  return { kind: 'room', room: toRoomId(key.startsWith(ROOM_KEY) ? key.slice(ROOM_KEY.length) : key) };
}
