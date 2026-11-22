import type { RoomId } from './ids.ts';

// Allowed place, but the cast carries no reason of its own.
export function roomOrThrow(raw: number): RoomId {
  return raw as RoomId;
}

export function notAConstructor(raw: number): RoomId {
  // Cast: reason given, but a function of this name is not a range constructor.
  return raw as RoomId;
}
