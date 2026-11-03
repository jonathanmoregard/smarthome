/**
 * Compiling and sampling the gradient curve.
 *
 * Pure domain. The validator for a persisted curve and the `effects_gradient_plan`
 * argument parsing live in `src/parse/gradient.ts`, which is what lets this
 * module name no JSON.
 */
import { clamp, copyAnchor, copyColor, CROSSOVER, rgbValue, roundEven } from './scale.ts';
import type { Anchor, Color, RGB, Scaled } from './scale.ts';

export type GradientPiece = ({ kind: 'kelvin'; start: number; delta: number } | { kind: 'rgb'; start: RGB; delta: RGB }) & { left: Color; right: Color };
export type GradientCurve = {
  version: number;
  day: Anchor;
  cosy: Anchor;
  brightness: { floor: number; lower: number; middle: number; upper: number };
  colors: { lower: GradientPiece; middle: GradientPiece; upper: GradientPiece; tail: GradientPiece };
};
/**
 * The cache key. It is compared with `isDeepStrictEqual` and **persisted**, so
 * its element order and element types are observable — hence a fixed-length
 * tuple rather than a list of loose values. `1` is the format version.
 */
export type GradientSignature = [number, number, Color, number, Color, RGB];
export type GradientEntry = { signature: GradientSignature; curve: GradientCurve };
/** `effects_gradient_plan`'s result. One entry per target that compiled. */
export type GradientPlanResult = { gradients: Record<string, GradientEntry> };
export function gradientSignature(day: Anchor, cosy: Anchor, warmEnd: RGB): GradientSignature {
  return [1, day.brightness, copyColor(day.color), cosy.brightness, copyColor(cosy.color), [...warmEnd]];
}
function compilePiece(left: Color, right: Color): GradientPiece {
  const a = copyColor(left), b = copyColor(right);
  if (a.kelvin !== undefined && b.kelvin !== undefined) return { left: a, right: b, kind: 'kelvin', start: a.kelvin, delta: b.kelvin - a.kelvin };
  const x = rgbValue(a), y = rgbValue(b);
  return { left: a, right: b, kind: 'rgb', start: x, delta: [y[0] - x[0], y[1] - x[1], y[2] - x[2]] };
}
export function compileGradient(day: Anchor, cosy: Anchor, warmEnd: RGB): GradientCurve {
  const floor = Math.min(76.5, cosy.brightness);
  const lower = cosy.color.kelvin !== undefined && cosy.color.kelvin >= 1950 ? { kelvin: 1950 } : CROSSOVER;
  return {
    version: 1, day: copyAnchor(day), cosy: copyAnchor(cosy),
    brightness: { floor, lower: Math.max(0, day.brightness - cosy.brightness, (cosy.brightness - floor) / 2), middle: day.brightness - cosy.brightness, upper: 255 - day.brightness },
    colors: { lower: compilePiece(cosy.color, lower), middle: compilePiece(cosy.color, day.color), upper: compilePiece(day.color, { kelvin: 6500 }), tail: compilePiece(CROSSOVER, { rgb: warmEnd }) },
  };
}
function samplePiece(piece: GradientPiece, amount: number): Color {
  if (amount <= 0) return piece.left;
  if (amount >= 1) return piece.right;
  if (piece.kind === 'kelvin') return { kelvin: piece.start + piece.delta * amount };
  return { rgb: [0, 1, 2].map(i => roundEven(piece.start[i]! + piece.delta[i]! * amount)) as RGB };
}
export function sampleGradient(curve: GradientCurve, position: number): Scaled {
  const p = clamp(position, -2, 2);
  let brightness: number, color: Color;
  if (p === 0) { brightness = curve.cosy.brightness; color = curve.cosy.color; }
  else if (p === 1) { brightness = curve.day.brightness; color = curve.day.color; }
  else if (p > 1) { brightness = curve.day.brightness + curve.brightness.upper * (p - 1); color = samplePiece(curve.colors.upper, p - 1); }
  else if (p > 0) { brightness = curve.cosy.brightness + curve.brightness.middle * p; color = samplePiece(curve.colors.middle, p); }
  else {
    brightness = Math.max(curve.brightness.floor, curve.cosy.brightness + p * curve.brightness.lower);
    color = p <= -1 ? samplePiece(curve.colors.tail, -p - 1) : samplePiece(curve.colors.lower, -p);
  }
  return { brightness: clamp(brightness, 0, 255), color, position: p };
}
