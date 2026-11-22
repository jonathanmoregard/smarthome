/**
 * Admitting a schedule block from an unparsed document.
 *
 * Lighting is fixed Day / Cosy / Night blocks — never a circadian curve — so
 * {@link Block} really is the domain rather than a convenience alias. Parsing
 * into that closed union at the boundary retires two classes of bug at once:
 *
 * - an unparsed value becomes a block (or is rejected) once, here, instead of
 *   being compared as a string throughout, and
 * - the override `input_select`'s option label comes from `blockOption` rather
 *   than from ad-hoc case surgery, so there is no longer a string
 *   transformation that can disagree with the oracle's `| capitalize`.
 *
 * Two readings exist. The strict ones ({@link requireBlock},
 * {@link optionalBlock}) decode values this port produced itself, such as
 * `ls_base`/`ls_room_base` results, where anything but a block is a bug and
 * raises. {@link savedBlock} reads the room period `cur` saved in the room
 * cache, which outlives any one run and may hold garbage: it is lenient and
 * always yields a block, defaulting to {@link DEFAULT_BLOCK} (user directive
 * 2026-11-19, "typed with parser that is flexible and has default"). See
 * `docs/jinja-coercion-table.md` for what the oracle's
 * `(S.get('cur') or 'night') | capitalize` does.
 */
import type { JsonValue } from '../runtime/context.ts';
import { jinjaTruthy, ParseError } from '../runtime/parse.ts';
import { BLOCKS, DEFAULT_BLOCK } from '../domain/blocks.ts';
import type { Block } from '../domain/blocks.ts';

/**
 * Absent (or explicitly null, which is how Home Assistant spells "no value")
 * yields `undefined`. A present value must be a real block.
 */
export function optionalBlock(value: JsonValue | undefined, context: string): Block | undefined {
  return value === undefined || value === null ? undefined : requireBlock(value, context);
}

export function requireBlock(value: JsonValue | undefined, context: string): Block {
  if (!isBlock(value)) {
    throw new ParseError(`${context} must be one of ${BLOCKS.join('/')}, got ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return value;
}

export function isBlock(value: JsonValue | undefined): value is Block {
  return typeof value === 'string' && (BLOCKS as readonly string[]).includes(value);
}

/**
 * The saved room period `cur`, read leniently: never raises, always a block.
 *
 * 1. Absent, null, or any other Jinja-falsy value (`''`, `0`, `false`, `[]`,
 *    `{}`) means "no block decided yet": {@link DEFAULT_BLOCK}.
 * 2. A string naming a block in any case (`'NIGHT'`, `'Cosy'`) is that block.
 * 3. Anything else is unreadable: {@link DEFAULT_BLOCK}.
 */
export function savedBlock(value: JsonValue | undefined): Block {
  if (!jinjaTruthy(value) || typeof value !== 'string') return DEFAULT_BLOCK;
  const normalised = value.toLowerCase();
  return isBlock(normalised) ? normalised : DEFAULT_BLOCK;
}
