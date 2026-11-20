/**
 * The lenient and semi-lenient accessors the domain used to call on raw JSON.
 *
 * They lived in `domain/schedule.ts` and nine domain modules imported them from
 * there. They are parse-layer tools -- each takes a `JsonValue` and decides
 * what it means -- so they live here now. `schedule.ts` keeps a temporary
 * re-export until every importer has been repointed (criterion 7's close-out
 * deletes it). Moved unchanged: every message, fallback and raise is the same.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaTruthy, ParseError, requireArray, requireFinite, requireString } from '../runtime/parse.ts';

export const list = (value: JsonValue | undefined): JsonValue[] =>
  value === undefined ? [] : requireArray({ value }, 'value', 'schedule list');
export const strings = (value: JsonValue | undefined): string[] => list(value).map((item, index) =>
  requireString({ item }, 'item', `schedule string list[${index}]`));
export function num(value: JsonValue | undefined, fallback?: number): number {
  // `null` is Home Assistant's no-value spelling for entity attributes. A
  // caller that has a real default must state it; malformed present values do
  // not get to take that default.
  if ((value === undefined || value === null || value === 'unknown' || value === 'unavailable') && fallback !== undefined) return fallback;
  return requireFinite(value, 'schedule number');
}
/**
 * Home Assistant native-template output coercion at the render/re-entry
 * boundary. This is deliberately not a general parser: HA turns a template's
 * exact scalar output back into a native value before a script or variable
 * sensor receives it, so confining that behavior here models the transport
 * boundary without weakening lighting-domain numbers or strings.
 */
export function nativeScalar(value: JsonValue): JsonValue {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text === 'True') return true;
  if (text === 'False') return false;
  if (text === 'None') return null;
  const numeric = /^[+-]?(?!0\d)\d*(?:\.\d*)?$/.test(text) && /\d/.test(text);
  return numeric && Number.isFinite(Number(text)) ? Number(text) : value;
}
export function timestamp(value: JsonValue | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ts = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  if (!Number.isFinite(ts)) {
    throw new ParseError(`schedule timestamp must be a finite epoch or date string, got ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return ts;
}
export function optionalTimestamp(value: JsonValue | undefined): number | undefined {
  return value === undefined || value === null ? undefined : timestamp(value);
}
/**
 * A `test_now` argument, read as the captured `test_now is defined and test_now`:
 * absent or Jinja-falsy (`0`, `''`, `false`, `none`) is now, `undefined` here;
 * a truthy value must be a timestamp.
 */
export function testNow(value: JsonValue | undefined): number | undefined {
  return value === undefined || !jinjaTruthy(value) ? undefined : timestamp(value);
}
/**
 * Home Assistant's `as_timestamp(value, fallback)`: date text is its instant;
 * anything else -- unreadable text, `none`, a container, and numeric Unix
 * seconds too (measured: `as_timestamp(1700000000, 0)` is `0`) -- is `fallback`.
 */
export function asTimestampOr(value: JsonValue | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
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
