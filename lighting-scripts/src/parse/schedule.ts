/**
 * Parsing for `ls_base` / `ls_room_base`: the stored override records the
 * schedule reads, the saved `input_text` profiles, and the Home Assistant
 * entity states and attributes behind a lamp's profile and the schedule's
 * timing.
 *
 * Records are read leniently, as `object(record)` read them: a non-mapping
 * record has no facts. Every fact compared by identity is a stored fact, and
 * the three `String(...)` coercions the schedule applies to stored values
 * (`kind`, `target`, a block override's `value`) are computed here, on the
 * stored value, exactly as JavaScript did inline -- and only when read, since
 * `String()` of a stored mapping can raise. Reads that can raise -- a
 * record's `when`, a `period_updated`, a saved profile's `own`/`on`, an rgb
 * component -- are functions the domain calls where the inline read sat.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { jinjaList, jinjaOr, jinjaTruthy, object, parsePythonNumeric, requireObject, requireString } from '../runtime/parse.ts';
import type { Block } from '../domain/blocks.ts';
import type { LampProfile, LampSample, ScheduledBaseArgs } from '../domain/schedule.ts';
import { isBlock } from './blocks.ts';
import { asTimestampOr, num, saved, testNow } from './accessors.ts';
import { haBooleanOr } from './state-store.ts';
import { storedFact } from './overrides.ts';
import type { StoredFact, StoredValue } from './overrides.ts';

/**
 * A stored override record as the schedule reads it. Saved state, so every
 * read is lenient and typed with a named default (directive 2026-11-19) and
 * none raises. Facts compared with `==` stay stored facts, so they compare as
 * the stored value does: a one-element list is never equal to a string.
 */
export interface ScheduleRecord {
  /** Does the stored record hold any key? */
  present: boolean;
  kind: StoredFact;
  scope: StoredFact;
  target: StoredFact;
  /** `target` when it is text, which is all an area lookup or room match can use; else no target. */
  targetName: string | undefined;
  via: StoredFact;
  /** The captured `as_timestamp(when, 0)`: {@link NO_WHEN} for anything but date text. */
  when(): number;
  /** `value.period`, when it is a block. */
  period: Block | undefined;
  /** `value` itself, when it is a block. */
  valueBlock: Block | undefined;
  /** The captured `value | string | lower` where it can match a block: text whose lower case is a block. */
  valueFolded: Block | undefined;
  /**
   * The captured `value.get('period_updated', as_timestamp(when, 0)) | float`:
   * absent is {@link when}; a value Python's `float()` reads is that number;
   * anything else (where the captured filter raises) takes the named default,
   * the absent spelling -- the record's own {@link when}.
   */
  periodStamp(): number;
}

/** A saved `when` that is not date text: the captured `as_timestamp(when, 0)` default. */
export const NO_WHEN = 0;

function scheduleRecord(raw: JsonValue | undefined): ScheduleRecord {
  const r = object(raw), value = object(r.value);
  const when = (): number => asTimestampOr(r.when, NO_WHEN);
  const folded = typeof r.value === 'string' ? r.value.toLowerCase() : undefined;
  return {
    present: Object.keys(r).length > 0,
    kind: storedFact(r.kind),
    scope: storedFact(r.scope),
    target: storedFact(r.target),
    targetName: typeof r.target === 'string' ? r.target : undefined,
    via: storedFact(r.via),
    when,
    period: isBlock(value.period) ? value.period : undefined,
    valueBlock: isBlock(r.value) ? r.value : undefined,
    valueFolded: isBlock(folded) ? folded : undefined,
    periodStamp: () => {
      const stamp = value.period_updated === undefined ? undefined : parsePythonNumeric(value.period_updated);
      return stamp === undefined ? when() : stamp;
    },
  };
}

/** The stored override records. */
export interface ScheduleRecords {
  /** The keys, in stored order. */
  keys: string[];
  /** A record by key, read leniently: a missing key is an empty record. */
  get(key: string): ScheduleRecord;
}

function scheduleRecords(records: JsonObject): ScheduleRecords {
  return { keys: Object.keys(records), get: key => scheduleRecord(records[key]) };
}

/** `sensor.ls_overrides`'s `overrides`, read leniently: a non-mapping is `{}`. */
export function storedScheduleRecords(value: JsonValue | undefined): ScheduleRecords {
  return scheduleRecords(object(value));
}

/** A saved `input_text` lamp profile; never raises (see `saved()`). */
export interface SavedProfile {
  /** Captured `.get('own', false)` used as a condition: Jinja truthiness, absent read as false. */
  own: boolean;
  /**
   * A plug's power, captured `.get('on', false) | bool`: absent is false,
   * otherwise Home Assistant's bool filter. A value the filter rejects (where
   * the captured filter raises) takes the named default {@link PLUG_OFF}.
   */
  on: boolean;
  effect: StoredFact;
  effectChannels: StoredFact;
}

