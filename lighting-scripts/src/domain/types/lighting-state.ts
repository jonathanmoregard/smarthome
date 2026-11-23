import type { LampId, RoomId, SwitchId } from './ids.ts';
import type { LampLight, Power } from './light.ts';

/**
 * What one entry of the lighting state is about: a lamp, or a whole room.
 * Built by the adapter's codecs: the config's live controls and the inputs that name a lamp or a room.
 */
export type LampOrRoom = { kind: 'lamp'; lamp: LampId } | { kind: 'room'; room: RoomId };

/** What every lamp and switch should show: derived from the Model, and what the adapter makes the house match. */
export type LightingState = { lamps: Record<LampId, LampLight>; switches: Record<SwitchId, Power> };
