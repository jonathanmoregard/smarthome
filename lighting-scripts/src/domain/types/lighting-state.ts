import type { LampId, RoomId } from './ids.ts';

/**
 * What one entry of the lighting state is about: a lamp, or a whole room.
 * Built only by `lampOrRoom` in `src/parse/lighting-state.ts`.
 */
export type LampOrRoom = { kind: 'lamp'; lamp: LampId } | { kind: 'room'; room: RoomId };
