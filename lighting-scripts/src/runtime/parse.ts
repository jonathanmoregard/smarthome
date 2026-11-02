/**
 * Boundary parsers that mirror Home Assistant's Jinja semantics exactly.
 *
 * Every function here names the Jinja expression it reproduces. The semantics
 * were measured against this repository's own Home Assistant 2026.7.4 /
 * Jinja 3.1.6 closure, not inferred; see `docs/jinja-coercion-table.md` for the
 * generated table and `tests/runtime/parse.test.ts` for the measured rows
 * encoded as assertions.
 *
 * The reason this module exists: **JavaScript's implicit coercion is not
 * equivalent to Jinja's, and where they differ Jinja is usually stricter.**
 * `"80" + 120` is a TypeError in Jinja and the string `"80120"` in JavaScript;
 * `missing + 1` raises `UndefinedError` in Jinja and yields `NaN` in
 * JavaScript. Casting an untrusted value to `number` and letting arithmetic
 * coerce therefore produces results the oracle would never produce. Parse at
 * the boundary with these functions instead of asserting a type.
 */
import type { JsonObject, JsonValue } from './context.ts';

/** Python `float(str)` grammar: no hex, no thousands separators, inf/nan allowed. */
const PYTHON_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?(?:\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|(?:\d(?:_?\d)*)\.(?:\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;
/** Python `int(str, 10)` grammar: digits only, so `"1e3"` and `"0x10"` fail here. */
const PYTHON_INT = /^[+-]?\d(?:_?\d)*$/;

function pythonFloat(text: string): number | undefined {
  const trimmed = text.trim();
  if (!PYTHON_FLOAT.test(trimmed)) return undefined;
  const bare = trimmed.replace(/_/g, '');
  if (/inf(inity)?$/i.test(bare)) return bare.startsWith('-') ? -Infinity : Infinity;
  if (/nan$/i.test(bare)) return NaN;
  return Number(bare);
}

/**
 * `{{ value | int(fallback) }}`
 *
 * Jinja tries `int(value)` and then `int(float(value))`, falling back when both
 * raise. Consequences worth knowing, all measured:
 * - never returns `NaN` or `±Infinity` — `"inf" | int` is the fallback
 * - `"1e3" | int` is `1000` (via the float path), so `parseInt` is wrong here
 * - `"0x10" | int` is the fallback, while JavaScript's `Number("0x10")` is `16`
 * - `none`, arrays and objects take the fallback; `true` is `1`, `false` is `0`
 * - floats truncate toward zero, so `5.7 | int` is `5`
 */
export function jinjaInt(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (PYTHON_INT.test(trimmed)) return Number(trimmed.replace(/_/g, ''));
  const parsed = pythonFloat(trimmed);
  return parsed !== undefined && Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * `{{ value | float(fallback) }}`
 *
 * Jinja calls `float(value)` and falls back only on `TypeError`/`ValueError`.
 * Unlike {@link jinjaInt} this **can** return `±Infinity` or `NaN`, because
 * `float("inf")` and `float("nan")` succeed in Python. That difference is the
 * reason `frames.ts` and `native-controls.ts` historically disagreed about
 * `number("Infinity")`: each matched a different Jinja filter.
 */
export function jinjaFloat(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return fallback;
  const parsed = pythonFloat(value);
  return parsed === undefined ? fallback : parsed;
}

/**
 * `{{ value | string }}`
 *
 * Python's `str()`, so `none` renders as `"None"` and booleans as
 * `"True"`/`"False"` — not JavaScript's `"null"`/`"true"`/`"false"`.
 *
 * Two limits, deliberately not faked: Python's float repr keeps the decimal
 * point (`str(5.0)` is `"5.0"`, JavaScript's `String(5.0)` is `"5"`), and
 * Python container repr uses single quotes. This function is for scalars whose
 * integer-ness is not in question; render containers through a `tojson`
 * equivalent rather than relying on it.
 */
export function jinjaString(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value) ?? 'None';
}

/**
 * `{{ true if value else false }}` — Python truthiness.
 *
 * Diverges from JavaScript in three ways that matter:
 * - `[]` and `{}` are **falsy** in Python, truthy in JavaScript
 * - `NaN` is **truthy** in Python (`bool(float("nan"))` is `True`), falsy in JS
 * - `" "` is truthy in both, but `""` is falsy in both
 *
 * So `if (someArray)` and `if (someObject)` in TypeScript do not reproduce a
 * Jinja `{% if %}` on the same value. Use this instead.
 */
export function jinjaTruthy(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isNaN(value) ? true : value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

/** Raised where Jinja would raise `UndefinedError` or `TypeError` rather than coerce. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * `{{ container.key }}` used in an arithmetic or comparison position.
 *
 * Jinja raises `UndefinedError: 'dict object' has no attribute 'key'` as soon
 * as a missing key is used; JavaScript yields `undefined` and then silently
 * produces `NaN`. These `require*` helpers fail loudly so a malformed snapshot
 * surfaces as an error instead of a wrong brightness. Use the `jinja*`
 * coercions above wherever the original template applied an explicit filter or
 * `| default(...)`, and these where it did not.
 */
export function requireNumber(container: JsonObject, key: string, context = 'value'): number {
  const value = container[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ParseError(`${context}.${key} must be a finite number, got ${describe(value)}`);
  }
  return value;
}

export function requireString(container: JsonObject, key: string, context = 'value'): string {
  const value = container[key];
  if (typeof value !== 'string') {
    throw new ParseError(`${context}.${key} must be a string, got ${describe(value)}`);
  }
  return value;
}

export function requireObject(container: JsonObject, key: string, context = 'value'): JsonObject {
  const value = container[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParseError(`${context}.${key} must be an object, got ${describe(value)}`);
  }
  return value;
}

export function requireArray(container: JsonObject, key: string, context = 'value'): JsonValue[] {
  const value = container[key];
  if (!Array.isArray(value)) {
    throw new ParseError(`${context}.${key} must be an array, got ${describe(value)}`);
  }
  return value;
}

/** A bounded, non-throwing number in the inclusive range, else a ParseError. */
export function requireRange(container: JsonObject, key: string, low: number, high: number, context = 'value'): number {
  const value = requireNumber(container, key, context);
  if (value < low || value > high) {
    throw new ParseError(`${context}.${key} must be within [${low}, ${high}], got ${value}`);
  }
  return value;
}

function describe(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return `${typeof value} ${JSON.stringify(value)}`;
}
