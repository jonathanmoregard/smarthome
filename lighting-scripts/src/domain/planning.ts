import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, isObject } from './scale.ts';
import { blocks, hasValue, isRemote, labelled, latestRemote, list, nextMidnight, num, privateRooms, profile, strings, timestamp } from './schedule.ts';

const cacheVersion = 'db7981f72ee868e8d33ff1481dffb34e5e26570e8bf949a3cb2c505d7c3f37e1:input-processors-v1:preset-stream-v1';
function dependencies(ctx: ScriptContext, room: string, reason: string, warm: JsonValue[]): JsonObject {
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
function validCache(value: JsonValue | undefined, room: string): JsonObject {
  const cache = object(value);
  if (!['dependencies', 'periods', 'baseline', 'gradients', 'catalog'].every(k => isObject(cache[k]))) return {};
  if (!['valid_from', 'valid_until'].every(k => typeof cache[k] === 'number' && Number.isFinite(cache[k]))) return {};
  const baseline = object(cache.baseline), schedule = object(baseline.schedule);
  if (!isObject(baseline.targets) || !isObject(baseline.schedule) || !isObject(schedule.schedule_details) || !isObject(schedule.profiles)) return {};
  if (!isObject(object(schedule.schedule_details)[room]) || !Object.hasOwn(baseline.targets, `room:${room}`)) return {};
  return structuredClone(cache);
}
function periods(records: JsonObject, room: string, deps: JsonObject, boundary: number): JsonObject {
  const newest = latestRemote(records, room), result: JsonObject = {};
  for (const key of Object.keys(records).sort()) {
    const r = object(records[key]), value = object(r.value);
    const match = (r.kind === 'block' && r.target === room) || (['channels', 'input'].includes(String(r.kind)) &&
      ((r.scope === 'room' && r.target === room) || (r.scope === 'lamp' && strings(deps.lamps).includes(String(r.target))) || (r.scope === 'house' && !deps.private)));
    const period = r.kind === 'block' ? r.value : value.period;
    if (!match || (r.scope === 'room' && isRemote(r) && key !== newest) || !blocks.includes(String(period))) continue;
    const stamp = value.period_updated ?? timestamp(r.when);
    result[r.scope === 'room' && isRemote(r) ? `remote-input:${room}` : key] = [r.kind ?? null, r.scope ?? null, r.target ?? null, period!, stamp, deps.expiry === 'on' && timestamp(r.when) <= boundary];
  }
  return result;
}
function refreshBaseline(ctx: ScriptContext, baseline: JsonObject, cache: JsonObject, hit: boolean, room: string, deps: JsonObject, records: JsonObject, at: number): JsonObject {
  const schedule = object(baseline.schedule), S = object(object(schedule.schedule_details)[room]);
  const targets: JsonObject = {}, stale: string[] = [];
  for (const [entity, raw] of Object.entries(object(baseline.targets))) {
    const t = object(raw), ignored: string[] = [];
    if (deps.expiry === 'on') for (const [key, record] of Object.entries(records)) {
      const r = object(record);
      const match = (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !deps.private) || (key === 'mode:sara' && !deps.private) || (r.kind === 'block' && r.target === room)
        || (!t.is_room && ((r.scope === 'lamp' && r.target === entity) || (r.kind === 'light' && r.target === entity)));
      if (match && timestamp(r.when) <= num(S.last_fs)) ignored.push(key);
    }
    targets[entity] = { ...t, ignore_overrides: ignored, ...(!t.is_room ? { observed: profile(ctx, entity) } : {}) };
  }
  if (deps.expiry === 'on' && !S.fading) for (const [key, record] of Object.entries(records)) {
    const r = object(record);
    const local = (r.scope === 'room' && r.target === room) || ((r.scope === 'lamp' || r.kind === 'light') && strings(deps.lamps).includes(String(r.target))) || (r.kind === 'block' && r.target === room);
    if (local && timestamp(r.when) <= num(S.last_fs)) stale.push(key);
  }
  const chosen = object(records[`block:${room}`]).value;
  const effective = blocks.includes(String(chosen)) && !stale.includes(`block:${room}`) ? String(chosen) : String(S.cur ?? 'night');
  const entity = `input_select.ls_${room}_override`, option = effective[0]!.toUpperCase() + effective.slice(1);
  const mirrors: JsonValue[] = ctx.state[entity] && ctx.get(entity) !== option ? [{ entity, option }] : [];
  const profiles: JsonObject = {};
  for (const [lamp, p] of Object.entries(object(schedule.profiles))) profiles[lamp] = { ...object(p), ignore_overrides: object(targets[lamp]).ignore_overrides ?? [] };
  return { targets, schedule: { ...schedule, profiles, sched: { [room]: S.cur ?? null },
    schedule_details: { [room]: hit ? { ...S, left: num(cache.valid_from) + num(S.left) - at, edge: at - num(S.cur_ts) < 90 } : S }, stale_keys: stale, mirror: mirrors } };
}
function expiry(ctx: ScriptContext, baseline: JsonObject, room: string, at: number): number {
  const S = object(object(object(baseline.schedule).schedule_details)[room]);
  const deadlines = [nextMidnight(at, ctx.timezone ?? 'Europe/Stockholm')];
  let moving = S.fading ?? true;
  for (const boundary of [num(S.next_fs), at + num(S.left), num(S.cur_ts) + 90]) if (boundary > at) deadlines.push(boundary);
  if (hasValue(ctx, `input_datetime.ls_${room}_wake`)) {
    const wake = num(ctx.attr(`input_datetime.ls_${room}_wake`, 'timestamp'));
    const duration = num(ctx.get(`input_number.ls_${room}_wake_fade`), 37.5) * 60;
    for (const boundary of [wake, wake + duration, wake + duration + 90, wake + 86400]) if (boundary > at) deadlines.push(boundary);
    if (at - wake >= 0 && at - wake < duration && S.cur === 'night' && num(S.cur_ts) <= wake) moving = true;
  }
  return moving ? at : Math.min(...deadlines);
}

export function roomPlan(ctx: ScriptContext, args: JsonObject): JsonObject {
  const room = String(args.room ?? ''), reason = String(args.reason ?? 'remote');
  const at = timestamp(args.test_now || ctx.now), records = object(args.overrides);
  const warm = list(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  const warmEnd = warm.length ? warm : [255, 126, 0];
  const cache = validCache(args.cache, room), deps = dependencies(ctx, room, reason, warmEnd);
  let periodRecords = periods(records, room, deps, num(object(object(object(cache.baseline).schedule).schedule_details)[room] && object(object(object(object(cache.baseline).schedule).schedule_details)[room]).last_fs));
  const hit = cache.version === cacheVersion && cache.room === room && isDeepStrictEqual(cache.dependencies, deps) && isDeepStrictEqual(cache.periods, periodRecords)
    && num(cache.valid_from, 1e20) <= at && at < num(cache.valid_until);
  let baseline: JsonObject, gradients: JsonObject, catalog: JsonObject, update: JsonValue = null;
  if (hit) {
    baseline = object(cache.baseline); gradients = object(cache.gradients); catalog = object(cache.catalog);
  } else {
    baseline = object(ctx.run('ls_room_base', { room, overrides: records, test_now: args.test_now ?? null, reason }));
    const fullCatalog = ctx.catalog && Object.keys(ctx.catalog).length ? ctx.catalog : object(ctx.run('effects_catalog'));
    catalog = { effects: object(fullCatalog.effects), processors: object(fullCatalog.processors) };
    const compiled = object(ctx.run('effects_gradient_plan', { base: baseline.targets ?? {}, warm_end: warmEnd, cached: object(cache.gradients) }));
    gradients = object(compiled.gradients);
    periodRecords = periods(records, room, deps, num(object(object(object(baseline.schedule).schedule_details)[room]).last_fs));
    update = { version: cacheVersion, room, dependencies: deps, periods: periodRecords, valid_from: at, valid_until: expiry(ctx, baseline, room, at), baseline, gradients, catalog };
  }
  baseline = refreshBaseline(ctx, baseline, cache, hit, room, deps, records, at);
  const schedule = object(baseline.schedule), stale = strings(schedule.stale_keys);
  const active = Object.fromEntries(Object.entries(records).filter(([key]) => !stale.includes(key)));
  const resolved = object(ctx.run('effects_resolve', { base: baseline.targets ?? {}, overrides: active, catalog, sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms(ctx),
    power: isObject(args.power) ? args.power : object(ctx.attr('sensor.ls_overrides', 'power')), warm_end: warmEnd, gradients }));
  const switches = object(ctx.run('ls_switch_plan', { targets: resolved.targets ?? {},
    ranges: isObject(args.ranges) ? args.ranges : object(ctx.attr('sensor.ls_overrides', 'switch_ranges')),
    defaults: isObject(args.defaults) ? args.defaults : ctx.attr('sensor.ls_overrides', 'range_defaults') ?? { bright: [90, 100], cosy: [30, 60] } }));
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...schedule, room, base: baseline.targets ?? {}, resolved, gradients, catalog, switches: switches.switches ?? {},
    revision: ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now, plan_order: timestamp(ctx.now), remote: reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null }, cache_update: update, cache_hit: hit };
}
export const planningHandlers: ScriptHandlers = { ls_room_plan: roomPlan };
