/**
 * The id and range constructors: the only place a wire string becomes a
 * domain id, or a number a range type.
 *
 * Only the parse steps call them (`src/parse/*.ts` and `parseCatalog`). They
 * check nothing and return their input unchanged: whatever the parse step
 * already checked about the string still holds, and nothing is added. Whether
 * an id names something the registry knows is a later, named unit.
 */
import type { BulbId, EffectName, LampId, PowerTarget, RemoteId, RemoteSource, RoomId, SavedOverlayKey, SwitchId, UserId }
  from '../domain/types/ids.ts';
import type { Brightness, ColourChannel, Kelvin, Level, Percent, PercentRange } from '../domain/types/light.ts';
import type { Instant, Seconds, TimeOfDay, Timezone } from '../domain/types/time.ts';
import type { Step } from '../domain/types/remote.ts';
import type { Minutes } from '../domain/types/overlay.ts';
import type { Progress } from '../domain/types/schedule.ts';
import { ParseError } from '../runtime/parse.ts';

export function toRoomId(raw: string): RoomId {
  // Cast: the edge read this string as a room; this is the one place that says so.
  return raw as RoomId;
}

export function toLampId(raw: string): LampId {
  // Cast: the edge read this string as a lamp; this is the one place that says so.
  return raw as LampId;
}

export function toBulbId(raw: string): BulbId {
  // Cast: the edge read this string as a bulb; this is the one place that says so.
  return raw as BulbId;
}

export function toSwitchId(raw: string): SwitchId {
  // Cast: the edge read this string as a switch; this is the one place that says so.
  return raw as SwitchId;
}

export function toPowerTarget(raw: string): PowerTarget {
  // Cast: the edge read this string as a lamp or switch a power toggle names; this is the one place that says so.
  return raw as PowerTarget;
}

export function toRemoteId(raw: string): RemoteId {
  // Cast: the edge read this string as a remote; this is the one place that says so.
  return raw as RemoteId;
}

export function toUserId(raw: string): UserId {
  // Cast: the edge read this string as a user; this is the one place that says so.
  return raw as UserId;
}

export function toEffectName(raw: string): EffectName {
  // Cast: the edge read this string as a catalog effect; this is the one place that says so.
  return raw as EffectName;
}

/*
 * The overlay key ids. These two check: each refuses the text another overlay
 * key's shape claims, so `overlayKeyText` and `parseOverlayKey` stay exact
 * inverses (`src/domain/types/overlay.ts`).
 */

export function toRemoteSource(raw: string): RemoteSource {
  if (raw.startsWith('ui:') || raw.startsWith('native:')) {
    throw new ParseError(`A remote source must not begin 'ui:' or 'native:' (a dashboard or native control's key), got ${raw}`);
  }
  // Cast: checked just above; this is the one place a string becomes a remote source.
  return raw as RemoteSource;
}

export function toSavedOverlayKey(raw: string): SavedOverlayKey {
  if (raw === '' || raw === 'mode:sara' || raw.startsWith('block:') || raw.startsWith('channels:')) {
    throw new ParseError(`A saved overlay key of no known shape must not have a known shape, got '${raw}'`);
  }
  // Cast: checked just above; this is the one place a string becomes a saved overlay key.
  return raw as SavedOverlayKey;
}

export function toLevel(raw: number): Level {
  inRange(raw, 1, 254, 'A level');
  if (!Number.isInteger(raw)) throw new ParseError(`A level must be a whole number, got ${raw}`);
  // Cast: checked just above; this is the one place a number becomes a level.
  return raw as Level;
}

function inRange(raw: number, low: number, high: number, what: string): void {
  if (!within(raw, low, high)) throw new ParseError(`${what} must be ${low}..${high}, got ${raw}`);
}

const PERCENT = { low: 0, high: 100 };
const STEP = { low: -20, high: 20 };

/*
 * Range constructors. Unlike the id constructors these check: a value outside
 * its range raises a ParseError. Where a saved value is read, the caller picks
 * a named default instead of calling one with a value that may be out of range.
 */

function within(raw: number, low: number, high: number): boolean {
  return Number.isFinite(raw) && raw >= low && raw <= high;
}

export function toBrightness(raw: number): Brightness {
  inRange(raw, 0, 255, 'A brightness');
  if (!Number.isInteger(raw)) throw new ParseError(`A brightness must be a whole number, got ${raw}`);
  // Cast: checked just above; this is the one place a number becomes a brightness.
  return raw as Brightness;
}

