import type { Ranged } from './range.ts';

/**
 * A bound of a remote's step range: -20..20, the captured default
 * `{'min':-20,'max':20}`, which is also the widest range the scripts accept
 * (`-20 <= min <= max <= 20`). Not necessarily whole: the check admits any
 * finite number between the ends.
 */
export type Step = Ranged<'Step'>;

/**
 * A remote's net presses, brighter less dimmer: -40..40, positive is brighter.
 * Like {@link Step}, not necessarily whole: today's reader admits any finite
 * number in that range (`inputFacts` in `src/parse/resolution.ts`).
 */
export type StepCount = Ranged<'StepCount'>;

/**
 * A command a remote's presses send for its room: brighter (`up`) or dimmer
 * (`down`), the presets to the left or right, the power toggle, the room's
 * reset, and the mode overlay's toggle (today's `sara_toggle`). A press that
 * is no command never reaches the domain: the adapter drops it.
 */
export type RemoteCommand = 'up' | 'down' | 'left' | 'right' | 'toggle' | 'reset' | 'mode';
