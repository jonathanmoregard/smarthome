/**
 * Parsing for `ls_room_plan`: the room cache, the room baseline, the stored
 * override records, and the handful of Home Assistant attributes the room plan
 * reads.
 *
 * **The room cache is an on-disk edge, and not only this port writes it.**
 * `cacheVersion` (`domain/planning.ts`) is the oracle's own version literal,
 * copied from `reference/live/scripts/ls_room_plan.json`, so a cache written by
 * the live Jinja script hits here too. Its baseline and schedule therefore reach
 * the plan as whatever Jinja persisted, and are carried as `Verbatim` -- the
 * plan spreads them into compared JSON, so narrowing them would drop keys the
 * oracle keeps (see `tasks/ls-room-plan-design.md`).
 *
 * **Every raise stays where it was.** The inline reads this replaces raised at
 * many points, interleaved with planning decisions: a record's `when` only once
 * it matched, a target only when the refresh reached it, a schedule-detail
 * number only where the refresh or the expiry used it. Those reads are thunks
 * here, and the domain calls each at exactly the point the inline read sat.
 * Reads that the inline code made eagerly are made eagerly here, in the same
 * order.
 *
 * The cache-validity test (`validCache`) is the captured script's own cache
 * sanitiser, check for check; see its comment.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaFloat, jinjaTruthy, object, requireNumber, requireObject, requireString } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { list, optionalTimestamp, timestamp } from './accessors.ts';
import type { BaselineTarget, DetailField, OverrideFacts, Overrides, RoomBaseline, RoomCache, RoomDetails, RoomPlanArgs, TestNow } from '../domain/planning.ts';
import { isBlock, savedBlock } from './blocks.ts';

function requiredObjectValue(value: JsonValue | undefined, context: string): JsonObject {
  return value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
}
function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * One record's facts. `kind`, `scope`, `target` and `via` are only ever
 * compared with strings, so a non-string value is `undefined` here: it compares
 * unequal to every literal, exactly as the raw value did. The raw values
 * themselves are kept for the period tuple, which stores them.
 */
function overrideFacts(r: JsonObject): OverrideFacts {
  const value = isObject(r.value) ? r.value : {};
  const valueBlock = isBlock(r.value) ? r.value : undefined;
  return {
    kind: optionalString(r.kind),
    scope: optionalString(r.scope),
    target: optionalString(r.target),
    via: optionalString(r.via),
    stored: { kind: carry(r.kind ?? null), scope: carry(r.scope ?? null), target: carry(r.target ?? null) },
    valueBlock,
    period: r.kind === 'block' ? valueBlock : isBlock(value.period) ? value.period : undefined,
    periodUpdated: () => value.period_updated === undefined ? undefined : requireNumber(value, 'period_updated', 'ls_room_plan override value'),
    when: () => optionalTimestamp(r.when),
  };
}

/**
 * The stored records. `lenient` reads a non-mapping record as `{}`, which is
 * how `latestRemote` reads them; `record()` requires a mapping, raising with
 * the context the period scan always used.
 */
function parseOverrides(records: JsonObject): Overrides {
  return {
    document: carry(records),
    entries: Object.entries(records).map(([key, value]) => {
      const facts = overrideFacts(object(value));
      return {
        key,
        document: carry(value),
        lenient: facts,
        record: () => { requireObject(records, key, 'ls_room_plan.overrides'); return facts; },
      };
    }),
  };
}

function testNow(value: JsonValue | undefined): TestNow {
  return {
    document: value === undefined ? undefined : carry(value),
    instant: now => timestamp(jinjaTruthy(value) ? value : now),
  };
}

function roomDetails(details: JsonObject, room: string, context: string): RoomDetails {
  const S = details[room] === undefined ? {} : requireObject(details, room, context);
  return {
    document: carry(S),
    cur: carry(S.cur ?? null),
    curIsNight: S.cur === 'night',
    block: savedBlock(S.cur),
    fading: jinjaTruthy(S.fading),
    fadingOrAbsent: jinjaTruthy(S.fading === undefined ? true : S.fading),
    number: (key: DetailField, at: string) => S[key] === undefined ? 0 : requireNumber(S, key, at),
    required: (key: DetailField, at: string) => requireNumber(S, key, at),
  };
}

