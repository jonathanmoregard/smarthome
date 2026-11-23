import type { Effect, EffectName } from './effect.ts';
import type { RangeMark, Ranged } from './range.ts';
import type { Seconds } from './time.ts';

/** A lamp's brightness as a Zigbee level: a whole number, 1..254 (0 is off). */
export type Level = Ranged<'Level'>;
/**
 * A light's brightness as Home Assistant states it: a whole number, 0..255.
 * Not a {@link Level}: Home Assistant's full is 255, which today's scripts send
 * as is, while a Zigbee level stops at 254.
 */
export type Brightness = Ranged<'Brightness'>;
/**
 * A change of brightness a person asks for, in Home Assistant's 0..255 steps:
 * -255..255, positive is brighter. Not necessarily whole: a percent step
 * comes to a fraction of 255.
 */
export type BrightnessStep = Ranged<'BrightnessStep'>;
/** A share of full, 0..100. */
export type Percent = Ranged<'Percent'>;
/**
 * A colour temperature in kelvin, 1000..10000: the dashboard accepts
 * 100..1000 mireds (`native-controls.ts`), which is that range in kelvin.
 */
export type Kelvin = Ranged<'Kelvin'>;
/** A span of percents, its low end not above its high end (a switch's range). */
export type PercentRange = { readonly low: Percent; readonly high: Percent } & RangeMark<'PercentRange'>;
/** One colour channel, 0..255, finite. Not whole: a blend can land between two values. */
export type ColourChannel = Ranged<'ColourChannel'>;
export type RGB = { readonly red: ColourChannel; readonly green: ColourChannel; readonly blue: ColourChannel };
export type Colour = { kind: 'kelvin'; kelvin: Kelvin } | { kind: 'rgb'; rgb: RGB };

/** Two colours, or two missing ones, the same: the same kelvin, or the same three channels. */
export function sameColour(a: Colour | undefined, b: Colour | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'kelvin') return b.kind === 'kelvin' && a.kelvin === b.kelvin;
  return b.kind === 'rgb' && a.rgb.red === b.rgb.red && a.rgb.green === b.rgb.green && a.rgb.blue === b.rgb.blue;
}
export type Power = 'on' | 'off';
/**
 * How a lamp moves to its light: one step of a scheduled fade, or a change
 * made at once. Starting the candle has no case of its own: the lighting state
 * cannot know what a bulb already shows, so the reconciler picks the effect
 * start's fade from its own record.
 */
export type Transition = { kind: 'scheduled fade'; over: Seconds } | { kind: 'manual' };
/**
 * A light as a block or a profile saves it. Brightness is HA's 0..255, as saved; M2 turns it into a Level where today's code does.
 * The effect belongs to the lit light: a block's light can run the candle. Off has no level, colour or effect.
 */
export type SceneLight = { power: 'off' } | { power: 'on'; brightness: Brightness; colour: Colour | undefined; effect: EffectName };
/**
 * A lit lamp. `colour` is undefined only where the schedule names no colour
 * for the lamp in any block: each bulb then keeps the colour it shows, and the
 * reconciler sends the level alone.
 */
export type OnLight = { power: 'on'; level: Level; colour: Colour | undefined; effect: Effect; transition: Transition };
/**
 * An unlit lamp, and how it goes off: with the manual fade, or switched at
 * once by its room's power (the remote's toggle or a room's control), as
 * today's `homeassistant.turn_off` does.
 */
export type OffLight = { power: 'off'; transition: { kind: 'manual' } | { kind: 'switch' } };
export type LampLight = OffLight | OnLight;
