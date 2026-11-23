/**
 * The id constructors, and the parse layer's range wrappers: the only place a
 * wire string becomes a domain id. A number becomes a range type in
 * `src/domain/types/range.ts`; the wrappers here call it.
 *
 * Only the parse steps call them (`src/parse/*.ts` and `parseCatalog`). The id
 * constructors check nothing and return their input unchanged: whatever the
 * parse step already checked about the string still holds, and nothing is
 * added. Whether an id names something the registry knows is a later, named unit.
 */
import type { BulbId, DashboardControlId, LampId, RemoteId, RemoteSource, RoomId, SwitchId, UserId } from '../domain/types/ids.ts';
import type { SavedOverlayKey } from '../adapter/codecs/overlay-key.ts';
import type { CatalogEffectName } from '../runtime/catalog.ts';
import type { MqttTopic } from '../adapter/encode.ts';
import type { Brightness, BrightnessStep, ColourChannel, Kelvin, Level, Percent, PercentRange } from '../domain/types/light.ts';
import type { Instant, Seconds, TimeOfDay, Timezone } from '../domain/types/time.ts';
import type { Step, StepCount } from '../domain/types/remote.ts';
import type { Minutes } from '../domain/types/range.ts';
import type { Progress } from '../domain/types/schedule.ts';
import {
  brightnessOrThrow, brightnessStepOrThrow, colourChannelOrThrow, instantOrThrow, isWithin, kelvinOrThrow, levelOrThrow,
  minutesOrThrow, percentOrThrow,
  percentRangeOrThrow, PERCENT_BOUNDS, progressOrThrow, secondsOrThrow, stepCountOrThrow, stepOrThrow, STEP_BOUNDS, timeOfDayOrThrow,
} from '../domain/types/range.ts';
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

export function toRemoteId(raw: string): RemoteId {
  // Cast: the edge read this string as a remote; this is the one place that says so.
  return raw as RemoteId;
}

export function toUserId(raw: string): UserId {
  // Cast: the edge read this string as a user; this is the one place that says so.
  return raw as UserId;
}

export function toMqttTopic(raw: string): MqttTopic {
  // Cast: the edge read this string as a Zigbee2MQTT command topic; this is the one place that says so.
  return raw as MqttTopic;
}

export function toCatalogEffectName(raw: string): CatalogEffectName {
  // Cast: the edge read this string as a catalog effect; this is the one place that says so.
  return raw as CatalogEffectName;
}

export function toDashboardControlId(raw: string): DashboardControlId {
  // Cast: the edge read this string as a dashboard control; this is the one place that says so.
  return raw as DashboardControlId;
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

/*
 * Range constructors. Each wraps the domain's checked constructor
 * (`src/domain/types/range.ts`, the one place the type is minted) and turns its
 * RangeError into a ParseError, so a value outside its range raises as a parse
 * failure. Where a saved value is read, the caller picks a named default
 * instead of calling one with a value that may be out of range.
 */

export function toLevel(raw: number): Level {
  return asParseError(() => levelOrThrow(raw));
}

export function toBrightness(raw: number): Brightness {
  return asParseError(() => brightnessOrThrow(raw));
}

export function toBrightnessStep(raw: number): BrightnessStep {
  return asParseError(() => brightnessStepOrThrow(raw));
}

export function toKelvin(raw: number): Kelvin {
  return asParseError(() => kelvinOrThrow(raw));
}

export function toProgress(raw: number): Progress {
  return asParseError(() => progressOrThrow(raw));
}

export function toMinutes(raw: number): Minutes {
  return asParseError(() => minutesOrThrow(raw));
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
  return typeof raw === 'number' && isWithin(raw, STEP_BOUNDS.low, STEP_BOUNDS.high) ? toStep(raw) : undefined;
}

export function toStep(raw: number): Step {
  return asParseError(() => stepOrThrow(raw));
}

export function toStepCount(raw: number): StepCount {
  return asParseError(() => stepCountOrThrow(raw));
}

/** A percent range: two numbers (not booleans) within 0..100, `low` not above `high`. */
export function percentRangeOf(low: unknown, high: unknown): PercentRange | undefined {
  const inPercent = (raw: unknown): raw is number => typeof raw === 'number' && isWithin(raw, PERCENT_BOUNDS.low, PERCENT_BOUNDS.high);
  return inPercent(low) && inPercent(high) && low <= high ? toPercentRange(low, high) : undefined;
}

export function toPercentRange(low: number, high: number): PercentRange {
  return asParseError(() => percentRangeOrThrow(low, high));
}

export function toPercent(raw: number): Percent {
  return asParseError(() => percentOrThrow(raw));
}

export function toColourChannel(raw: number): ColourChannel {
  return asParseError(() => colourChannelOrThrow(raw));
}

export function toInstant(raw: number): Instant {
  return asParseError(() => instantOrThrow(raw));
}

export function toSeconds(raw: number): Seconds {
  return asParseError(() => secondsOrThrow(raw));
}

export function toTimeOfDay(hour: number, minute: number): TimeOfDay {
  return asParseError(() => timeOfDayOrThrow(hour, minute));
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

/** Run a domain range constructor; its RangeError becomes the ParseError a parse step raises. */
function asParseError<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) throw new ParseError(error.message);
    throw error;
  }
}
