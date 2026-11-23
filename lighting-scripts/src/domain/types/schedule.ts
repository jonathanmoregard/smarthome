import type { RoomId } from './ids.ts';
import type { Ranged } from './ranged.ts';

/** How far a transition between two blocks has got, 0 (at the first) to 1 (at the second). */
export type Progress = Ranged<'Progress'>;

/** Whose schedule something follows: a room's own, or the house's (a lamp in no scheduled room). */
export type RoomOrHouse = RoomId | 'house';
