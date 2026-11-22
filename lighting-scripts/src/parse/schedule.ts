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
import { jinjaTruthy, object, parseFinite, parsePythonNumeric, requireObject, requireString } from '../runtime/parse.ts';
import type { Block } from '../domain/blocks.ts';
import type { LampColor, LampLight, LampProfile, LampSample, ScheduledBaseRequest } from '../legacy/domain/schedule.ts';
import { isBlock } from './blocks.ts';
import { rgbTripleOf } from './scale.ts';
import { asTimestampOr, num, saved, stateNumberOr, testNow } from './accessors.ts';
import { haBooleanOr } from './state-store.ts';
import { storedFact } from './overrides.ts';
import type { StoredFact, StoredValue } from './overrides.ts';
import type { OverlayKey } from '../adapter/codecs/overlay-key.ts';
import { overlayKeyText } from '../adapter/codecs/overlay-key.ts';
import { parseOverlayKey } from './overlay-key.ts';
import type { RoomId } from '../domain/types/ids.ts';
import { toRoomId } from './ids.ts';
import { roomOfText } from './rooms.ts';

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
  keys: OverlayKey[];
  /** A record by key, read leniently: a missing key is an empty record. */
  get(key: OverlayKey): ScheduleRecord;
}

/** `sensor.ls_overrides`'s `overrides`, read leniently: a non-mapping is `{}`. */
export function storedScheduleRecords(value: JsonValue | undefined): ScheduleRecords {
  return scheduleRecords(object(value));
}

