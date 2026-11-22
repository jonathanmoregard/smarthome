import type { Effect, EffectName } from '../effect.ts';
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
export type LampLight = { power: 'off' } | OnLight;
