import type { RoomId } from './types/ids.ts';

// Not casts to a domain type: `as const` and a cast to string.
export const rooms = ['a', 'b'] as const;
export const text = rooms[0] as string;

export function forged(raw: string): RoomId {
  // Cast: a reason does not make a cast outside the constructors allowed.
  return raw as RoomId;
}
