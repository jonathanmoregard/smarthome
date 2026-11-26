import type { RoomId } from '../../domain/types/ids.ts';

// An alias declared outside src/domain/types still names a domain type.
type Room = RoomId;

export function viaAlias(raw: string): Room {
  return raw as Room;
}
