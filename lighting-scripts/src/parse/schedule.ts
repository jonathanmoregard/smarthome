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
import { jinjaTruthy, object, requireObject, requireString } from '../runtime/parse.ts';
import type { Block } from '../domain/blocks.ts';
import type { LampProfile, LampSample, ScheduledBaseArgs } from '../domain/schedule.ts';
import { isBlock } from './blocks.ts';
import { list, num, optionalTimestamp, saved } from './accessors.ts';
import { haBoolean } from './state-store.ts';
import { storedFact } from './overrides.ts';
import type { StoredFact, StoredValue } from './overrides.ts';

/** A stored override record as the schedule reads it. */
export interface ScheduleRecord {
  /** Does the stored record hold any key? */
  present: boolean;
  kind: StoredFact;
  /** `String(kind)`, computed when read, as the inline coercion was. */
  kindText(): string;
  scope: StoredFact;
  target: StoredFact;
  /** `String(target)`, computed when read. */
  targetText(): string;
  via: StoredFact;
  /** `when` as a timestamp; 0 when absent or null, and a present unreadable value raises. */
  when(): number;
  /** `value.period`, when it is a block. */
  period: Block | undefined;
  /** `value` itself, when it is a block. */
  valueBlock: Block | undefined;
  /** `String(value).toLowerCase()`, computed when read. */
  valueText(): string;
  /** `value.period_updated` (strict), else {@link when}. */
  periodStamp(): number;
}

function scheduleRecord(raw: JsonValue | undefined): ScheduleRecord {
  const r = object(raw), value = object(r.value);
  const when = (): number => optionalTimestamp(r.when) ?? 0;
  return {
    present: Object.keys(r).length > 0,
    kind: storedFact(r.kind),
    kindText: () => String(r.kind),
    scope: storedFact(r.scope),
    target: storedFact(r.target),
    targetText: () => String(r.target),
    via: storedFact(r.via),
    when,
    period: isBlock(value.period) ? value.period : undefined,
    valueBlock: isBlock(r.value) ? r.value : undefined,
    valueText: () => String(r.value).toLowerCase(),
    periodStamp: () => value.period_updated === undefined ? when() : num(value.period_updated),
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

/** A saved `input_text` lamp profile; raises where `saved()` does. */
export interface SavedProfile {
  /** Captured `.get('own', false)` used as a condition: Jinja truthiness, absent read as false. */
  own: boolean;
  /**
   * A plug's power, captured `.get('on', false) | bool`: absent is false,
   * otherwise Home Assistant's bool filter, which raises (with `context`) on a
   * value it rejects. Read only where the captured script reads it.
   */
  on(context: string): boolean;
  effect: StoredFact;
  effectChannels: StoredFact;
}

export function savedProfile(ctx: HouseView, entity: string): SavedProfile {
  const profile = saved(ctx, entity);
  return {
    own: profile.own === undefined ? false : jinjaTruthy(profile.own),
    on: context => profile.on === undefined ? false : haBoolean(profile.on, context),
    effect: storedFact(profile.effect),
    effectChannels: storedFact(profile.effect_channels),
  };
}

/** A light entity's brightness and colour, as the schedule samples it. */
export function entityProfile(ctx: HouseView, entity: string): LampProfile {
  const rgb = list(ctx.attr(entity, 'rgb_color')).map(value => storedFact(value));
  return { brightness: Math.trunc(num(ctx.attr(entity, 'brightness'), 255)), color: ctx.attr(entity, 'color_mode') === 'color_temp'
    ? { kelvin: Math.trunc(num(ctx.attr(entity, 'color_temp_kelvin'), 3000)) }
    : { rgb: rgb.length > 0 ? rgb : [255, 255, 255] } };
}

/** {@link entityProfile}, plus the entity's on state and raw rgb triple. */
export function entitySample(ctx: HouseView, entity: string): LampSample {
  const rgb = list(ctx.attr(entity, 'rgb_color')).map(value => storedFact(value));
  // `on` is `=== 'on'`, so it is always a real boolean — never absent, never a
  // falsy stand-in. That is what lets every downstream `target.on` read be a
  // boolean test by construction rather than a truthiness gamble.
  return { ...entityProfile(ctx, entity), on: ctx.get(entity) === 'on', rgb: rgb.length > 0 ? rgb : [255, 255, 255] };
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
 * and room_only use Undefined-only defaults; debug is definition-tested.
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
    testNow: optionalTimestamp(args.test_now),
    reason: args.reason === undefined ? 'config' : requireString(args, 'reason', context),
    overrides: args.overrides === undefined || args.overrides === null
      ? undefined
      : scheduleRecords(requireObject(args, 'overrides', context)),
    roomOnly,
    // The captured template tests definition, not truthiness. The raw value is
    // never otherwise consumed, so the typed domain only carries the decision.
    includeDebug: Object.hasOwn(args, 'debug'),
  };
}
