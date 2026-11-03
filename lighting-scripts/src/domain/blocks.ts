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
 * The captured source spells the fallback `S.get('cur') or 'night'`, whose
 * trigger is every falsy value. We deliberately do **not** reproduce that:
 * absence means "no block decided yet" and legitimately falls back to Night,
 * while a present-but-ill-typed value is a malformed cache and raises. See
 * `docs/jinja-coercion-table.md` for what the oracle does and
 * `tasks/mission.md` design mandate v2 for why we diverge.
 */
import type { JsonValue } from '../runtime/context.ts';
import { ParseError } from '../runtime/parse.ts';

export const BLOCKS = ['day', 'cosy', 'night'] as const;

export type Block = (typeof BLOCKS)[number];

/** The block used when nothing has decided one yet. */
export const DEFAULT_BLOCK: Block = 'night';

const OPTION: Record<Block, string> = { day: 'Day', cosy: 'Cosy', night: 'Night' };

export function isBlock(value: JsonValue | undefined): value is Block {
  return typeof value === 'string' && (BLOCKS as readonly string[]).includes(value);
}

export function requireBlock(value: JsonValue | undefined, context: string): Block {
  if (!isBlock(value)) {
    throw new ParseError(`${context} must be one of ${BLOCKS.join('/')}, got ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return value;
}

/**
 * Absent (or explicitly null, which is how Home Assistant spells "no value")
 * yields `undefined`. A present value must be a real block.
 */
export function optionalBlock(value: JsonValue | undefined, context: string): Block | undefined {
  return value === undefined || value === null ? undefined : requireBlock(value, context);
}

/** The `input_select.ls_<room>_override` option label for a block. */
export function blockOption(block: Block): string {
  return OPTION[block];
}
