import type { Ranged } from './range.ts';

/**
 * A bound of a remote's step range: -20..20, the captured default
 * `{'min':-20,'max':20}`, which is also the widest range the scripts accept
 * (`-20 <= min <= max <= 20`). Not necessarily whole: the check admits any
 * finite number between the ends.
 */
export type Step = Ranged<'Step'>;
