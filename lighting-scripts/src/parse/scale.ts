/**
 * Parsers that turn an unparsed document into the scaling algebra's domain
 * types.
 *
 * This is the `src/parse/` layer: it may name JSON and it may import the
 * domain, and the domain may import it for the handler boundaries that still
 * read raw arguments. The domain itself names no JSON. Keeping these functions
 * out of `domain/scale.ts` is what lets that module reach zero.
 *
 * Every raise here reproduces one the oracle performs. The deployed Jinja reads
 * these values raw — all 52 `day.brightness` / `cosy.brightness` reads in the
 * captured source apply no filter — so a malformed value raises `TypeError`
 * there. Casting instead used to let JavaScript coerce:
 * `canonicalColor({kelvin: 'hot'})` returned a `Color` whose `kelvin` was a
 * string, and `canonicalColor({})` threw an opaque
 * `TypeError: c.rgb is not iterable`. Both fail as a named `ParseError` now.
 */
import type { JsonValue } from '../runtime/context.ts';
import { ParseError, isObject, object } from '../runtime/parse.ts';
import type { Anchor, Color, RGB } from '../domain/scale.ts';
import { ANCHOR_BRIGHTNESS_MESSAGE, COLOR_SHAPE_MESSAGE, boundedNumber, copyColor } from '../domain/scale.ts';

/**
 * Shape of a `Color` without imposing any call-site's kelvin range — exactly
 * one of `kelvin` or `rgb`, carrying finite numbers. {@link validColor} keeps
 * the stricter range-checking contract its own callers rely on.
 */
export function colorShape(value: unknown): value is Color {
  if (!isObject(value)) return false;
  if ('kelvin' in value) return !('rgb' in value) && boundedNumber(value.kelvin);
  return Array.isArray(value.rgb) && value.rgb.length === 3 && value.rgb.every(boundedNumber);
}

/**
 * Parse a color instead of asserting one. Delegates the copy and the
 * finite-number check to {@link copyColor}, so the invariant has one definition
 * and the raise reads identically whether it fires at the boundary or inside
 * the algebra.
 */
export function canonicalColor(color: JsonValue | undefined): Color {
  if (!colorShape(color)) {
    throw new ParseError(`${COLOR_SHAPE_MESSAGE}${JSON.stringify(color) ?? 'undefined'}`);
  }
  return copyColor(color);
}

/**
 * Parse an anchor instead of asserting one. A brightness arriving as the string
 * `"80"` previously kept its string type under a `number` declaration, which
 * made `scaleValue` return 255 at position 0.5 and NaN below zero.
 */
export function anchor(value: JsonValue | undefined): Anchor {
  const a = object(value);
  if (!boundedNumber(a.brightness)) {
    throw new ParseError(`${ANCHOR_BRIGHTNESS_MESSAGE}${JSON.stringify(a.brightness) ?? 'undefined'}`);
  }
  return { brightness: a.brightness, color: canonicalColor(a.color) };
}

export function validColor(color: unknown, minimum = 1000, maximum = 10000): color is Color {
  if (!isObject(color)) return false;
  if ('kelvin' in color && !('rgb' in color)) {
    return typeof color.kelvin === 'number' && color.kelvin >= minimum && color.kelvin <= maximum;
  }
  return !('kelvin' in color) && Array.isArray(color.rgb) && color.rgb.length === 3 &&
    color.rgb.every(v => typeof v === 'number' && v >= 0 && v <= 255);
}

/** Parse an `[r,g,b]` triple. The captured source reads `warm_end` raw, so the oracle raises on anything else. */
export function requireRgb(value: JsonValue | undefined, context = 'rgb'): RGB {
  if (Array.isArray(value) && value.length === 3) {
    const [r, g, b] = value;
    if (boundedNumber(r) && boundedNumber(g) && boundedNumber(b)) return [r, g, b];
  }
  throw new ParseError(`${context} must be [r, g, b] with finite numbers, got ${JSON.stringify(value) ?? 'undefined'}`);
}