function baselineTarget(entity: string, value: JsonValue): BaselineTarget {
  const t = requiredObjectValue(value, `ls_room_plan.baseline.targets.${entity}`);
  return { document: carry(t), isRoom: jinjaTruthy(t.is_room) };
}

/**
 * A room baseline: `ls_room_base`'s result on a miss, the cached copy on a hit.
 * The four containers are required here, in the order they always were; each
 * target and each profile is required only when the refresh reaches it.
 */
export function parseRoomBaseline(value: JsonValue | undefined, context: string): RoomBaseline {
  const raw = requiredObjectValue(value, context);
  const targets = requireObject(raw, 'targets', context);
  const scheduleContext = `${context}.schedule`;
  const schedule = requiredObjectValue(raw.schedule, scheduleContext);
  const details = requireObject(schedule, 'schedule_details', scheduleContext);
  const profiles = requireObject(schedule, 'profiles', scheduleContext);
  return {
    document: carry(raw),
    targets: carry(targets),
    targetEntries: Object.entries(targets).map(([entity, t]) => ({ entity, target: () => baselineTarget(entity, t) })),
    schedule: carry(schedule),
    details: (room, at) => roomDetails(details, room, at),
    profiles: Object.entries(profiles).map(([lamp, p]) => ({
      lamp,
      profile: () => {
        // The refresh keeps every baseline target (each one an object, or it
        // raised before the profiles are reached), so this is the check that
        // the profile's lamp has one, with the refresh's message.
        requireObject(targets, lamp, 'ls_room_plan refreshed targets');
        return carry(requiredObjectValue(p, `ls_room_plan.baseline.schedule.profiles.${lamp}`));
      },
    })),
  };
}

/**
 * A cache the plan may consult, or `undefined` for a miss. Never raises: an
 * absent or malformed cache is a miss, as in the oracle.
 *
 * This is the captured script's first-step cache sanitiser, which replaces a
 * cache failing any of its checks with `{}`: `dependencies`, `periods`,
 * `baseline`, `gradients` and `catalog` are mappings; `valid_from` and
 * `valid_until` are numbers and not booleans; `baseline.targets`,
 * `baseline.schedule`, `schedule.schedule_details`, `schedule.profiles` and
 * `schedule_details[room]` are mappings; and `'room:' + room` is a target.
 * The later `cache_hit` test re-checks only a subset, which is why it reads
 * looser. Verified against Home Assistant 2026.7.4 on the same caches.
 *
 * One edge is unmatched: Jinja's `is number` admits NaN and the infinities,
 * which `Number.isFinite` refuses. JSON cannot carry them, Home Assistant's
 * `to_json` turns them into null before a cache is stored, and the parity
 * simulator and Home Assistant disagree about what a non-finite cache does
 * next, so there is no single oracle behaviour to copy.
 */
function validCache(value: JsonValue | undefined, room: string): RoomCache | undefined {
  if (!isObject(value)) return undefined;
  if (!['dependencies', 'periods', 'baseline', 'gradients', 'catalog'].every(k => isObject(value[k]))) return undefined;
  if (!['valid_from', 'valid_until'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]))) return undefined;
  const baseline = value.baseline;
  if (!isObject(baseline) || !isObject(baseline.targets) || !isObject(baseline.schedule)) return undefined;
  const schedule = baseline.schedule;
  if (!isObject(schedule.schedule_details) || !isObject(schedule.profiles) || !isObject(schedule.schedule_details[room])) return undefined;
  if (!Object.hasOwn(baseline.targets, `room:${room}`)) return undefined;
  const raw = structuredClone(value);
  return {
    version: optionalString(raw.version),
    room: optionalString(raw.room),
    dependencies: carry(requireObject(raw, 'dependencies', 'ls_room_plan.cache')),
    periods: carry(requireObject(raw, 'periods', 'ls_room_plan.cache')),
    baseline: parseRoomBaseline(raw.baseline, 'ls_room_plan.cache.baseline'),
    gradients: carry(requireObject(raw, 'gradients', 'ls_room_plan.cache')),
    catalog: carry(requireObject(raw, 'catalog', 'ls_room_plan.cache')),
    validFrom: requireNumber(raw, 'valid_from', 'ls_room_plan.cache'),
    validUntil: requireNumber(raw, 'valid_until', 'ls_room_plan.cache'),
  };
}

