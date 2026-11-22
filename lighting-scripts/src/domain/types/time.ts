import type { Id } from './ids.ts';
import type { Ranged } from './range.ts';

/** A moment: seconds since the epoch, finite. The unit today's schedule arithmetic runs on. */
export type Instant = Ranged<'Instant'>;
/** A duration in seconds: finite, not negative. */
export type Seconds = Ranged<'Seconds'>;
/** A clock time: hour 0..23, minute 0..59. */
export type TimeOfDay = { readonly hour: Ranged<'Hour'>; readonly minute: Ranged<'Minute'> };
/** An IANA zone id (`Europe/Stockholm`). */
export type Timezone = Id<'Timezone'>;
