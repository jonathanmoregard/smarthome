/**
 * The schedule's three fixed blocks, as a closed union.
 *
 * Lighting is fixed Day / Cosy / Night blocks — never a circadian curve — so
 * this really is the domain rather than a convenience alias. Making it a union
 * instead of `string` retires two classes of bug at once:
 *
 * - an unparsed value becomes a block (or is rejected) once, at the boundary,
 *   instead of being compared as a string throughout, and
 * - the override `input_select`'s option label comes from {@link blockOption}
 *   rather than from ad-hoc case surgery, so there is no longer a string
 *   transformation that can disagree with the oracle's `| capitalize`.
 *
 * The parsers that admit a block from an unparsed document live in
 * `src/parse/blocks.ts`: strict ones for values this port produced, and a
 * lenient one with a default for the saved room period.
 */
export const BLOCKS = ['day', 'cosy', 'night'] as const;

export type Block = (typeof BLOCKS)[number];

/** The block used when nothing has decided one yet, or a saved one is unreadable. */
export const DEFAULT_BLOCK: Block = 'night';

const OPTION: Record<Block, string> = { day: 'Day', cosy: 'Cosy', night: 'Night' };

/** The `input_select.ls_<room>_override` option label for a block. */
export function blockOption(block: Block): string {
  return OPTION[block];
}
