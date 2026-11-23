/**
 * The schedule's three fixed blocks, as a closed union.
 *
 * Lighting is fixed Day / Cosy / Night blocks — never a circadian curve — so
 * this really is the domain rather than a convenience alias. Making it a union
 * instead of `string` retires two classes of bug at once:
 *
 * - an unparsed value becomes a block (or is rejected) once, at the boundary,
 *   instead of being compared as a string throughout, and
 * - the override `input_select`'s option label is written from the block by
 *   the adapter's writer, not by ad-hoc case surgery.
 */
export const BLOCKS = ['day', 'cosy', 'night'] as const;

export type Block = (typeof BLOCKS)[number];

/** The block used when nothing has decided one yet, or a saved one is unreadable. */
export const DEFAULT_BLOCK: Block = 'night';
