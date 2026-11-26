/**
 * The blend between a room's cosy and day light: where a remote's brighter and
 * dimmer presses move a lamp, 0 at cosy, 1 at day, and beyond both, dimmer and
 * warmer below cosy and brighter and cooler above day.
 *
 * Moved from `src/legacy/domain/scale.ts` (`blend`, `scaleValue`); the
 * compiled gradient of `src/legacy/domain/gradient.ts` computed the same curve
 * piece by piece and cached it, and folds in here with no cache. The level
 * comes out whole, rounded half to even, as it was when sent.
 */
import type { EffectName } from './effect.ts';
import type { Brightness, Colour, RGB, SceneLight } from './types/light.ts';
import type { BlendPosition } from './types/range.ts';
import { brightnessOrThrow, colourChannelOrThrow, kelvinOrThrow, progressOrThrow } from './types/range.ts';
import type { Progress } from './types/schedule.ts';

/** One end of the blend: the block's light for the lamp, lit or off. */
export type BlendEnd = SceneLight;

/**
 * The light at a position on the blend.
 *
 * Two lit ends: the curve between them, and past them. One end off
 * (2026-11-20, "Remote blend towards an off scene"): the colour is the lit
 * end's only; between the ends the level ramps up from {@link OFF_END_LEVEL}
 * at the off end to the lit end's; at the off end and past it the lamp is
 * off. Past the lit end its own rule applies (above day reads only the day
 * end; below cosy reads the off day end as {@link OFF_END_LEVEL}). Both ends
 * off, or a lit end with no colour: undefined, there is nothing to blend.
 *
 * The light runs the effect of the end the position is nearer (day from the
 * middle up); beside an off end, the lit end's.
 */
export function blend(day: BlendEnd, cosy: BlendEnd, position: BlendPosition, warmEnd: RGB): SceneLight | undefined {
  const p: number = position;
  if (day.power === 'on' && cosy.power === 'on') {
    if (day.colour === undefined || cosy.colour === undefined) return undefined;
    const dayEnd: Anchor = { brightness: day.brightness, colour: day.colour };
    const cosyEnd: Anchor = { brightness: cosy.brightness, colour: cosy.colour };
    return litAt(onTheCurve(dayEnd, cosyEnd, p, warmEnd), p < 0.5 ? cosy.effect : day.effect);
  }
  if (day.power === 'on') {
    if (day.colour === undefined) return undefined;
    const dayEnd: Anchor = { brightness: day.brightness, colour: day.colour };
    if (p <= 0) return OFF;
    if (p >= 1) return litAt(p === 1 ? dayEnd : aboveDay(dayEnd, p), day.effect);
    return litAt({ brightness: rampUp(day.brightness, progressOrThrow(p)), colour: day.colour }, day.effect);
  }
  if (cosy.power === 'on') {
    if (cosy.colour === undefined) return undefined;
    const cosyEnd: Anchor = { brightness: cosy.brightness, colour: cosy.colour };
    if (p >= 1) return OFF;
    if (p <= 0) return litAt(p === 0 ? cosyEnd : belowCosy(cosyEnd, OFF_END_LEVEL, p, warmEnd), cosy.effect);
    return litAt({ brightness: rampUp(cosy.brightness, progressOrThrow(1 - p)), colour: cosy.colour }, cosy.effect);
  }
  return undefined;
}

/**
 * Up from {@link OFF_END_LEVEL} towards `level`, `t` of the way (0 at the off
 * end, 1 at the lit end), rounded half to even. Shared by the blend beside an
 * off end and a scheduled fade out of an off block, so the two agree.
 */
export function rampUp(level: Brightness, t: Progress): Brightness {
  return brightnessOrThrow(roundEven(OFF_END_LEVEL + (level - OFF_END_LEVEL) * t));
}

/** A point on the curve before it becomes a light: the level is not yet whole. */
type Anchor = { brightness: number; colour: Colour };

/** Two lit ends: cosy at 0, day at 1, straight between them, and the rules past each end. */
function onTheCurve(day: Anchor, cosy: Anchor, p: number, warmEnd: RGB): Anchor {
  if (p === 0) return cosy;
  if (p === 1) return day;
  if (p > 1) return aboveDay(day, p);
  if (p > 0) {
    return { brightness: cosy.brightness + (day.brightness - cosy.brightness) * p, colour: mixColour(cosy.colour, day.colour, progressOrThrow(p)) };
  }
  return belowCosy(cosy, day.brightness, p, warmEnd);
}

