/**
 * The scaling algebra: fixed Day/Cosy/Night anchors interpolated by position.
 *
 * Pure domain. Nothing here takes or returns JSON — the parsers that turn a
 * document into an {@link Anchor} or {@link Color} live in `src/parse/scale.ts`,
 * and `isObject`/`object` moved to `src/runtime/parse.ts`.
 */
import { ParseError } from '../runtime/parse.ts';

export type RGB = [number, number, number];
export type Color = ({ kelvin: number; rgb?: never } | { rgb: RGB; kelvin?: never });
export function mixColor(a: Color, b: Color, amount: number): Color {
  if (amount <= 0) return copyColor(a);
  if (amount >= 1) return copyColor(b);
  if (a.kelvin !== undefined && b.kelvin !== undefined) return { kelvin: a.kelvin + (b.kelvin - a.kelvin) * amount };
  const x = rgbValue(a), y = rgbValue(b);
  return { rgb: [0, 1, 2].map(i => roundEven(x[i]! + (y[i]! - x[i]!) * amount)) as RGB };
}
/**
 * Copy a `Color`, raising if its numbers are not finite.
 *
 * This replaces the in-domain calls to `canonicalColor`, which used to sit here
 * and took an unparsed value. The copy matters (callers must not alias an anchor's
 * colour) but **so does the raise, and it is not dead code**: a non-finite
 * position reaches it. `clamp(NaN, -2, 2)` is `NaN`, because `Math.max`/
 * `Math.min` propagate it, so no branch of {@link scaleValue} matches, and
 * `mixColor(..., NaN)` yields `{kelvin: NaN}`. Both call sites happen to be
 * NaN-proof today — `resolution.ts:201` guards with `boundedNumber(p)` and
 * `effects_scale` parses `position` with `requireNumber`, which rejects
 * non-finite — but swapping this for a bare copy would delete the guard that
 * keeps `NaN` out of an MQTT payload, so the raise is kept deliberately rather
 * than by inertia.
 */
export function copyColor(color: Color): Color {
  if (!finiteColor(color)) {
    throw new ParseError(`${COLOR_SHAPE_MESSAGE}${JSON.stringify(color) ?? 'undefined'}`);
  }
  return color.kelvin !== undefined ? { kelvin: color.kelvin } : { rgb: [...color.rgb] };
}
/** Does an already-typed `Color` carry finite numbers? */
export function finiteColor(color: Color): boolean {
  return color.kelvin !== undefined ? boundedNumber(color.kelvin) : color.rgb.every(boundedNumber);
}
export const WARM_END: RGB = [255, 126, 0];
export const CROSSOVER: Color = { rgb: [255, 134, 7] };

