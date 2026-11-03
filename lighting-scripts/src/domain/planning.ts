import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, jinjaTruthy, requireArray, requireNumber, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { blockOption, DEFAULT_BLOCK, isBlock, optionalBlock } from './blocks.ts';
import { object, isObject } from './scale.ts';
import { blocks, hasValue, isRemote, labelled, latestRemote, list, nextMidnight, optionalTimestamp, privateRooms, profile, timestamp } from './schedule.ts';

const cacheVersion = 'db7981f72ee868e8d33ff1481dffb34e5e26570e8bf949a3cb2c505d7c3f37e1:input-processors-v1:preset-stream-v1';
type Dependencies = {
  lamps: string[];
  switches: string[];
  values: JsonValue[];
  wake: JsonValue[];
  expiry: JsonValue;
  private: boolean;
  warm: JsonValue[];
  tick: boolean;
};
interface ParsedSchedule {
  raw: JsonObject;
  details: JsonObject;
  profiles: JsonObject;
}
interface ParsedBaseline {
  raw: JsonObject;
  targets: JsonObject;
  schedule: ParsedSchedule;
}
interface ParsedCache {
  raw: JsonObject;
  baseline: ParsedBaseline;
  gradients: JsonObject;
  catalog: JsonObject;
  validFrom: number;
  validUntil: number;
}
interface RoomPlanArgs {
  room: string;
  reason: string;
  testNow: JsonValue | undefined;
  overrides: JsonObject;
  cache: ParsedCache | undefined;
  power: JsonObject | undefined;
  ranges: JsonObject | undefined;
  defaults: JsonObject | undefined;
}
function requiredObjectValue(value: JsonValue | undefined, context: string): JsonObject {
  return value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
}
function optionalNumber(container: JsonObject, key: string, fallback: number, context: string): number {
  return container[key] === undefined ? fallback : requireNumber(container, key, context);
}
function parseSchedule(value: JsonValue | undefined, room: string, context: string): ParsedSchedule {
  const raw = requiredObjectValue(value, context);
  const details = requireObject(raw, 'schedule_details', context);
  return { raw, details, profiles: requireObject(raw, 'profiles', context) };
}
function parseBaseline(value: JsonValue | undefined, room: string, context: string): ParsedBaseline {
  const raw = requiredObjectValue(value, context);
  return {
    raw,
    targets: requireObject(raw, 'targets', context),
    schedule: parseSchedule(raw.schedule, room, `${context}.schedule`),
  };
}
function roomDetails(schedule: ParsedSchedule, room: string, context: string): JsonObject {
  return schedule.details[room] === undefined ? {} : requireObject(schedule.details, room, context);
}
function dependencies(ctx: ScriptContext, room: string, reason: string, warm: JsonValue[]): Dependencies {
  const lamps = labelled(ctx, 'house_schedule').filter(e => e.startsWith('light.') && ctx.areas[e] === room).sort();
  const switches = [...new Set([...labelled(ctx, 'on_off'), ...Object.keys(object(ctx.attr('sensor.ls_overrides', 'switch_ranges')))])].filter(e => ctx.areas[e] === room).sort();
  const values: JsonValue[] = [];
  for (const scope of ['house', room]) for (const block of blocks) {
    for (const suffix of ['start', 'weekend']) values.push(ctx.get(`input_datetime.ls_${scope}_${block}_${suffix}`));
    values.push(ctx.get(`input_number.ls_${scope}_${block}_fade`), ctx.get(`input_boolean.ls_${scope}_${block}_own_timing`), ctx.get(`input_boolean.ls_${scope}_${block}_own_light`));
  }
  for (const scope of ['house', room, ...lamps.map(e => e.replace('light.', 'lamp_'))]) for (const block of blocks) {
    const entity = `light.ls_${scope}_${block}`;
    values.push(ctx.get(`input_text.ls_${scope}_${block}`), ctx.get(entity), ctx.attr(entity, 'brightness') ?? null,
      ctx.attr(entity, 'color_mode') ?? null, ctx.attr(entity, 'color_temp_kelvin') ?? null, list(ctx.attr(entity, 'rgb_color')));
  }
  return { lamps, switches, values,
    wake: [ctx.get(`input_datetime.ls_${room}_wake`), ctx.attr(`input_datetime.ls_${room}_wake`, 'timestamp') ?? null, ctx.get(`input_number.ls_${room}_wake_fade`)],
    expiry: ctx.get('input_boolean.ls_ovr_next_block_on'), private: privateRooms(ctx).includes(room), warm, tick: reason === 'tick' };
}
function validCache(value: JsonValue | undefined, room: string): ParsedCache | undefined {
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
    raw,
    baseline: parseBaseline(raw.baseline, room, 'ls_room_plan.cache.baseline'),
    gradients: requireObject(raw, 'gradients', 'ls_room_plan.cache'),
    catalog: requireObject(raw, 'catalog', 'ls_room_plan.cache'),
    validFrom: requireNumber(raw, 'valid_from', 'ls_room_plan.cache'),
    validUntil: requireNumber(raw, 'valid_until', 'ls_room_plan.cache'),
  };
}
function periods(records: JsonObject, room: string, deps: Dependencies, boundary: number): JsonObject {
  const newest = latestRemote(records, room), result: JsonObject = {};
  for (const key of Object.keys(records).sort()) {
    const r = requireObject(records, key, 'ls_room_plan.overrides');
    const value = isObject(r.value) ? r.value : {};
    const match = (r.kind === 'block' && r.target === room) || (typeof r.kind === 'string' && ['channels', 'input'].includes(r.kind) &&
      ((r.scope === 'room' && r.target === room) || (r.scope === 'lamp' && typeof r.target === 'string' && deps.lamps.includes(r.target)) || (r.scope === 'house' && !deps.private)));
    const period = r.kind === 'block' ? r.value : value.period;
    if (!match || (r.scope === 'room' && isRemote(r) && key !== newest) || typeof period !== 'string' || !blocks.includes(period)) continue;
    const when = optionalTimestamp(r.when) ?? 0;
    const stamp = value.period_updated === undefined ? when : requireNumber(value, 'period_updated', 'ls_room_plan override value');
    result[r.scope === 'room' && isRemote(r) ? `remote-input:${room}` : key] = [r.kind ?? null, r.scope ?? null, r.target ?? null, period!, stamp, deps.expiry === 'on' && when <= boundary];
  }
  return result;
}
function refreshBaseline(ctx: ScriptContext, baseline: ParsedBaseline, cache: ParsedCache | undefined, hit: boolean, room: string, deps: Dependencies, records: JsonObject, at: number): ParsedBaseline {
  const schedule = baseline.schedule.raw;
  const S = roomDetails(baseline.schedule, room, 'ls_room_plan.baseline.schedule.schedule_details');
  const targets: JsonObject = {}, stale: string[] = [];
  for (const [entity, raw] of Object.entries(baseline.targets)) {
    const t = requiredObjectValue(raw, `ls_room_plan.baseline.targets.${entity}`), ignored: string[] = [];
    if (deps.expiry === 'on') for (const [key, record] of Object.entries(records)) {
      const r = requiredObjectValue(record, `ls_room_plan.overrides.${key}`);
      const match = (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !deps.private) || (key === 'mode:sara' && !deps.private) || (r.kind === 'block' && r.target === room)
        || (!jinjaTruthy(t.is_room) && ((r.scope === 'lamp' && r.target === entity) || (r.kind === 'light' && r.target === entity)));
      if (match && (optionalTimestamp(r.when) ?? 0) <= optionalNumber(S, 'last_fs', 0, 'ls_room_plan schedule details')) ignored.push(key);
    }
    targets[entity] = { ...t, ignore_overrides: ignored, ...(!jinjaTruthy(t.is_room) ? { observed: profile(ctx, entity) } : {}) };
  }
  if (deps.expiry === 'on' && !jinjaTruthy(S.fading)) for (const [key, record] of Object.entries(records)) {
    const r = requiredObjectValue(record, `ls_room_plan.overrides.${key}`);
    const local = (r.scope === 'room' && r.target === room) || ((r.scope === 'lamp' || r.kind === 'light') && typeof r.target === 'string' && deps.lamps.includes(r.target)) || (r.kind === 'block' && r.target === room);
    if (local && (optionalTimestamp(r.when) ?? 0) <= optionalNumber(S, 'last_fs', 0, 'ls_room_plan schedule details')) stale.push(key);
  }
  const blockKey = `block:${room}`;
  const chosen = records[blockKey] === undefined ? undefined : requireObject(records, blockKey, 'ls_room_plan.overrides').value;
  // The captured source spells this `(S.get('cur') or 'night') | capitalize`.
  // We deliberately do not reproduce either half (mandate v2): `or` would make
  // a cached 0 or '' mean Night, hiding a malformed cache, and `| capitalize`
  // would quietly repair 'NIGHT'. Here an absent or null `cur` means "no block
  // decided yet" and falls back to Night, a valid block is used as-is, and
  // anything else raises. The option label comes from the union, so there is no
  // string transformation left to get wrong.
  const override = isBlock(chosen) && !stale.includes(blockKey) ? chosen : undefined;
  const effective = override ?? optionalBlock(S.cur, 'ls_room_plan schedule details.cur') ?? DEFAULT_BLOCK;
  const entity = `input_select.ls_${room}_override`, option = blockOption(effective);
  const mirrors: JsonValue[] = ctx.state[entity] && ctx.get(entity) !== option ? [{ entity, option }] : [];
  const profiles: JsonObject = {};
  for (const [lamp, p] of Object.entries(baseline.schedule.profiles)) {
    const target = requireObject(targets, lamp, 'ls_room_plan refreshed targets');
    profiles[lamp] = { ...requiredObjectValue(p, `ls_room_plan.baseline.schedule.profiles.${lamp}`), ignore_overrides: target.ignore_overrides ?? [] };
  }
  const raw = { targets, schedule: { ...schedule, profiles, sched: { [room]: S.cur ?? null },
    schedule_details: { [room]: hit ? { ...S, left: cache!.validFrom + requireNumber(S, 'left', 'ls_room_plan schedule details') - at, edge: at - requireNumber(S, 'cur_ts', 'ls_room_plan schedule details') < 90 } : S }, stale_keys: stale, mirror: mirrors } };
  return parseBaseline(raw, room, 'ls_room_plan refreshed baseline');
}
function expiry(ctx: ScriptContext, baseline: ParsedBaseline, room: string, at: number): number {
  const S = roomDetails(baseline.schedule, room, 'ls_room_plan.baseline.schedule.schedule_details');
  const deadlines = [nextMidnight(at, ctx.timezone ?? 'Europe/Stockholm')];
  let moving = jinjaTruthy(S.fading === undefined ? true : S.fading);
  for (const boundary of [optionalNumber(S, 'next_fs', 0, 'ls_room_plan schedule details'), at + optionalNumber(S, 'left', 0, 'ls_room_plan schedule details'), optionalNumber(S, 'cur_ts', 0, 'ls_room_plan schedule details') + 90]) if (boundary > at) deadlines.push(boundary);
  if (hasValue(ctx, `input_datetime.ls_${room}_wake`)) {
    const wake = jinjaFloat(ctx.attr(`input_datetime.ls_${room}_wake`, 'timestamp'));
    const duration = jinjaFloat(ctx.get(`input_number.ls_${room}_wake_fade`), 37.5) * 60;
    for (const boundary of [wake, wake + duration, wake + duration + 90, wake + 86400]) if (boundary > at) deadlines.push(boundary);
    if (at - wake >= 0 && at - wake < duration && S.cur === 'night' && optionalNumber(S, 'cur_ts', 0, 'ls_room_plan schedule details') <= wake) moving = true;
  }
  return moving ? at : Math.min(...deadlines);
}

