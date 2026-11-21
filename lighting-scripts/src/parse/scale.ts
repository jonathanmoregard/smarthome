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
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { ParseError, isObject, object, requireNumber } from '../runtime/parse.ts';
import type { Anchor, BlendEnd, Color, RGB, ScaleArgs } from '../domain/scale.ts';
import { ANCHOR_BRIGHTNESS_MESSAGE, COLOR_SHAPE_MESSAGE, WARM_END, boundedNumber, copyColor } from '../domain/scale.ts';

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

/**
 * One end of the cosy <-> day blend as a target document spells it.
 *
 * `{on: false}` is a scene that has the lamp off: no level, no colour. Any
 * other mapping is a lit anchor, parsed by {@link anchor}, which raises on a
 * malformed one exactly as before. A lit anchor whose level is fine but which
 * carries no `color` is a scene Home Assistant reports without a colour (an on
 * light in a brightness-only mode): there is no colour to blend, so it is
 * `undefined`, and the caller treats the pair as it treats a missing anchor.
 */
export function blendEnd(value: JsonValue | undefined): BlendEnd | undefined {
  const a = object(value);
  if (a.on === false) return { on: false };
  if (a.color === undefined && boundedNumber(a.brightness)) return undefined;
  return { on: true, ...anchor(value) };
}

export function validColor(color: unknown, minimum = 1000, maximum = 10000): color is Color {
  if (!isObject(color)) return false;
  if ('kelvin' in color && !('rgb' in color)) {
    return typeof color.kelvin === 'number' && color.kelvin >= minimum && color.kelvin <= maximum;
  }
  return !('kelvin' in color) && Array.isArray(color.rgb) && color.rgb.length === 3 &&
    color.rgb.every(v => typeof v === 'number' && v >= 0 && v <= 255);
}

/**
 * An `[r,g,b]` triple of finite numbers, or none for anything else. The
 * lenient half of {@link requireRgb}, for colours read back from Home
 * Assistant (2026-11-21: a value a person can edit recovers). Never raises.
 */
export function rgbTripleOf(value: JsonValue | undefined): RGB | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [r, g, b] = value;
  return boundedNumber(r) && boundedNumber(g) && boundedNumber(b) ? [r, g, b] : undefined;
}

/** Parse an `[r,g,b]` triple. The captured source reads `warm_end` raw, so the oracle raises on anything else. */
export function requireRgb(value: JsonValue | undefined, context = 'rgb'): RGB {
  const rgb = rgbTripleOf(value);
  if (rgb === undefined) throw new ParseError(`${context} must be [r, g, b] with finite numbers, got ${JSON.stringify(value) ?? 'undefined'}`);
  return rgb;
}

/**
 * The candle test lamp's warm end, a light a person sets from a dashboard. The
 * captured scripts read it as
 * `state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0]`, so
 * an absent attribute, Home Assistant's null and every other Jinja-falsy value
 * take {@link WARM_END}. A value that is not an rgb triple -- where the captured
 * `| list` or the triple read raises -- takes {@link WARM_END} too (2026-11-21:
 * a value a person can edit recovers to a default). Never raises.
 */
export function warmEndRgb(value: JsonValue | undefined): RGB {
  const rgb = rgbTripleOf(value);
  return rgb === undefined ? [...WARM_END] : rgb;
}

/**
 * `effects_scale`'s arguments. Every field's primitive is chosen from the
 * captured source: `day`, `cosy`, `position` and `warm_end` are all read raw
 * there (52, 52, 34 and 32 sites, no `| int`, `| float` or `| default`), so the
 * oracle raises on a malformed value and the strict readers are the faithful
 * choice. `warm_end` falls back to the field default only when absent.
 */
export function parseScaleArgs(args: JsonObject): ScaleArgs {
  return {
    day: anchor(args.day),
    cosy: anchor(args.cosy),
    position: requireNumber(args, 'position', 'effects_scale'),
    warmEnd: args.warm_end === undefined ? WARM_END : requireRgb(args.warm_end, 'effects_scale.warm_end'),
  };
}