/** A saved plug power the bool filter rejects: off (lenient saved-value directive). */
export const PLUG_OFF = false;

export function savedProfile(ctx: HouseView, entity: string): SavedProfile {
  const profile = saved(ctx, entity);
  return {
    own: profile.own === undefined ? false : jinjaTruthy(profile.own),
    on: profile.on === undefined ? false : haBooleanOr(profile.on, PLUG_OFF),
    effect: storedFact(profile.effect),
    effectChannels: storedFact(profile.effect_channels),
  };
}

/**
 * A light's `rgb_color`, read as the captured `(rgb_color or [255,255,255]) | list`.
 * Home Assistant reports `null` for a lamp that is off, so the Jinja-falsy
 * default is the ordinary path; a truthy value goes through Jinja's `list`.
 */
function sampledRgb(ctx: HouseView, entity: string): StoredValue[] {
  return jinjaList(jinjaOr(ctx.attr(entity, 'rgb_color'), [255, 255, 255]), `${entity}.rgb_color`).map(value => storedFact(value));
}

/**
 * A light entity's brightness and colour, as the schedule samples it. The
 * captured profile macro reads `rgb_color` only in its non-colour-temp arm.
 */
export function entityProfile(ctx: HouseView, entity: string): LampProfile {
  return { brightness: Math.trunc(num(ctx.attr(entity, 'brightness'), 255)), color: ctx.attr(entity, 'color_mode') === 'color_temp'
    ? { kelvin: Math.trunc(num(ctx.attr(entity, 'color_temp_kelvin'), 3000)) }
    : { rgb: sampledRgb(ctx, entity) } };
}

/** {@link entityProfile}, plus the entity's on state and its rgb, which the captured sample always reads. */
export function entitySample(ctx: HouseView, entity: string): LampSample {
  const profile = entityProfile(ctx, entity);
  // `on` is `=== 'on'`, so it is always a real boolean — never absent, never a
  // falsy stand-in. That is what lets every downstream `target.on` read be a
  // boolean test by construction rather than a truthiness gamble.
  return { ...profile, on: ctx.get(entity) === 'on', rgb: sampledRgb(ctx, entity) };
}

/** One component of a sampled rgb triple, as a schedule number. */
export function rgbComponent(rgb: StoredValue[], index: number): number {
  return num(rgb[index]);
}

/** An entity's state as a schedule number; HA's no-value states read as `fallback`. */
export function stateNumber(ctx: HouseView, entity: string, fallback: number): number {
  return num(ctx.get(entity), fallback);
}

/** An entity attribute as a required schedule number. */
export function attributeNumber(ctx: HouseView, entity: string, key: string): number {
  return num(ctx.attr(entity, key));
}

/**
 * Captured test_now/overrides are guarded by definition before use; reason
 * and room_only use Undefined-only defaults; debug is definition- and truth-tested.
 * Present optional values are parsed, while null overrides retain the
 * producer's explicit "use the state attribute" spelling.
 */
/** `ls_base`'s arguments. `room_only` is read first, as the inline parse read it. */
export function parseBaseArgs(args: JsonObject): ScheduledBaseArgs {
  const roomOnly = args.room_only === undefined ? '' : requireString(args, 'room_only', 'ls_base');
  return parseScheduledBaseArgs(args, 'ls_base', roomOnly);
}

/**
 * `ls_room_base`'s arguments. The captured script declaration marks `room`
 * required, and it drives entity names, comparisons and indexing rather than
 * iteration or membership; it is read first.
 */
export function parseRoomBaseArgs(args: JsonObject): ScheduledBaseArgs {
  const room = requireString(args, 'room', 'ls_room_base');
  return parseScheduledBaseArgs(args, 'ls_room_base', room);
}

function parseScheduledBaseArgs(args: JsonObject, context: string, roomOnly: string): ScheduledBaseArgs {
  return {
    testNow: testNow(args.test_now),
    reason: args.reason === undefined ? 'config' : requireString(args, 'reason', context),
    overrides: args.overrides === undefined || args.overrides === null
      ? undefined
      : scheduleRecords(requireObject(args, 'overrides', context)),
    roomOnly,
    // Captured `debug is defined and debug`: definition and Jinja truthiness.
    // The raw value is never otherwise consumed, so the domain only carries the decision.
    includeDebug: args.debug !== undefined && jinjaTruthy(args.debug),
  };
}
