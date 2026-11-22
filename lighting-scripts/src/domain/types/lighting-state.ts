import type { LampId, RoomId, SwitchId } from './ids.ts';
import type { LampLight, Power } from './light.ts';

/**
 * What one entry of the lighting state is about: a lamp, or a whole room.
 * Built only by `lampOrRoom` in `src/parse/lighting-state.ts`.
 */
export type LampOrRoom = { kind: 'lamp'; lamp: LampId } | { kind: 'room'; room: RoomId };

/** What every lamp and switch should show: derived from the Model, and what the adapter makes the house match. */
export type LightingState = { lamps: Record<LampId, LampLight>; switches: Record<SwitchId, Power> };
