import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { anchor, boundedNumber, canonicalColor, clamp, CROSSOVER, isObject, object, rgbValue, roundEven, validColor, WARM_END } from './scale.ts';
import type { Anchor, Color, RGB, Scaled } from './scale.ts';

export type GradientPiece = ({ kind: 'kelvin'; start: number; delta: number } | { kind: 'rgb'; start: RGB; delta: RGB }) & { left: Color; right: Color } & JsonObject;
export interface GradientCurve extends JsonObject {
  version: number;
  day: Anchor;
  cosy: Anchor;
  brightness: { floor: number; lower: number; middle: number; upper: number };
  colors: { lower: GradientPiece; middle: GradientPiece; upper: GradientPiece; tail: GradientPiece };
}
export interface GradientEntry extends JsonObject { signature: JsonValue[]; curve: GradientCurve }
export function gradientSignature(day: Anchor, cosy: Anchor, warmEnd: RGB): JsonValue[] {
  return [1, day.brightness, canonicalColor(day.color), cosy.brightness, canonicalColor(cosy.color), [...warmEnd]];
}
function compilePiece(left: Color, right: Color): GradientPiece {
  const a = canonicalColor(left), b = canonicalColor(right);
  if (a.kelvin !== undefined && b.kelvin !== undefined) return { left: a, right: b, kind: 'kelvin', start: a.kelvin, delta: b.kelvin - a.kelvin };
  const x = rgbValue(a), y = rgbValue(b);
  return { left: a, right: b, kind: 'rgb', start: x, delta: [y[0] - x[0], y[1] - x[1], y[2] - x[2]] };
}
export function compileGradient(day: Anchor, cosy: Anchor, warmEnd: RGB): GradientCurve {
  const floor = Math.min(76.5, cosy.brightness);
  const lower = cosy.color.kelvin !== undefined && cosy.color.kelvin >= 1950 ? { kelvin: 1950 } : CROSSOVER;
  return {
    version: 1, day: anchor(day), cosy: anchor(cosy),
    brightness: { floor, lower: Math.max(0, day.brightness - cosy.brightness, (cosy.brightness - floor) / 2), middle: day.brightness - cosy.brightness, upper: 255 - day.brightness },
    colors: { lower: compilePiece(cosy.color, lower), middle: compilePiece(cosy.color, day.color), upper: compilePiece(day.color, { kelvin: 6500 }), tail: compilePiece(CROSSOVER, { rgb: warmEnd }) },
  };
}
function validGradientColor(value: unknown): boolean {
  return validColor(value, 0, 1e20) && (value.kelvin === undefined || (value.kelvin > 0 && value.kelvin < 1e20));
}
/** Validate stored shape/anchor identity without repeating Kelvin conversion on cache hits. */
export function validGradient(entry: unknown, signature: JsonValue[]): entry is GradientEntry {
  if (!isObject(entry) || !isDeepStrictEqual(entry.signature, signature) || !isObject(entry.curve)) return false;
  const c = entry.curve;
  if (c.version !== 1 || !isObject(c.day) || !isObject(c.cosy) || !isObject(c.brightness) || !isObject(c.colors)) return false;
  if (c.day.brightness !== signature[1] || !isDeepStrictEqual(c.day.color, signature[2]) || c.cosy.brightness !== signature[3] || !isDeepStrictEqual(c.cosy.color, signature[4])) return false;
  if (!['floor', 'lower', 'middle', 'upper'].every(name => boundedNumber(object(c.brightness)[name]))) return false;
  for (const name of ['lower', 'middle', 'upper', 'tail']) {
    const p = c.colors[name];
    if (!isObject(p) || !validGradientColor(p.left) || !validGradientColor(p.right)) return false;
    for (const field of ['start', 'delta']) {
      const v = p[field];
      if (p.kind === 'kelvin') { if (!boundedNumber(v)) return false; }
      else if (p.kind === 'rgb') { if (!Array.isArray(v) || v.length !== 3 || !v.every(boundedNumber)) return false; }
      else return false;
    }
  }
  return true;
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
export function planGradients(args: JsonObject): { gradients: Record<string, GradientEntry> } {
  const gradients: Record<string, GradientEntry> = {};
  const cache = object(args.cached);
  const warmEnd = (args.warm_end ?? WARM_END) as RGB;
  for (const [target, item] of Object.entries(object(args.base))) {
    if (!isObject(item) || !isObject(item.day) || !isObject(item.cosy)) continue;
    const day = anchor(item.day), cosy = anchor(item.cosy);
    const signature = gradientSignature(day, cosy, warmEnd);
    const cached = cache[target];
    gradients[target] = validGradient(cached, signature) ? cached : { signature, curve: compileGradient(day, cosy, warmEnd) };
  }
  return { gradients };
}