export function toKelvin(raw: number): Kelvin {
  inRange(raw, 1000, 10000, 'A colour temperature in kelvin');
  // Cast: checked just above; this is the one place a number becomes kelvin.
  return raw as Kelvin;
}

export function toProgress(raw: number): Progress {
  inRange(raw, 0, 1, 'A transition progress');
  // Cast: checked just above; this is the one place a number becomes a progress.
  return raw as Progress;
}

export function toMinutes(raw: number): Minutes {
  inRange(raw, 0, Infinity, 'A count of minutes');
  // Cast: checked just above; this is the one place a number becomes minutes.
  return raw as Minutes;
}

/** A remote's step range: two step bounds, `min` not above `max`. */
export function stepBoundsOf(min: unknown, max: unknown): { min: Step; max: Step } | undefined {
  const low = stepOf(min), high = stepOf(max);
  return low !== undefined && high !== undefined && low <= high ? { min: low, max: high } : undefined;
}

/*
 * Lenient range readers, for saved and argument values: the range type when
 * the value is in range, none otherwise. They never raise; each read site
 * names its own fallback for none.
 */

/** A remote step bound: a number (not a boolean) that is finite and within -20..20. */
export function stepOf(raw: unknown): Step | undefined {
  return typeof raw === 'number' && within(raw, STEP.low, STEP.high) ? toStep(raw) : undefined;
}

export function toStep(raw: number): Step {
  inRange(raw, STEP.low, STEP.high, 'A remote step bound');
  // Cast: checked just above; this is the one place a number becomes a step bound.
  return raw as Step;
}

/** A percent range: two numbers (not booleans) within 0..100, `low` not above `high`. */
export function percentRangeOf(low: unknown, high: unknown): PercentRange | undefined {
  const inPercent = (raw: unknown): raw is number => typeof raw === 'number' && within(raw, PERCENT.low, PERCENT.high);
  return inPercent(low) && inPercent(high) && low <= high ? toPercentRange(low, high) : undefined;
}

export function toPercentRange(low: number, high: number): PercentRange {
  const range = { low: toPercent(low), high: toPercent(high) };
  if (range.low > range.high) throw new ParseError(`A percent range must not run backwards, got ${low}..${high}`);
  // Cast: both ends checked just above; this is the one place two percents become a range.
  return range as PercentRange;
}

export function toPercent(raw: number): Percent {
  inRange(raw, PERCENT.low, PERCENT.high, 'A percent');
  // Cast: checked just above; this is the one place a number becomes a percent.
  return raw as Percent;
}

export function toColourChannel(raw: number): ColourChannel {
  inRange(raw, 0, 255, 'A colour channel');
  // Cast: checked just above; this is the one place a number becomes a colour channel.
  return raw as ColourChannel;
}

export function toInstant(raw: number): Instant {
  inRange(raw, -Infinity, Infinity, 'An instant');
  // Cast: checked just above; this is the one place a number becomes an instant.
  return raw as Instant;
}

export function toSeconds(raw: number): Seconds {
  inRange(raw, 0, Infinity, 'A duration in seconds');
  // Cast: checked just above; this is the one place a number becomes seconds.
  return raw as Seconds;
}

/*
 * The two fades. They sit here, not beside `Transition`, because a `Seconds`
 * is built only by `toSeconds` and the domain may not import this file or cast;
 * M2 hands them to the domain through the config.
 */

/** The fade of a change a person makes. */
export const MANUAL_FADE: Seconds = toSeconds(0.2);
/** The fade into an effect's start. */
export const EFFECT_START_FADE: Seconds = toSeconds(0.4);

export function toTimeOfDay(hour: number, minute: number): TimeOfDay {
  inRange(hour, 0, 23, 'An hour');
  inRange(minute, 0, 59, 'A minute');
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new ParseError(`A time of day must be whole hours and minutes, got ${hour}:${minute}`);
  }
  // Cast: both checked just above; this is the one place two numbers become a time of day.
  return { hour: hour as TimeOfDay['hour'], minute: minute as TimeOfDay['minute'] };
}

export function toTimezone(raw: string): Timezone {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
  } catch {
    throw new ParseError(`A timezone must be an IANA zone id, got '${raw}'`);
  }
  // Cast: checked just above; this is the one place a string becomes a timezone.
  return raw as Timezone;
}