/** Past the day end (`p > 1`): brighter towards 255 and cooler towards 6500 K. Reads only the day end. */
function aboveDay(day: Anchor, p: number): Anchor {
  return { brightness: day.brightness + (255 - day.brightness) * (p - 1), colour: mixColour(day.colour, COOL_END, progressOrThrow(p - 1)) };
}

/**
 * Past the cosy end (`p < 0`): dimmer towards a floor and warmer towards the
 * warm end. Reads the cosy end, and the day end's level only for the slope.
 */
function belowCosy(cosy: Anchor, dayLevel: number, p: number, warmEnd: RGB): Anchor {
  const floor = Math.min(76.5, cosy.brightness);
  const slope = Math.max(0, dayLevel - cosy.brightness, (cosy.brightness - floor) / 2);
  return {
    brightness: Math.max(floor, cosy.brightness + p * slope),
    colour: p <= -1 ? mixColour(CROSSOVER, { kind: 'rgb', rgb: warmEnd }, progressOrThrow(-p - 1))
      : cosy.colour.kind === 'kelvin' && cosy.colour.kelvin >= 1950
        ? { kind: 'kelvin', kelvin: kelvinOrThrow(cosy.colour.kelvin + (1950 - cosy.colour.kelvin) * -p) }
        : mixColour(cosy.colour, CROSSOVER, progressOrThrow(-p)),
  };
}

/** A point on the curve as a lit light: the level held to 0..255 and rounded half to even. */
function litAt(point: Anchor, effect: EffectName): SceneLight {
  return { power: 'on', brightness: brightnessOrThrow(roundEven(clamp(point.brightness, 0, 255))), colour: point.colour, effect };
}

/** `amount` of the way from `a` to `b`. Two colour temperatures mix in kelvin; anything else mixes as RGB, channel by channel. */
export function mixColour(a: Colour, b: Colour, amount: Progress): Colour {
  if (amount <= 0) return a;
  if (amount >= 1) return b;
  if (a.kind === 'kelvin' && b.kind === 'kelvin') return { kind: 'kelvin', kelvin: kelvinOrThrow(a.kelvin + (b.kelvin - a.kelvin) * amount) };
  const x = asRgb(a), y = asRgb(b);
  const channel = (from: number, to: number) => colourChannelOrThrow(roundEven(from + (to - from) * amount));
  return { kind: 'rgb', rgb: { red: channel(x.red, y.red), green: channel(x.green, y.green), blue: channel(x.blue, y.blue) } };
}

/** A colour as RGB: a colour temperature by the usual black-body approximation, each channel held to 0..255 and rounded half to even. */
function asRgb(colour: Colour): RGB {
  if (colour.kind === 'rgb') return colour.rgb;
  const t = colour.kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * ((t - 60) ** -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * ((t - 60) ** -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const channel = (value: number) => colourChannelOrThrow(roundEven(clamp(value, 0, 255)));
  return { red: channel(r), green: channel(g), blue: channel(b) };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Python's and Jinja's `round`: halves go to the even neighbour, where `Math.round` takes them up. */
export function roundEven(value: number): number {
  const lower = Math.floor(value);
  const remainder = value - lower;
  return remainder === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value);
}

/**
 * The level an off end stands for: the ramp from an off end starts here, and
 * where a rule needs an off end's level to place a position, it reads this.
 * The lowest level a lit bulb shows.
 */
export const OFF_END_LEVEL: Brightness = brightnessOrThrow(1);

const OFF: SceneLight = { power: 'off' };

/** Where the curve above day cools to. */
const COOL_END: Colour = { kind: 'kelvin', kelvin: kelvinOrThrow(6500) };

/** Where the curve below cosy turns from the cosy colour to the warm end, at -1. */
const CROSSOVER: Colour = { kind: 'rgb', rgb: { red: colourChannelOrThrow(255), green: colourChannelOrThrow(134), blue: colourChannelOrThrow(7) } };
