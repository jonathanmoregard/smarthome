import type { LampId, RoomId } from '../domain/types/ids.ts';

export function toRoomId(raw: string): RoomId {
  // Cast: the one place a wire string becomes a RoomId.
  return raw as RoomId;
}

// Allowed place, but the cast carries no reason of its own.
export function toLampId(raw: string): LampId {
  return raw as LampId;
}
