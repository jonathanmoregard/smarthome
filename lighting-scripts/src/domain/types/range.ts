/**
 * A number held to a range. Each range type is built only by its constructor
 * in this file (or, for a value read off the wire, by the `to...` wrapper in
 * `src/parse/ids.ts`, which calls it), so a value of the type is in range by
 * construction and nothing re-checks it.
 *
 * Every constructor throws a `RangeError` for a value outside its range, which
 * its name says. Where a saved value is read, the caller picks a named default
 * instead of calling one with a value that may be out of range.
 */
import type { BlendPosition } from '../blend.ts';
import type { Brightness, ColourChannel, Kelvin, Level, Percent, PercentRange } from './light.ts';
import type { Minutes } from './overlay.ts';
import type { Step, StepCount } from './remote.ts';
import type { Progress } from './schedule.ts';
import type { Instant, Seconds, TimeOfDay } from './time.ts';

declare const range: unique symbol;
export type Ranged<Name extends string> = number & { readonly [range]: Name };
/** The same mark on a value that is not a number (`PercentRange`). */
export type RangeMark<Name extends string> = { readonly [range]: Name };

export const PERCENT_BOUNDS = { low: 0, high: 100 };
export const STEP_BOUNDS = { low: -20, high: 20 };

export function levelOrThrow(raw: number): Level {
  mustBeWithin(raw, 1, 254, 'A level');
  mustBeWhole(raw, 'A level');
  // Cast: checked just above; this is the one place a number becomes a level.
  return raw as Level;
}

export function brightnessOrThrow(raw: number): Brightness {
  mustBeWithin(raw, 0, 255, 'A brightness');
  mustBeWhole(raw, 'A brightness');
  // Cast: checked just above; this is the one place a number becomes a brightness.
  return raw as Brightness;
}

export function kelvinOrThrow(raw: number): Kelvin {
  mustBeWithin(raw, 1000, 10000, 'A colour temperature in kelvin');
  // Cast: checked just above; this is the one place a number becomes kelvin.
  return raw as Kelvin;
}

export function progressOrThrow(raw: number): Progress {
  mustBeWithin(raw, 0, 1, 'A transition progress');
  // Cast: checked just above; this is the one place a number becomes a progress.
  return raw as Progress;
}

export function blendPositionOrThrow(raw: number): BlendPosition {
  mustBeWithin(raw, -2, 2, 'A blend position');
  // Cast: checked just above; this is the one place a number becomes a blend position.
  return raw as BlendPosition;
}

export function minutesOrThrow(raw: number): Minutes {
  mustBeWithin(raw, 0, Infinity, 'A count of minutes');
  // Cast: checked just above; this is the one place a number becomes minutes.
  return raw as Minutes;
}

export function stepOrThrow(raw: number): Step {
  mustBeWithin(raw, STEP_BOUNDS.low, STEP_BOUNDS.high, 'A remote step bound');
  // Cast: checked just above; this is the one place a number becomes a step bound.
  return raw as Step;
}

export function stepCountOrThrow(raw: number): StepCount {
  mustBeWithin(raw, -40, 40, 'A count of remote steps');
  // Cast: checked just above; this is the one place a number becomes a step count.
  return raw as StepCount;
}

export function percentRangeOrThrow(low: number, high: number): PercentRange {
  const range = { low: percentOrThrow(low), high: percentOrThrow(high) };
  if (range.low > range.high) throw new RangeError(`A percent range must not run backwards, got ${low}..${high}`);
  // Cast: both ends checked just above; this is the one place two percents become a range.
  return range as PercentRange;
}

export function percentOrThrow(raw: number): Percent {
  mustBeWithin(raw, PERCENT_BOUNDS.low, PERCENT_BOUNDS.high, 'A percent');
  // Cast: checked just above; this is the one place a number becomes a percent.
  return raw as Percent;
}

export function colourChannelOrThrow(raw: number): ColourChannel {
  mustBeWithin(raw, 0, 255, 'A colour channel');
  // Cast: checked just above; this is the one place a number becomes a colour channel.
  return raw as ColourChannel;
}

export function instantOrThrow(raw: number): Instant {
  mustBeWithin(raw, -Infinity, Infinity, 'An instant');
  // Cast: checked just above; this is the one place a number becomes an instant.
  return raw as Instant;
}

export function secondsOrThrow(raw: number): Seconds {
  mustBeWithin(raw, 0, Infinity, 'A duration in seconds');
  // Cast: checked just above; this is the one place a number becomes seconds.
  return raw as Seconds;
}

export function timeOfDayOrThrow(hour: number, minute: number): TimeOfDay {
  mustBeWithin(hour, 0, 23, 'An hour');
  mustBeWithin(minute, 0, 59, 'A minute');
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new RangeError(`A time of day must be whole hours and minutes, got ${hour}:${minute}`);
  }
  // Cast: both checked just above; this is the one place two numbers become a time of day.
  return { hour: hour as TimeOfDay['hour'], minute: minute as TimeOfDay['minute'] };
}

function mustBeWithin(raw: number, low: number, high: number, what: string): void {
  if (!isWithin(raw, low, high)) throw new RangeError(`${what} must be ${low}..${high}, got ${raw}`);
}

/** Is the number finite and within the bounds, both ends included? */
export function isWithin(raw: number, low: number, high: number): boolean {
  return Number.isFinite(raw) && raw >= low && raw <= high;
}

function mustBeWhole(raw: number, what: string): void {
  if (!Number.isInteger(raw)) throw new RangeError(`${what} must be a whole number, got ${raw}`);
}
