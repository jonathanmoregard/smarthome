import type { RangeMark, Ranged } from './range.ts';

/** A lamp's brightness as a Zigbee level: a whole number, 1..254 (0 is off). */
export type Level = Ranged<'Level'>;
/** A share of full, 0..100. */
export type Percent = Ranged<'Percent'>;
/**
 * A colour temperature in kelvin, 1000..10000: the dashboard accepts
 * 100..1000 mireds (`native-controls.ts`), which is that range in kelvin.
 */
export type Kelvin = Ranged<'Kelvin'>;
/** A span of percents, its low end not above its high end (a switch's range). */
export type PercentRange = { readonly low: Percent; readonly high: Percent } & RangeMark<'PercentRange'>;
