import type { RangeMark, Ranged } from './range.ts';

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