export function rgbValue(color: Color): RGB {
  if (color.rgb) return [...color.rgb];
  const t = color.kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * ((t - 60) ** -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * ((t - 60) ** -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [roundEven(clamp(r, 0, 255)), roundEven(clamp(g, 0, 255)), roundEven(clamp(b, 0, 255))];
}
/** Python/Jinja round uses ties to even; Math.round uses ties toward +infinity. */
export function roundEven(value: number): number {
  const lower = Math.floor(value);
  const remainder = value - lower;
  return remainder === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value);
}
export type Anchor = { brightness: number; color: Color };
/** Message shared with `parse/scale.ts`, so a raise reads the same wherever it fires. */
export const COLOR_SHAPE_MESSAGE = 'color must be {kelvin} or {rgb:[r,g,b]} with finite numbers, got ';

/**
 * Copy an `Anchor`, raising if its numbers are not finite. The domain-typed
 * counterpart of `parse/scale.ts`'s `anchor()`, for the places that already
 * hold an `Anchor` and need an unaliased one — `compileGradient` stores its
 * anchors in a persisted curve, so it must not keep a reference to its
 * caller's.
 */
export function copyAnchor(a: Anchor): Anchor {
  if (!boundedNumber(a.brightness)) {
    throw new ParseError(`${ANCHOR_BRIGHTNESS_MESSAGE}${JSON.stringify(a.brightness) ?? 'undefined'}`);
  }
  return { brightness: a.brightness, color: copyColor(a.color) };
}

/** Past the day end (`p > 1`): brighter towards 255 and cooler towards 6500 K. Reads only the day end. */
function aboveDay(day: Anchor, p: number): Anchor {
  return { brightness: day.brightness + (255 - day.brightness) * (p - 1), color: mixColor(day.color, { kelvin: 6500 }, p - 1) };
}
/** Message shared with `parse/scale.ts`, so a raise reads the same wherever it fires. */
export const ANCHOR_BRIGHTNESS_MESSAGE = 'anchor.brightness must be a finite number, got ';

export type Scaled = Anchor & { position: number };
/** `effects_scale`'s arguments, parsed in `src/parse/scale.ts`. */
export type ScaleRequest = { day: Anchor; cosy: Anchor; position: number; warmEnd: RGB };
/**
 * One end of the cosy <-> day blend: the scene's light for the lamp, which is
 * either lit (a level and a colour) or off. Off carries neither: off is a
 * state that cannot carry a colour (2026-11-20).
 */
export type BlendEnd = { on: false } | ({ on: true } & Anchor);
/** A point on the blend: lit with a level and colour, or off. */
export type Blended = { on: false; position: number } | ({ on: true } & Scaled);
export function boundedNumber(value: unknown): value is number {
  return typeof value === 'number' && value > -1e20 && value < 1e20;
}
/**
 * The cosy <-> day blend at `position` (cosy at 0, day at 1).
 *
 * Two lit ends: exactly {@link scaleValue}. One end off (2026-11-20, "Remote
 * blend towards an off scene"): the colour is the lit end's only; between the
 * ends the level ramps from {@link OFF_END_LEVEL} at the off end to the lit
 * end's level; at the off end and anywhere past it the lamp is off. Past the
 * lit end the existing rule for that side applies (above day reads only the day
 * end; below cosy reads the off day end as {@link OFF_END_LEVEL}). Both ends
 * off: `undefined`, there is nothing to blend and the lamp is skipped.
 */
export function blend(day: BlendEnd, cosy: BlendEnd, position: number, warmEnd: RGB = WARM_END): Blended | undefined {
  if (day.on && cosy.on) return { on: true, ...scaleValue(day, cosy, position, warmEnd) };
  const p = clamp(position, -2, 2);
  if (day.on) {
    if (p <= 0) return { on: false, position: p };
    if (p >= 1) return { on: true, ...scaled(p === 1 ? day : aboveDay(day, p), p) };
    return { on: true, ...scaled({ brightness: ramp(day.brightness, p), color: day.color }, p) };
  }
  if (cosy.on) {
    if (p >= 1) return { on: false, position: p };
    if (p <= 0) return { on: true, ...scaled(p === 0 ? cosy : belowCosy(cosy, OFF_END_LEVEL, p, warmEnd), p) };
    return { on: true, ...scaled({ brightness: ramp(cosy.brightness, 1 - p), color: cosy.color }, p) };
  }
  return undefined;
}
export function scaleValue(day: Anchor, cosy: Anchor, position: number, warmEnd: RGB = WARM_END): Scaled {
  const p = clamp(position, -2, 2);
  if (p === 0) return scaled(cosy, p);
  if (p === 1) return scaled(day, p);
  if (p > 1) return scaled(aboveDay(day, p), p);
  if (p > 0) {
    return scaled({ brightness: cosy.brightness + (day.brightness - cosy.brightness) * p, color: mixColor(cosy.color, day.color, p) }, p);
  }
  return scaled(belowCosy(cosy, day.brightness, p, warmEnd), p);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
function scaled(value: Anchor, p: number): Scaled {
  return { brightness: clamp(value.brightness, 0, 255), color: copyColor(value.color), position: p };
}

/**
 * The level an off end stands for: the ramp from an off end starts here, and
 * where a rule needs an off end's (or an off lamp's) level to place a position,
 * it reads this. The lowest level a lit bulb shows.
 */
export const OFF_END_LEVEL = 1;

/**
 * Past the cosy end (`p < 0`): dimmer towards a floor and warmer towards the
 * warm end. Reads the cosy end, and the day end's level only for the slope.
 */
function belowCosy(cosy: Anchor, dayLevel: number, p: number, warmEnd: RGB): Anchor {
  const floor = Math.min(76.5, cosy.brightness);
  const slope = Math.max(0, dayLevel - cosy.brightness, (cosy.brightness - floor) / 2);
  return {
    brightness: Math.max(floor, cosy.brightness + p * slope),
    color: p <= -1 ? mixColor(CROSSOVER, { rgb: warmEnd }, -p - 1)
      : cosy.color.kelvin !== undefined && cosy.color.kelvin >= 1950
        ? { kelvin: cosy.color.kelvin + (1950 - cosy.color.kelvin) * -p }
        : mixColor(cosy.color, CROSSOVER, -p),
  };
}

/**
 * Up from {@link OFF_END_LEVEL} towards `level`, `t` of the way (0 at the off end, 1 at the lit end).
 * Shared by the remote blend (unrounded) and a scheduled off -> on fade (rounded), so the two agree.
 */
export function ramp(level: number, t: number): number { return OFF_END_LEVEL + (level - OFF_END_LEVEL) * t; }
