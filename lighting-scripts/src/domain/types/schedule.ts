import type { Ranged } from './range.ts';

/** How far a transition between two blocks has got, 0 (at the first) to 1 (at the second). */
export type Progress = Ranged<'Progress'>;
