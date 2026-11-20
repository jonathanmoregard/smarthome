/**
 * The id and range constructors: the only place a wire string becomes a
 * domain id, or a number a range type.
 *
 * Only the parse steps call them (`src/parse/*.ts` and `parseCatalog`). They
 * check nothing and return their input unchanged: whatever the parse step
 * already checked about the string still holds, and nothing is added. Whether
 * an id names something the registry knows is a later, named unit.
 */
import type { BulbId, EffectName, LampId, RemoteId, RoomId, SwitchId, UserId } from '../domain/types/ids.ts';
import type { Kelvin, Level, Percent, PercentRange } from '../domain/types/light.ts';
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
 * Range constructors. Unlike the id constructors these check: a value outside
 * its range raises a ParseError. Where a saved value is read, the caller picks
 * a named default instead of calling one with a value that may be out of range.
 */

function inRange(raw: number, low: number, high: number, what: string): void {
  if (!(Number.isFinite(raw) && raw >= low && raw <= high)) throw new ParseError(`${what} must be ${low}..${high}, got ${raw}`);
}

export function toLevel(raw: number): Level {
  inRange(raw, 1, 254, 'A level');
  if (!Number.isInteger(raw)) throw new ParseError(`A level must be a whole number, got ${raw}`);
  // Cast: checked just above; this is the one place a number becomes a level.
  return raw as Level;
}

export function toPercent(raw: number): Percent {
  inRange(raw, 0, 100, 'A percent');
  // Cast: checked just above; this is the one place a number becomes a percent.
  return raw as Percent;
}

export function toPercentRange(low: number, high: number): PercentRange {
  const range = { low: toPercent(low), high: toPercent(high) };
  if (range.low > range.high) throw new ParseError(`A percent range must not run backwards, got ${low}..${high}`);
  // Cast: both ends checked just above; this is the one place two percents become a range.
  return range as PercentRange;
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
