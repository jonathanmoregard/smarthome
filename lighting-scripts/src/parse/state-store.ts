/**
 * Parsing for the `state-store` handlers: `ls_override_block`,
 * `ls_clear_overrides` and `ls_sara_mode`, plus the two Jinja spellings the
 * module's scripts share.
 *
 * Every raise stays where the inline read made it: the scope's unhashable
 * check is a lookup function the domain calls at the lookup, after the
 * `ls_apply` dry run, never during argument parsing.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { isObject, jinjaString, object, ParseError } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { BlockTarget, OverrideBlockArgs, ScheduledBlocks, ViaArgs } from '../domain/state-store.ts';

/** Jinja `~` uses an empty string for Undefined, unlike the `| string` filter. */
export function concatString(value: JsonValue | undefined): string {
  return value === undefined ? '' : jinjaString(value);
}

/**
 * The key a Jinja mapping lookup uses. Python mappings reject the unhashable
 * JSON container types as keys, so those raise; every other non-string misses,
 * because a JSON mapping's keys are all strings.
 */
export function mappingKey(key: JsonValue | undefined, context: string): string | undefined {
  if (Array.isArray(key) || isObject(key)) {
    throw new ParseError(`${context} is unhashable for Jinja mapping lookup`);
  }
  return typeof key === 'string' ? key : undefined;
}

/** Captured via has `| default('app')` sites: only an absent via is replaced. */
function via(args: JsonObject): Verbatim {
  return carry(args.via === undefined ? 'app' : args.via);
}

function blockTarget(value: JsonValue | undefined): BlockTarget {
  return {
    isHouse: value === 'house',
    record: carry(value ?? null),
    keyText: concatString(value),
    key: () => mappingKey(value, 'ls_override_block.scope'),
  };
}

/** A room the house scope expanded to: always a plain string key. */
export function roomTarget(room: string): BlockTarget {
  return blockTarget(room);
}

/**
 * Captured scope is raw twice (list construction and comparison), block has
 * one `| lower`, and via has two `| default('app')` sites. Raw scope remains
 * raw; the case filter coerces through Jinja string spelling.
 */
export function parseOverrideBlockArgs(args: JsonObject): OverrideBlockArgs {
  return {
    scope: blockTarget(args.scope),
    block: jinjaString(args.block).toLowerCase(),
    via: via(args),
  };
}

export function parseViaArgs(args: JsonObject): ViaArgs {
  return { via: via(args) };
}

/**
 * The block each scope is scheduled to, from the `ls_apply` dry run, read with
 * the captured `object(object(.plan).sched)` leniency. A scheduled value is only
 * ever compared with the requested block, a string, so a non-string value is
 * `undefined`: it compares unequal exactly as the raw value did.
 */
export function scheduledBlocks(result: JsonValue): ScheduledBlocks {
  const schedule = object(object(object(result).plan).sched);
  return key => {
    if (key === undefined) return undefined;
    const value = schedule[key];
    return typeof value === 'string' ? value : undefined;
  };
}
