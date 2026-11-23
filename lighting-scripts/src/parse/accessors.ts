/**
 * The lenient and semi-lenient accessors for raw JSON read at the edge. Each
 * takes a `JsonValue` and decides what it means.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaList, ParseError, requireArray } from '../runtime/parse.ts';

export const list = (value: JsonValue | undefined): JsonValue[] =>
  value === undefined ? [] : requireArray({ value }, 'value', 'schedule list');
export function timestamp(value: JsonValue | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ts = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  if (!Number.isFinite(ts)) {
    throw new ParseError(`schedule timestamp must be a finite epoch or date string, got ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return ts;
}
/**
 * Jinja's `| list` over what it can list -- a list, a string's characters, a
 * mapping's keys -- and none for anything else, where the filter raises. For
 * values read back from Home Assistant (2026-11-21: a value a person can edit
 * recovers). Never raises.
 */
export function jinjaListOf(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) || typeof value === 'string' || isObject(value) ? jinjaList(value) : undefined;
}
/**
 * What a saved profile reads as when it holds no profile: the captured
 * `from_json(default={})` for text that is not JSON, and -- by the lenient
 * saved-value directive (2026-11-19) -- for JSON that is not a mapping, where
 * the captured `.get` on it raises.
 */
const NO_SAVED_PROFILE: Readonly<JsonObject> = {};

/**
 * A saved `input_text` profile, read as the captured
 * `states(entity) | from_json(default={})`: text that is not JSON (Home
 * Assistant's `unknown`/`unavailable` included) or JSON that is not a mapping
 * is {@link NO_SAVED_PROFILE}. Never raises.
 */
export function saved(ctx: HouseView, entity: string): JsonObject {
  let parsed: JsonValue;
  try { parsed = JSON.parse(ctx.get(entity)) as JsonValue; }
  catch { return { ...NO_SAVED_PROFILE }; }
  return isObject(parsed) ? parsed : { ...NO_SAVED_PROFILE };
}
