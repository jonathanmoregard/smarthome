/**
 * The lenient and semi-lenient accessors the domain used to call on raw JSON.
 *
 * They lived in `domain/schedule.ts` and nine domain modules imported them from
 * there. They are parse-layer tools -- each takes a `JsonValue` and decides
 * what it means -- so they live here now. `schedule.ts` keeps a temporary
 * re-export until every importer has been repointed (criterion 7's close-out
 * deletes it). Moved unchanged: every message, fallback and raise is the same.
 */
import type { JsonObject, JsonValue, ScriptContext } from '../runtime/context.ts';
import { ParseError, requireArray, requireFinite, requireObject, requireString } from '../runtime/parse.ts';

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
  if (!Number.isFinite(ts)) throw new ParseError(`schedule timestamp must be a finite epoch or date string, got ${JSON.stringify(value) ?? 'undefined'}`);
  return ts;
}
export function optionalTimestamp(value: JsonValue | undefined): number | undefined {
  return value === undefined || value === null ? undefined : timestamp(value);
}
export function saved(ctx: ScriptContext, entity: string): JsonObject {
  const state = ctx.get(entity);
  // Home Assistant uses these sentinel states when an input_text has no value;
  // malformed present JSON is a corrupt profile, not another absence spelling.
  if (state === 'unknown' || state === 'unavailable') return {};
  let parsed: JsonValue;
  try { parsed = JSON.parse(state) as JsonValue; }
  catch { throw new ParseError(`${entity} must contain a valid JSON object`); }
  return requireObject({ parsed }, 'parsed', entity);
}
