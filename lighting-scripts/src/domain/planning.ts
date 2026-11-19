import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, requireObject, withParsedArgs } from '../runtime/parse.ts';
import { storedEquals, withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { BLOCKS, blockOption, DEFAULT_BLOCK } from './blocks.ts';
import type { Block } from './blocks.ts';
import type { GradientPlanResult } from './gradient.ts';
import type { ResolutionResult } from './resolution.ts';
import type { ScheduleMirror } from './schedule.ts';
import { hasValue, labelled, nextMidnight, privateRooms } from './schedule.ts';
import { timestamp } from '../parse/accessors.ts';
import { overridesRevision } from '../parse/sensors.ts';
import { entityProfile } from '../parse/schedule.ts';
import { mappingAttribute, parseRoomBaseline, parseRoomPlanArgs, rangeDefaults, roomCatalog, stored, storedList, switchRangeEntities, warmEndOf } from '../parse/planning.ts';

/**
 * The oracle's own cache version literal, copied verbatim from
 * `reference/live/scripts/ls_room_plan.json` -- not a hash of this code. A
 * cache the live Jinja script wrote hits here too, which is why every cached
 * document is carried rather than parsed into a narrower type.
 */
const cacheVersion = 'db7981f72ee868e8d33ff1481dffb34e5e26570e8bf949a3cb2c505d7c3f37e1:input-processors-v1:preset-stream-v1';

/**
 * One stored override record, as far as room planning reads it.
 *
 * `kind`/`scope`/`target`/`via` are only ever compared with strings, so a
 * non-string stored value is `undefined` here and compares unequal to every
 * literal, exactly as the raw value did. `stored` keeps the three raw values
 * for the period tuple, which persists them. `when` and `periodUpdated` raise
 * on a malformed value, so they are read only where planning reaches them.
 */
export type OverrideFacts = {
  kind: string | undefined;
  scope: string | undefined;
  target: string | undefined;
  via: string | undefined;
  stored: { kind: Verbatim; scope: Verbatim; target: Verbatim };
  /** `value`, when it names a block. */
  valueBlock: Block | undefined;
  /** The block this record selects: `value` for a block override, else `value.period`. */
  period: Block | undefined;
  periodUpdated(): number | undefined;
  when(): number | undefined;
};
export type OverrideEntry = { key: string; document: Verbatim; lenient: OverrideFacts; record(): OverrideFacts };
/** The records in stored order, plus the mapping itself, which is forwarded unchanged. */
export type Overrides = { document: Verbatim; entries: OverrideEntry[] };

export type DetailField = 'last_fs' | 'next_fs' | 'left' | 'cur_ts';
/** The selected room's schedule details, `{}` when the schedule names none. */
export type RoomDetails = {
  document: Verbatim;
  /** `cur` as stored, `null` when absent. */
  cur: Verbatim;
  curIsNight: boolean;
  /** `cur` as a block; raises on a present value that is not one. */
  block(context: string): Block | undefined;
  /** `fading`, Jinja-truthy. */
  fading: boolean;
  /** `fading`, Jinja-truthy, with absence counting as fading. */
  fadingOrAbsent: boolean;
  /** The field, `0` when absent; raises on a present non-number. */
  number(key: DetailField, context: string): number;
  /** The field; raises when absent or not a number. */
  required(key: DetailField, context: string): number;
};
export type BaselineTarget = { document: Verbatim; isRoom: boolean };
/**
 * A room baseline: `ls_room_base`'s document on a miss, the cached one on a
 * hit. The documents are carried, and only what planning decides on is parsed.
 */
export type RoomBaseline = {
  document: Verbatim;
  targets: Verbatim;
  targetEntries: Array<{ entity: string; target(): BaselineTarget }>;
  schedule: Verbatim;
  details(room: string, context: string): RoomDetails;
  profiles: Array<{ lamp: string; profile(): Verbatim }>;
};
export type RoomCache = {
  version: string | undefined;
  room: string | undefined;
  dependencies: Verbatim;
  periods: Verbatim;
  baseline: RoomBaseline;
  gradients: Verbatim;
  catalog: Verbatim;
  validFrom: number;
  validUntil: number;
};
export type TestNow = { document: Verbatim | undefined; instant(now: string): number };
export type RoomPlanArgs = {
  room: string;
  reason: string;
  testNow: TestNow;
  overrides: Overrides;
  cache: RoomCache | undefined;
  power: Verbatim | undefined;
  ranges: Verbatim | undefined;
  defaults: Verbatim | undefined;
};

/** What the cache fingerprints. Attribute values are stored as observed. */
type Dependencies = {
  lamps: string[];
  switches: string[];
  values: Array<string | Verbatim>;
  wake: Array<string | Verbatim>;
  expiry: string;
  private: boolean;
  warm: Verbatim;
  tick: boolean;
};
type PeriodRow = [Verbatim, Verbatim, Verbatim, Block, number, boolean];
/** Computed on a miss; cached on a hit. */
type Gradients = GradientPlanResult['gradients'] | Verbatim;
type CacheUpdate = {
  version: string;
  room: string;
  dependencies: Dependencies;
  periods: Record<string, PeriodRow>;
  valid_from: number;
  valid_until: number;
  baseline: Verbatim;
  gradients: Gradients;
  catalog: Verbatim;
};
/**
 * `ls_room_plan`'s result. `plan` is the refreshed schedule document with the
 * plan's own fields over it, so it is carried: on a hit, that schedule is
 * whatever the cache's writer persisted.
 */
export type RoomPlanResult = { plan: Verbatim; cache_update: CacheUpdate | null; cache_hit: boolean };

function isRemote(r: OverrideFacts): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }
function byKey(entries: OverrideEntry[]): OverrideEntry[] {
  return [...entries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
/** The newest remote stream for the room, reading records leniently. */
function latestRemote(sorted: OverrideEntry[], room: string): string {
  let key = '', stamp = -1;
  for (const entry of sorted) {
    const r = entry.lenient;
    if (r.scope !== 'room' || r.target !== room || !isRemote(r)) continue;
    const ts = r.when() ?? 0;
    if (ts >= stamp) { key = entry.key; stamp = ts; }
  }
  return key;
}
function dependencies(ctx: ScriptContext, room: string, reason: string, warm: Verbatim): Dependencies {
  const lamps = labelled(ctx, 'house_schedule').filter(e => e.startsWith('light.') && ctx.areas[e] === room).sort();
  const switches = [...new Set([...labelled(ctx, 'on_off'), ...switchRangeEntities(ctx.attr('sensor.ls_overrides', 'switch_ranges'))])].filter(e => ctx.areas[e] === room).sort();
  const values: Array<string | Verbatim> = [];
  for (const scope of ['house', room]) for (const block of BLOCKS) {
    for (const suffix of ['start', 'weekend']) values.push(ctx.get(`input_datetime.ls_${scope}_${block}_${suffix}`));
    values.push(ctx.get(`input_number.ls_${scope}_${block}_fade`), ctx.get(`input_boolean.ls_${scope}_${block}_own_timing`), ctx.get(`input_boolean.ls_${scope}_${block}_own_light`));
  }
  for (const scope of ['house', room, ...lamps.map(e => e.replace('light.', 'lamp_'))]) for (const block of BLOCKS) {
    const entity = `light.ls_${scope}_${block}`;
    values.push(ctx.get(`input_text.ls_${scope}_${block}`), ctx.get(entity), stored(ctx.attr(entity, 'brightness')),
      stored(ctx.attr(entity, 'color_mode')), stored(ctx.attr(entity, 'color_temp_kelvin')), storedList(ctx.attr(entity, 'rgb_color')));
  }
  return { lamps, switches, values,
    wake: [ctx.get(`input_datetime.ls_${room}_wake`), stored(ctx.attr(`input_datetime.ls_${room}_wake`, 'timestamp')), ctx.get(`input_number.ls_${room}_wake_fade`)],
    expiry: ctx.get('input_boolean.ls_ovr_next_block_on'), private: privateRooms(ctx).includes(room), warm, tick: reason === 'tick' };
}
function periods(overrides: Overrides, room: string, deps: Dependencies, boundary: number): Record<string, PeriodRow> {
  const sorted = byKey(overrides.entries);
  const newest = latestRemote(sorted, room), result: Record<string, PeriodRow> = {};
  for (const entry of sorted) {
    const r = entry.record();
    const match = (r.kind === 'block' && r.target === room) || ((r.kind === 'channels' || r.kind === 'input') &&
      ((r.scope === 'room' && r.target === room) || (r.scope === 'lamp' && r.target !== undefined && deps.lamps.includes(r.target)) || (r.scope === 'house' && !deps.private)));
    const period = r.period;
    if (!match || (r.scope === 'room' && isRemote(r) && entry.key !== newest) || period === undefined) continue;
    const when = r.when() ?? 0;
    const updated = r.periodUpdated();
    const stamp = updated === undefined ? when : updated;
    result[r.scope === 'room' && isRemote(r) ? `remote-input:${room}` : entry.key] = [r.stored.kind, r.stored.scope, r.stored.target, period, stamp, deps.expiry === 'on' && when <= boundary];
  }
  return result;
}
type Refreshed = { targets: Record<string, Verbatim>; schedule: Verbatim; stale: string[] };
/** `hitFrom` is the cache's `valid_from` on a hit, `undefined` on a miss. */
function refreshBaseline(ctx: ScriptContext, baseline: RoomBaseline, hitFrom: number | undefined, room: string, deps: Dependencies, overrides: Overrides, at: number): Refreshed {
  const S = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
  const lastFs = (): number => S.number('last_fs', 'ls_room_plan schedule details');
  const targets: Record<string, Verbatim> = {}, ignoredBy = new Map<string, string[]>(), stale: string[] = [];
  for (const { entity, target } of baseline.targetEntries) {
    const t = target(), ignored: string[] = [];
    if (deps.expiry === 'on') for (const { key, record } of overrides.entries) {
      const r = record();
      const match = (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !deps.private) || (key === 'mode:sara' && !deps.private) || (r.kind === 'block' && r.target === room)
        || (!t.isRoom && ((r.scope === 'lamp' && r.target === entity) || (r.kind === 'light' && r.target === entity)));
      if (match && (r.when() ?? 0) <= lastFs()) ignored.push(key);
    }
    const observed = t.isRoom ? undefined : entityProfile(ctx, entity);
    targets[entity] = withFields(t.document, observed === undefined ? { ignore_overrides: ignored } : { ignore_overrides: ignored, observed });
    ignoredBy.set(entity, ignored);
  }
  if (deps.expiry === 'on' && !S.fading) for (const { key, record } of overrides.entries) {
    const r = record();
    const local = (r.scope === 'room' && r.target === room) || ((r.scope === 'lamp' || r.kind === 'light') && r.target !== undefined && deps.lamps.includes(r.target)) || (r.kind === 'block' && r.target === room);
    if (local && (r.when() ?? 0) <= lastFs()) stale.push(key);
  }
  const blockKey = `block:${room}`;
  const chosen = overrides.entries.find(entry => entry.key === blockKey)?.record().valueBlock;
  // The captured source spells this `(S.get('cur') or 'night') | capitalize`.
  // We deliberately do not reproduce either half (mandate v2): `or` would make
  // a cached 0 or '' mean Night, hiding a malformed cache, and `| capitalize`
  // would quietly repair 'NIGHT'. Here an absent or null `cur` means "no block
  // decided yet" and falls back to Night, a valid block is used as-is, and
  // anything else raises. The option label comes from the union, so there is no
  // string transformation left to get wrong.
  const override = chosen !== undefined && !stale.includes(blockKey) ? chosen : undefined;
  const effective = override ?? S.block('ls_room_plan schedule details.cur') ?? DEFAULT_BLOCK;
  const entity = `input_select.ls_${room}_override`, option = blockOption(effective);
  const mirrors: ScheduleMirror[] = ctx.state[entity] !== undefined && ctx.get(entity) !== option ? [{ entity, option }] : [];
  const profiles: Record<string, Verbatim> = {};
  for (const { lamp, profile: p } of baseline.profiles) {
    // Raises when a profile names a lamp the baseline has no target for.
    requireObject(targets, lamp, 'ls_room_plan refreshed targets');
    profiles[lamp] = withFields(p(), { ignore_overrides: ignoredBy.get(lamp) ?? [] });
  }
  const details = hitFrom === undefined ? S.document : withFields(S.document, {
    left: hitFrom + S.required('left', 'ls_room_plan schedule details') - at,
    edge: at - S.required('cur_ts', 'ls_room_plan schedule details') < 90,
  });
  const schedule = withFields(baseline.schedule, { profiles, sched: { [room]: S.cur }, schedule_details: { [room]: details }, stale_keys: stale, mirror: mirrors });
  return { targets, schedule, stale };
}
function expiry(ctx: ScriptContext, baseline: RoomBaseline, room: string, at: number): number {
  const S = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
  const field = (key: DetailField): number => S.number(key, 'ls_room_plan schedule details');
  const deadlines = [nextMidnight(at, ctx.timezone ?? 'Europe/Stockholm')];
  let moving = S.fadingOrAbsent;
  for (const boundary of [field('next_fs'), at + field('left'), field('cur_ts') + 90]) if (boundary > at) deadlines.push(boundary);
  if (hasValue(ctx, `input_datetime.ls_${room}_wake`)) {
    const wake = jinjaFloat(ctx.attr(`input_datetime.ls_${room}_wake`, 'timestamp'));
    const duration = jinjaFloat(ctx.get(`input_number.ls_${room}_wake_fade`), 37.5) * 60;
    for (const boundary of [wake, wake + duration, wake + duration + 90, wake + 86400]) if (boundary > at) deadlines.push(boundary);
    if (at - wake >= 0 && at - wake < duration && S.curIsNight && field('cur_ts') <= wake) moving = true;
  }
  return moving ? at : Math.min(...deadlines);
}

export function roomPlan(ctx: ScriptContext, args: RoomPlanArgs): RoomPlanResult {
  const { room, reason, overrides, cache } = args;
  const at = args.testNow.instant(ctx.now);
  // Captured: the first variables block reads the revision bare, after `at` and
  // ahead of every action, so a missing sensor raises before any script runs.
  const revision = overridesRevision(ctx, 'ls_room_plan');
  const warmEnd = warmEndOf(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  const deps = dependencies(ctx, room, reason, warmEnd);
  const cachedDetails = cache === undefined ? undefined : cache.baseline.details(room, 'ls_room_plan.cache.baseline.schedule.schedule_details');
  let periodRecords = periods(overrides, room, deps, cachedDetails === undefined ? 0 : cachedDetails.number('last_fs', 'ls_room_plan cached schedule details'));
  const hit = cache !== undefined && cache.version === cacheVersion && cache.room === room && storedEquals(cache.dependencies, deps) && storedEquals(cache.periods, periodRecords)
    && cache.validFrom <= at && at < cache.validUntil;
  let baseline: RoomBaseline, gradients: Gradients, catalog: Verbatim, update: CacheUpdate | null = null;
  if (hit) {
    baseline = cache.baseline; gradients = cache.gradients; catalog = cache.catalog;
  } else {
    baseline = parseRoomBaseline(ctx.run('ls_room_base', { room, overrides: overrides.document, test_now: args.testNow.document ?? null, reason }), 'ls_room_plan baseline');
    catalog = roomCatalog(ctx.rawCatalog(), () => ctx.run('effects_catalog'));
    gradients = ctx.call('effects_gradient_plan', { base: baseline.targets, warm_end: warmEnd, cached: cache === undefined ? {} : cache.gradients }).gradients;
    const details = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
    periodRecords = periods(overrides, room, deps, details.number('last_fs', 'ls_room_plan schedule details'));
    update = { version: cacheVersion, room, dependencies: deps, periods: periodRecords, valid_from: at, valid_until: expiry(ctx, baseline, room, at), baseline: baseline.document, gradients, catalog };
  }
  const refreshed = refreshBaseline(ctx, baseline, hit ? cache.validFrom : undefined, room, deps, overrides, at);
  const stale = refreshed.stale;
  const active = Object.fromEntries(overrides.entries.filter(entry => !stale.includes(entry.key)).map(entry => [entry.key, entry.document]));
  const resolved: ResolutionResult = ctx.call('effects_resolve', { base: refreshed.targets, overrides: active, catalog, sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms(ctx),
    power: args.power ?? mappingAttribute(ctx.attr('sensor.ls_overrides', 'power')), warm_end: warmEnd, gradients });
  // `?? {}` on both results is gone, not dropped as decoration: `switchPlan`
  // and `resolveEffects` always return their key, so the fallbacks were
  // unreachable for the real handlers and the types now say so.
  const switches = ctx.call('ls_switch_plan', { targets: resolved.targets,
    ranges: args.ranges ?? mappingAttribute(ctx.attr('sensor.ls_overrides', 'switch_ranges')),
    defaults: args.defaults ?? rangeDefaults(ctx.attr('sensor.ls_overrides', 'range_defaults')) });
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: withFields(refreshed.schedule, { room, base: refreshed.targets, resolved, gradients, catalog, switches: switches.switches,
    revision, plan_order: timestamp(ctx.now), remote: reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null }), cache_update: update, cache_hit: hit };
}
export const planningHandlers: ScriptHandlers = {
  // Argument parsing, the cache's validity test and every document read live in
  // `src/parse/planning.ts`; see `parseRoomPlanArgs` for the captured sources.
  ls_room_plan: withParsedArgs({ parse: parseRoomPlanArgs, run: roomPlan }),
};