/**
 * Captured room/reason/overrides are raw at 43/3/9 sites. Room drives string
 * operations and indexing, while the script field declarations give reason and
 * overrides their `remote` / `{}` fallbacks. test_now has three
 * `| default(none)` sites and its timestamp path uses a truthiness
 * conditional. Cache is read raw 26 times behind mapping guards; an absent or
 * non-mapping cache remains a miss, while its indexed baseline, schedule,
 * targets, details, profiles, gradients and catalog are parsed. A missing
 * selected-room schedule detail keeps the captured empty-object fallback; its
 * `cur` is parsed as a block (see `parse/blocks.ts` for why the captured
 * `or 'night'` is not reproduced). power/ranges/defaults each have one mapping
 * guard and one source default, so malformed or absent values retain the
 * captured runtime fallbacks.
 */
export function parseRoomPlanArgs(args: JsonObject): RoomPlanArgs {
  const room = requireString(args, 'room', 'ls_room_plan');
  return {
    room,
    reason: args.reason === undefined ? 'remote' : requireString(args, 'reason', 'ls_room_plan'),
    testNow: testNow(args.test_now),
    overrides: parseOverrides(args.overrides === undefined ? {} : requireObject(args, 'overrides', 'ls_room_plan')),
    cache: validCache(args.cache, room),
    power: isObject(args.power) ? carry(args.power) : undefined,
    ranges: isObject(args.ranges) ? carry(args.ranges) : undefined,
    defaults: isObject(args.defaults) ? carry(args.defaults) : undefined,
  };
}

/** An attribute value as stored in the dependency fingerprint: absent is `null`. */
export function stored(value: JsonValue | undefined): Verbatim {
  return carry(value ?? null);
}

/** A list attribute as stored in the dependency fingerprint: absent is `[]`, a non-list raises. */
export function storedList(value: JsonValue | undefined): Verbatim {
  return carry(list(value));
}

/** `rgb_color` of the warm-end test lamp, or the built-in warm end when it names none. */
export function warmEndOf(value: JsonValue | undefined): Verbatim {
  const warm = list(value);
  return carry(warm.length > 0 ? warm : [255, 126, 0]);
}

/** An attribute read through `.get(key, {})`-style leniency: a non-mapping is `{}`. */
export function mappingAttribute(value: JsonValue | undefined): Verbatim {
  return carry(object(value));
}

/** The entities `switch_ranges` names. */
export function switchRangeEntities(value: JsonValue | undefined): string[] {
  return Object.keys(object(value));
}

/** `range_defaults`, or the built-in ranges when the attribute is absent or null. */
export function rangeDefaults(value: JsonValue | undefined): Verbatim {
  return carry(value ?? { bright: [90, 100], cosy: [30, 60] });
}

/**
 * The `effects`/`processors` slice of the RAW catalog, which the room cache
 * persists. Not `ctx.catalog`: `test_room_cache.py:118` asserts
 * `local['catalog']['effects'] == pure('effects_catalog')['effects']`, so these
 * are compared bytes and a projection cannot stand in for them -- `Catalog`
 * drops `budget`, drops `animated`/`channels` from each processor, and defaults
 * an absent `channels` to `[]`. When no document is held, the
 * `effects_catalog` script is called, as before.
 */
export function roomCatalog(raw: JsonObject, fetch: () => JsonValue): Verbatim {
  const full = Object.keys(raw).length > 0 ? raw : object(fetch());
  return carry({ effects: object(full.effects), processors: object(full.processors) });
}

/** The room's wake time: `state_attr('input_datetime.ls_<room>_wake', 'timestamp') | float`. */
export function wakeTimestamp(ctx: HouseView, room: string): number {
  return jinjaFloat(ctx.attr(`input_datetime.ls_${room}_wake`, 'timestamp'));
}

/** The room's wake fade in minutes: `states('input_number.ls_<room>_wake_fade') | float(37.5)`. */
export function wakeFadeMinutes(ctx: HouseView, room: string): number {
  return jinjaFloat(ctx.get(`input_number.ls_${room}_wake_fade`), 37.5);
}
