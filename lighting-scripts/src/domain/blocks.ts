/**
 * The schedule's three fixed blocks, as a closed union.
 *
 * Lighting is fixed Day / Cosy / Night blocks — never a circadian curve — so
 * this really is the domain rather than a convenience alias. Making it a union
 * instead of `string` retires two classes of bug at once:
 *
 * - a block arriving as `0`, `''`, `{}` or `'NIGHT'` is rejected at the
 *   boundary instead of being coerced into something plausible, and
 * - the override `input_select`'s option label comes from {@link blockOption}
 *   rather than from ad-hoc case surgery, so there is no longer a string
 *   transformation that can disagree with the oracle's `| capitalize`.
 *
 * The parsers that admit a block from an unparsed document live in
 * `src/parse/blocks.ts`, together with the note on the captured
 * `S.get('cur') or 'night'` fallback they deliberately do not reproduce.
 */
export const BLOCKS = ['day', 'cosy', 'night'] as const;

export type Block = (typeof BLOCKS)[number];

/** The block used when nothing has decided one yet. */
export const DEFAULT_BLOCK: Block = 'night';

const OPTION: Record<Block, string> = { day: 'Day', cosy: 'Cosy', night: 'Night' };

/** The `input_select.ls_<room>_override` option label for a block. */
export function blockOption(block: Block): string {
  return OPTION[block];
}