export function roomPlan(ctx: ScriptContext, args: RoomPlanArgs): JsonObject {
  const { room, reason, overrides: records, cache } = args;
  const at = timestamp(jinjaTruthy(args.testNow) ? args.testNow : ctx.now);
  const warm = list(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  const warmEnd = warm.length ? warm : [255, 126, 0];
  const deps = dependencies(ctx, room, reason, warmEnd);
  const cachedDetails = cache === undefined ? undefined : roomDetails(cache.baseline.schedule, room, 'ls_room_plan.cache.baseline.schedule.schedule_details');
  let periodRecords = periods(records, room, deps, cachedDetails === undefined ? 0 : optionalNumber(cachedDetails, 'last_fs', 0, 'ls_room_plan cached schedule details'));
  const hit = cache !== undefined && cache.raw.version === cacheVersion && cache.raw.room === room && isDeepStrictEqual(cache.raw.dependencies, deps) && isDeepStrictEqual(cache.raw.periods, periodRecords)
    && cache.validFrom <= at && at < cache.validUntil;
  let baseline: ParsedBaseline, gradients: JsonObject, catalog: JsonObject, update: JsonValue = null;
  if (hit) {
    baseline = cache.baseline; gradients = cache.gradients; catalog = cache.catalog;
  } else {
    baseline = parseBaseline(ctx.run('ls_room_base', { room, overrides: records, test_now: args.testNow ?? null, reason }), room, 'ls_room_plan baseline');
    // The RAW document, not `ctx.catalog`. This mapping is persisted in the
    // room cache and `test_room_cache.py:118` asserts
    // `local['catalog']['effects'] == pure('effects_catalog')['effects']`, so
    // these are compared bytes and a projection cannot stand in for them:
    // `Catalog` drops `budget`, drops `animated`/`channels` from each processor,
    // and defaults an absent `channels` to `[]`. Reading the parsed view here
    // matched only by coincidence, while the projection still happened to carry
    // every field these two keys contain.
    const rawCatalog = ctx.rawCatalog();
    const fullCatalog = Object.keys(rawCatalog).length > 0 ? rawCatalog : object(ctx.run('effects_catalog'));
    catalog = { effects: object(fullCatalog.effects), processors: object(fullCatalog.processors) };
    const compiled = object(ctx.run('effects_gradient_plan', { base: baseline.targets, warm_end: warmEnd, cached: cache?.gradients ?? {} }));
    gradients = object(compiled.gradients);
    const details = roomDetails(baseline.schedule, room, 'ls_room_plan.baseline.schedule.schedule_details');
    periodRecords = periods(records, room, deps, optionalNumber(details, 'last_fs', 0, 'ls_room_plan schedule details'));
    update = { version: cacheVersion, room, dependencies: deps, periods: periodRecords, valid_from: at, valid_until: expiry(ctx, baseline, room, at), baseline: baseline.raw, gradients, catalog };
  }
  baseline = refreshBaseline(ctx, baseline, cache, hit, room, deps, records, at);
  const schedule = baseline.schedule.raw;
  const stale = schedule.stale_keys === undefined ? [] : requireArray(schedule, 'stale_keys', 'ls_room_plan.baseline.schedule');
  const active = Object.fromEntries(Object.entries(records).filter(([key]) => !stale.includes(key)));
  const resolved = object(ctx.run('effects_resolve', { base: baseline.targets, overrides: active, catalog, sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms(ctx),
    power: args.power ?? object(ctx.attr('sensor.ls_overrides', 'power')), warm_end: warmEnd, gradients }));
  const switches = object(ctx.run('ls_switch_plan', { targets: resolved.targets ?? {},
    ranges: args.ranges ?? object(ctx.attr('sensor.ls_overrides', 'switch_ranges')),
    defaults: args.defaults ?? ctx.attr('sensor.ls_overrides', 'range_defaults') ?? { bright: [90, 100], cosy: [30, 60] } }));
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...schedule, room, base: baseline.targets ?? {}, resolved, gradients, catalog, switches: switches.switches ?? {},
    revision: ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now, plan_order: timestamp(ctx.now), remote: reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null }, cache_update: update, cache_hit: hit };
}
export const planningHandlers: ScriptHandlers = {
  // Captured room/reason/overrides are raw at 43/3/9 sites. Room drives string
  // operations and indexing, while the script field declarations give reason
  // and overrides their `remote` / `{}` fallbacks. test_now has three
  // `| default(none)` sites and its timestamp path uses a truthiness
  // conditional. Cache is read raw 26 times behind mapping guards; an absent
  // or non-mapping cache remains a miss, while its indexed baseline, schedule,
  // targets, details, profiles, gradients and catalog are parsed. A missing
  // selected-room schedule detail keeps the captured empty-object fallback;
  // its `cur` is read raw and falls back through `or 'night'`, which accepts
  // non-string cached values and replaces every falsy one.
  // power/ranges/defaults each have one mapping guard and one source default,
  // so malformed or absent values retain the captured runtime fallbacks.
  ls_room_plan: withParsedArgs({
    parse: args => {
      const room = requireString(args, 'room', 'ls_room_plan');
      return {
        room,
        reason: args.reason === undefined ? 'remote' : requireString(args, 'reason', 'ls_room_plan'),
        testNow: args.test_now,
        overrides: args.overrides === undefined ? {} : requireObject(args, 'overrides', 'ls_room_plan'),
        cache: validCache(args.cache, room),
        power: isObject(args.power) ? args.power : undefined,
        ranges: isObject(args.ranges) ? args.ranges : undefined,
        defaults: isObject(args.defaults) ? args.defaults : undefined,
      };
    },
    run: roomPlan,
  }),
};
