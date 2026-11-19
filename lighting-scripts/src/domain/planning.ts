import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { storedEquals, withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { BLOCKS, blockOption, DEFAULT_BLOCK } from './blocks.ts';
import type { Block } from './blocks.ts';
import type { GradientPlanResult } from './gradient.ts';
import type { ResolutionResult } from './resolution.ts';
import type { ScheduleMirror } from './schedule.ts';
import type { SwitchDecision } from './controller.ts';
import type { HouseView } from '../runtime/effects.ts';
import { hasValue, labelled, nextMidnight, privateRooms } from './schedule.ts';
import { timestamp } from '../parse/accessors.ts';
import { overridesRevision } from '../parse/sensors.ts';
import { entityProfile } from '../parse/schedule.ts';
import {
  mappingAttribute, parseRoomBaseline, parseRoomPlanArgs, rangeDefaults, roomCatalog, stored, storedList, switchRangeEntities, wakeFadeMinutes,
  wakeTimestamp, warmEndOf,
} from '../parse/planning.ts';

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
  /** `cur` as a block, read leniently: Night when absent, falsy or unreadable. */
  block: Block;
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
  /** `profile()` raises when the lamp has no baseline target, then reads the profile. */
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
export type Dependencies = {
  lamps: string[];
  switches: string[];
  values: Array<string | Verbatim>;
  wake: Array<string | Verbatim>;
  expiry: string;
  private: boolean;
  warm: Verbatim;
  tick: boolean;
};
export type PeriodRow = [Verbatim, Verbatim, Verbatim, Block, number, boolean];
/** Computed on a miss; cached on a hit. */
export type Gradients = GradientPlanResult['gradients'] | Verbatim;
export type CacheUpdate = {
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
/** The cache fingerprint: what the room's plan depends on, as observed now. */
export function dependencies(view: HouseView, room: string, reason: string, warm: Verbatim): Dependencies {
  const lamps = labelled(view, 'house_schedule').filter(e => e.startsWith('light.') && view.areas[e] === room).sort();
  const switches = [...new Set([...labelled(view, 'on_off'), ...switchRangeEntities(view.attr('sensor.ls_overrides', 'switch_ranges'))])].filter(e => view.areas[e] === room).sort();
  const values: Array<string | Verbatim> = [];
  for (const scope of ['house', room]) for (const block of BLOCKS) {
    for (const suffix of ['start', 'weekend']) values.push(view.get(`input_datetime.ls_${scope}_${block}_${suffix}`));
    values.push(view.get(`input_number.ls_${scope}_${block}_fade`), view.get(`input_boolean.ls_${scope}_${block}_own_timing`), view.get(`input_boolean.ls_${scope}_${block}_own_light`));
  }
  for (const scope of ['house', room, ...lamps.map(e => e.replace('light.', 'lamp_'))]) for (const block of BLOCKS) {
    const entity = `light.ls_${scope}_${block}`;
    values.push(view.get(`input_text.ls_${scope}_${block}`), view.get(entity), stored(view.attr(entity, 'brightness')),
      stored(view.attr(entity, 'color_mode')), stored(view.attr(entity, 'color_temp_kelvin')), storedList(view.attr(entity, 'rgb_color')));
  }
  return { lamps, switches, values,
    wake: [view.get(`input_datetime.ls_${room}_wake`), stored(view.attr(`input_datetime.ls_${room}_wake`, 'timestamp')), view.get(`input_number.ls_${room}_wake_fade`)],
    expiry: view.get('input_boolean.ls_ovr_next_block_on'), private: privateRooms(view).includes(room), warm, tick: reason === 'tick' };
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
export type Refreshed = { targets: Record<string, Verbatim>; schedule: Verbatim; stale: string[] };
/** `hitFrom` is the cache's `valid_from` on a hit, `undefined` on a miss. */
export function refreshBaseline(view: HouseView, baseline: RoomBaseline, hitFrom: number | undefined, room: string, deps: Dependencies, overrides: Overrides, at: number): Refreshed {
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
    const observed = t.isRoom ? undefined : entityProfile(view, entity);
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
  // The saved `cur` arrives already parsed by the lenient `savedBlock`: absent
  // or Jinja-falsy means Night, a block name in any case is that block, and
  // anything else falls back to Night. It never raises. The option label comes
  // from the union, so there is no string transformation left to get wrong.
  const override = chosen !== undefined && !stale.includes(blockKey) ? chosen : undefined;
  const effective = override ?? S.block;
  const entity = `input_select.ls_${room}_override`, option = blockOption(effective);
  const mirrors: ScheduleMirror[] = view.state[entity] !== undefined && view.get(entity) !== option ? [{ entity, option }] : [];
  const profiles: Record<string, Verbatim> = {};
  for (const { lamp, profile: p } of baseline.profiles) {
    // `p()` raises when the profile names a lamp the baseline has no target for.
    profiles[lamp] = withFields(p(), { ignore_overrides: ignoredBy.get(lamp) ?? [] });
  }
  const details = hitFrom === undefined ? S.document : withFields(S.document, {
    left: hitFrom + S.required('left', 'ls_room_plan schedule details') - at,
    edge: at - S.required('cur_ts', 'ls_room_plan schedule details') < 90,
  });
  const schedule = withFields(baseline.schedule, { profiles, sched: { [room]: S.cur }, schedule_details: { [room]: details }, stale_keys: stale, mirror: mirrors });
  return { targets, schedule, stale };
}
/** When the room's cache stops being valid: now while the room is moving, else its next boundary. */
export function expiry(view: HouseView, baseline: RoomBaseline, room: string, at: number): number {
  const S = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
  const field = (key: DetailField): number => S.number(key, 'ls_room_plan schedule details');
  const deadlines = [nextMidnight(at, view.timezone ?? 'Europe/Stockholm')];
  let moving = S.fadingOrAbsent;
  for (const boundary of [field('next_fs'), at + field('left'), field('cur_ts') + 90]) if (boundary > at) deadlines.push(boundary);
  if (hasValue(view, `input_datetime.ls_${room}_wake`)) {
    const wake = wakeTimestamp(view, room);
    const duration = wakeFadeMinutes(view, room) * 60;
    for (const boundary of [wake, wake + duration, wake + duration + 90, wake + 86400]) if (boundary > at) deadlines.push(boundary);
    if (at - wake >= 0 && at - wake < duration && S.curIsNight && field('cur_ts') <= wake) moving = true;
  }
  return moving ? at : Math.min(...deadlines);
}

/**
 * Plan one room: the opening reads, then the cache hit or the miss's three
 * inter-handler runs, then the refresh, `effects_resolve` and `ls_switch_plan`.
 * Every read after a run is made on the house as that run left it.
 */
export function roomPlan(ctx: ScriptContext, args: RoomPlanArgs): RoomPlanResult {
  const { room, reason, overrides, cache } = args;
  const opening = roomOpening(ctx, args);
  const { at, warmEnd } = opening;
  const hit = opening.hit;
  let baseline: RoomBaseline, gradients: Gradients, catalog: Verbatim, update: CacheUpdate | null = null;
  if (hit !== undefined) {
    baseline = hit.baseline; gradients = hit.gradients; catalog = hit.catalog;
  } else {
    baseline = parseRoomBaseline(ctx.run('ls_room_base', { room, overrides: overrides.document, test_now: args.testNow.document ?? null, reason }), 'ls_room_plan baseline');
    catalog = roomCatalog(ctx.rawCatalog(), () => ctx.run('effects_catalog'));
    gradients = ctx.call('effects_gradient_plan', { base: baseline.targets, warm_end: warmEnd, cached: cache === undefined ? {} : cache.gradients }).gradients;
    update = missUpdate(ctx, args, opening, baseline, gradients, catalog);
  }
  const refreshed = refreshBaseline(ctx, baseline, hit === undefined ? undefined : hit.validFrom, room, opening.deps, overrides, at);
  const active = activeOverrides(overrides, refreshed.stale);
  const resolved: ResolutionResult = ctx.call('effects_resolve', { base: refreshed.targets, overrides: active, catalog, sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms(ctx),
    power: args.power ?? mappingAttribute(ctx.attr('sensor.ls_overrides', 'power')), warm_end: warmEnd, gradients });
  // `?? {}` on both results is gone, not dropped as decoration: `switchPlan`
  // and `resolveEffects` always return their key, so the fallbacks were
  // unreachable for the real handlers and the types now say so.
  const switches = ctx.call('ls_switch_plan', { targets: resolved.targets,
    ranges: args.ranges ?? mappingAttribute(ctx.attr('sensor.ls_overrides', 'switch_ranges')),
    defaults: args.defaults ?? rangeDefaults(ctx.attr('sensor.ls_overrides', 'range_defaults')) });
  return roomPlanAnswer(ctx, { room, reason, revision: opening.revision, refreshed, active, resolved, gradients, catalog,
    switches: switches.switches, update, hit: hit !== undefined });
}

/** What `ls_room_plan` reads before any run: the instant, the revision, the fingerprint and the cache test. */
export interface RoomOpening {
  at: number;
  revision: string;
  warmEnd: Verbatim;
  deps: Dependencies;
  /** The period records, against the cached schedule's `last_fs`. */
  periods: Record<string, PeriodRow>;
  /** The cache, when it still holds for this room, fingerprint and instant. */
  hit: RoomCache | undefined;
}

export function roomOpening(view: HouseView, args: RoomPlanArgs): RoomOpening {
  const { room, reason, overrides, cache } = args;
  const at = args.testNow.instant(view.now);
  // Captured: the first variables block reads the revision bare, after `at` and
  // ahead of every action, so a missing sensor raises before any script runs.
  const revision = overridesRevision(view, 'ls_room_plan');
  const warmEnd = warmEndOf(view.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  const deps = dependencies(view, room, reason, warmEnd);
  const cachedDetails = cache === undefined ? undefined : cache.baseline.details(room, 'ls_room_plan.cache.baseline.schedule.schedule_details');
  const periodRecords = periods(overrides, room, deps, cachedDetails === undefined ? 0 : cachedDetails.number('last_fs', 'ls_room_plan cached schedule details'));
  const hit = cache !== undefined && cache.version === cacheVersion && cache.room === room && storedEquals(cache.dependencies, deps)
    && storedEquals(cache.periods, periodRecords) && cache.validFrom <= at && at < cache.validUntil;
  return { at, revision, warmEnd, deps, periods: periodRecords, hit: hit ? cache : undefined };
}

/** A miss's new cache, read after the baseline, catalog and gradient runs. */
export function missUpdate(view: HouseView, args: RoomPlanArgs, opening: RoomOpening, baseline: RoomBaseline, gradients: Gradients, catalog: Verbatim): CacheUpdate {
  const { room } = args, { at, deps } = opening;
  const details = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
  const periodRecords = periods(args.overrides, room, deps, details.number('last_fs', 'ls_room_plan schedule details'));
  return { version: cacheVersion, room, dependencies: deps, periods: periodRecords, valid_from: at, valid_until: expiry(view, baseline, room, at),
    baseline: baseline.document, gradients, catalog };
}

/** The stored overrides the refresh did not mark stale, as stored. */
function activeOverrides(overrides: Overrides, stale: string[]): Record<string, Verbatim> {
  return Object.fromEntries(overrides.entries.filter(entry => !stale.includes(entry.key)).map(entry => [entry.key, entry.document]));
}

/** The parts `ls_room_plan` answers with, once every run is done. */
export interface RoomPlanParts {
  room: string;
  reason: string;
  revision: string;
  refreshed: Refreshed;
  active: Record<string, Verbatim>;
  resolved: ResolutionResult;
  gradients: Gradients;
  catalog: Verbatim;
  switches: Record<string, SwitchDecision>;
  update: CacheUpdate | null;
  hit: boolean;
}

/** The answer: the refreshed schedule with the plan over it, stamped with `now` as read last. */
export function roomPlanAnswer(view: HouseView, parts: RoomPlanParts): RoomPlanResult {
  const { room, reason, refreshed, active } = parts;
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: withFields(refreshed.schedule, { room, base: refreshed.targets, resolved: parts.resolved, gradients: parts.gradients,
    catalog: parts.catalog, switches: parts.switches,
    revision: parts.revision, plan_order: timestamp(view.now), remote: reason === 'remote',
    sara_mirror: view.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null }), cache_update: parts.update, cache_hit: parts.hit };
}
export const planningHandlers: ScriptHandlers = {
  // Argument parsing, the cache's validity test and every document read live in
  // `src/parse/planning.ts`; see `parseRoomPlanArgs` for the captured sources.
  ls_room_plan: withParsedArgs({ parse: parseRoomPlanArgs, run: roomPlan }),
};