function scheduleRecords(records: JsonObject): ScheduleRecords {
  return { keys: Object.keys(records).map(parseOverlayKey), get: key => scheduleRecord(records[overlayKeyText(key)]) };
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

/** {@link entityLight}, spelled as a target document's profile. */
export function entityProfile(ctx: HouseView, entity: string): LampProfile | undefined {
  return profileOf(entityLight(ctx, entity));
}

/** A light as a target document spells it (see {@link LampProfile}); `undefined` when absent. */
export function profileOf(light: LampLight | undefined): LampProfile | undefined {
  if (light === undefined) return undefined;
  if (!light.on) return { on: false };
  return light.color === undefined ? { brightness: light.brightness } : { brightness: light.brightness, color: light.color };
}

/**
 * A light entity as Home Assistant reports it now.
 *
 * - `off`: off, and nothing else is read (an off light reports no level or colour).
 * - `on` with a level: lit, with its colour when it reports one.
 * - Anything else -- missing, `unknown`, `unavailable` -- is `undefined`: the
 *   light is absent, which is not the same as off.
 * - `on` with no level (an on/off-only light, or a level not yet reported):
 *   there is no honest level to schedule or blend with, so it is absent too.
 *   It used to read as 255. A level that is not a number is absent the same
 *   way (2026-11-21: a value a person can edit recovers); it used to raise.
 */
export function entityLight(ctx: HouseView, entity: string): LampLight | undefined {
  const state = ctx.get(entity);
  if (state === 'off') return { on: false };
  if (state !== 'on') return undefined;
  const level = parseFinite(ctx.attr(entity, 'brightness'));
  if (level === undefined) return undefined;
  const brightness = Math.trunc(level), color = lampColour(ctx, entity);
  return color === undefined ? { on: true, brightness } : { on: true, brightness, color };
}

/**
 * A lit light's colour, when it reports one. The captured profile macro reads
 * `color_temp_kelvin` in the colour-temperature mode and `rgb_color` otherwise;
 * either one missing is no colour (it used to be 3000 K or white).
 */
function lampColour(ctx: HouseView, entity: string): LampColor | undefined {
  if (ctx.attr(entity, 'color_mode') === 'color_temp') {
    // A kelvin that is not a number is no colour (it used to raise).
    const kelvin = parseFinite(ctx.attr(entity, 'color_temp_kelvin'));
    return kelvin === undefined ? undefined : { kelvin: Math.trunc(kelvin) };
  }
  const rgb = sampledRgb(ctx, entity);
  return rgb === undefined ? undefined : { rgb };
}

/**
 * A lit light's `rgb_color`, when it reports one: three numbers. The captured
 * read was `(rgb_color or [255,255,255]) | list`; the white stand-in is gone
 * (2026-11-20: no invented colour), so a Jinja-falsy value is no rgb. Any other
 * value that is not three numbers is no rgb too (2026-11-21: a value a person
 * can edit recovers): the captured `| list` raised on one it cannot list, and
 * the fade's mix or the resolver's colour read raised on the rest.
 */
function sampledRgb(ctx: HouseView, entity: string): StoredValue[] | undefined {
  return rgbTripleOf(ctx.attr(entity, 'rgb_color'));
}

/**
 * A scene the schedule fades between, with the rgb the fade mixes in. A scene
 * that is missing or unavailable has no light to show, so the schedule reads it
 * as off -- what the captured `state == 'on'` test did, now without the
 * made-up level and colour that came with it.
 */
export function entitySample(ctx: HouseView, entity: string): LampSample {
  const light = entityLight(ctx, entity);
  if (light === undefined || !light.on) return { on: false };
  return { ...light, rgb: sampledRgb(ctx, entity) };
}

/** One component of a sampled rgb triple, as a schedule number. */
export function rgbComponent(rgb: StoredValue[], index: number): number {
  return num(rgb[index]);
}

/** A helper's state as a schedule number, read by {@link stateNumberOr}: anything but a number is `fallback`. */
export function stateNumber(ctx: HouseView, entity: string, fallback: number): number {
  return stateNumberOr(ctx.get(entity), fallback);
}

/**
 * A wake helper's `timestamp` attribute: a finite number (or numeric text) is
 * the instant, and anything else -- absent, `null`, unreadable -- is none, which
 * the schedule reads as no wake (2026-11-21: a value a person can edit
 * recovers to a default). It used to raise.
 */
export function wakeInstant(ctx: HouseView, entity: string): number | undefined {
  return parseFinite(ctx.attr(entity, 'timestamp'));
}

/**
 * Captured test_now/overrides are guarded by definition before use; reason
 * and room_only use Undefined-only defaults; debug is definition- and truth-tested.
 * Present optional values are parsed, while null overrides retain the
 * producer's explicit "use the state attribute" spelling.
 */
/** `ls_base`'s arguments. `room_only` is read first, as the inline parse read it. */
export function parseBaseArgs(args: JsonObject): ScheduledBaseRequest {
  const roomOnly = args.room_only === undefined ? undefined : roomOfText(requireString(args, 'room_only', 'ls_base'));
  return parseScheduledBaseArgs(args, 'ls_base', roomOnly);
}

function parseScheduledBaseArgs(args: JsonObject, context: string, roomOnly: RoomId | undefined): ScheduledBaseRequest {
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

/**
 * `ls_room_base`'s arguments. The captured script declaration marks `room`
 * required, and it drives entity names, comparisons and indexing rather than
 * iteration or membership; it is read first.
 */
export function parseRoomBaseArgs(args: JsonObject): ScheduledBaseRequest {
  const room = roomOfText(requireString(args, 'room', 'ls_room_base'));
  return parseScheduledBaseArgs(args, 'ls_room_base', room);
}

/**
 * The rooms the registry labels `private_room`: the snapshot's label list,
 * read as the scripts read it (`view.labels?.private_room ?? []`, so an absent
 * or null list is no rooms), each a room.
 */
export function privateRoomIds(view: Pick<HouseView, 'labels'>): RoomId[] {
  const labels = view.labels;
  const rooms = labels === undefined || labels === null ? undefined : labels.private_room;
  return rooms === undefined || rooms === null ? [] : rooms.map(toRoomId);
}
