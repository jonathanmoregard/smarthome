import type { JsonObject, JsonValue } from '../runtime/context.ts';

export type RGB = [number, number, number];
export type Color = ({ kelvin: number; rgb?: never } | { rgb: RGB; kelvin?: never }) & JsonObject;
export interface Anchor extends JsonObject { brightness: number; color: Color }
export interface Scaled extends Anchor { position: number }
export const WARM_END: RGB = [255, 126, 0];
export const CROSSOVER: Color = { rgb: [255, 134, 7] };

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function object(value: unknown): JsonObject { return isObject(value) ? value : {}; }
export function boundedNumber(value: unknown): value is number {
  return typeof value === 'number' && value > -1e20 && value < 1e20;
}
export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
/** Python/Jinja round uses ties to even; Math.round uses ties toward +infinity. */
export function roundEven(value: number): number {
  const lower = Math.floor(value);
  const remainder = value - lower;
  return remainder === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value);
}
export function canonicalColor(color: JsonValue | undefined): Color {
  const c = object(color);
  if ('kelvin' in c) return { kelvin: c.kelvin as number };
  return { rgb: [...c.rgb as RGB] };
}
export function anchor(value: JsonValue | undefined): Anchor {
  const a = object(value);
  return { brightness: a.brightness as number, color: canonicalColor(a.color) };
}
export function validColor(color: unknown, minimum = 1000, maximum = 10000): color is Color {
  if (!isObject(color)) return false;
  if ('kelvin' in color && !('rgb' in color)) {
    return typeof color.kelvin === 'number' && color.kelvin >= minimum && color.kelvin <= maximum;
  }
  return !('kelvin' in color) && Array.isArray(color.rgb) && color.rgb.length === 3 &&
    color.rgb.every(v => typeof v === 'number' && v >= 0 && v <= 255);
}
export function rgbValue(color: Color): RGB {
  if (color.rgb) return [...color.rgb];
  const t = color.kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * ((t - 60) ** -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * ((t - 60) ** -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [roundEven(clamp(r, 0, 255)), roundEven(clamp(g, 0, 255)), roundEven(clamp(b, 0, 255))];
}
export function mixColor(a: Color, b: Color, amount: number): Color {
  if (amount <= 0) return canonicalColor(a);
  if (amount >= 1) return canonicalColor(b);
  if (a.kelvin !== undefined && b.kelvin !== undefined) return { kelvin: a.kelvin + (b.kelvin - a.kelvin) * amount };
  const x = rgbValue(a), y = rgbValue(b);
  return { rgb: [0, 1, 2].map(i => roundEven(x[i]! + (y[i]! - x[i]!) * amount)) as RGB };
}
export function scaleValue(day: Anchor, cosy: Anchor, position: number, warmEnd: RGB = WARM_END): Scaled {
  const p = clamp(position, -2, 2);
  let brightness: number, color: Color;
  if (p === 0) { brightness = cosy.brightness; color = cosy.color; }
  else if (p === 1) { brightness = day.brightness; color = day.color; }
  else if (p > 1) {
    brightness = day.brightness + (255 - day.brightness) * (p - 1);
    color = mixColor(day.color, { kelvin: 6500 }, p - 1);
  } else if (p > 0) {
    brightness = cosy.brightness + (day.brightness - cosy.brightness) * p;
    color = mixColor(cosy.color, day.color, p);
  } else {
    const floor = Math.min(76.5, cosy.brightness);
    const slope = Math.max(0, day.brightness - cosy.brightness, (cosy.brightness - floor) / 2);
    brightness = Math.max(floor, cosy.brightness + p * slope);
    color = p <= -1 ? mixColor(CROSSOVER, { rgb: warmEnd }, -p - 1)
      : cosy.color.kelvin !== undefined && cosy.color.kelvin >= 1950
        ? { kelvin: cosy.color.kelvin + (1950 - cosy.color.kelvin) * -p }
        : mixColor(cosy.color, CROSSOVER, -p);
  }
  return { brightness: clamp(brightness, 0, 255), color: canonicalColor(color), position: p };
}
