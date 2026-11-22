import { storedEquals, withFields, withoutField } from '../../runtime/verbatim.ts';
import type { Verbatim } from '../../runtime/verbatim.ts';
import { BLOCKS, blockOption } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type { CompiledGradients } from './gradient.ts';
import type { Resolution } from './resolution.ts';
import type { ScheduleMirror } from './schedule.ts';
import type { SwitchDecision } from './controller.ts';
import type { HouseView } from '../../runtime/effects.ts';
import { hasValue, labelled, nextMidnight, privateRooms } from './schedule.ts';
import { timestamp } from '../../parse/accessors.ts';
import { overridesRevision } from '../../parse/sensors.ts';
import { entityProfile } from '../../parse/schedule.ts';
import type { StoredFact, StoredValue } from '../../parse/overrides.ts';
import { stored, storedList, switchRangeEntities, wakeFadeMinutes, wakeTimestamp, warmEndOf } from '../../parse/planning.ts';
import type { RoomId, SwitchId } from '../../domain/types/ids.ts';
import type { LampOrRoom } from '../../domain/types/lighting-state.ts';
import { byOverlayKeyText, EMPTY_KEY, overlayKeyText, sameOverlayKey, SARA_MODE } from '../../domain/types/overlay.ts';
import type { OverlayKey } from '../../domain/types/overlay.ts';

/**
 * The oracle's own cache version literal, copied verbatim from
 * `reference/live/scripts/ls_room_plan.json` -- not a hash of this code --
 * with `:off-lamp-v1` appended (2026-11-20). A cached baseline from before
 * then holds off lamps as a made-up white 255 (`{kelvin: 3000}` targets, white
 * observed and anchors); the new suffix makes every such cache miss once and
 * be rebuilt in the honest shape. A cache the live Jinja script wrote misses
 * for the same reason. Cached documents are still carried rather than parsed.
 */
const cacheVersion = 'db7981f72ee868e8d33ff1481dffb34e5e26570e8bf949a3cb2c505d7c3f37e1:input-processors-v1:preset-stream-v1:off-lamp-v1';

/**
 * One stored override record, as far as room planning reads it.
 *
 * `kind`/`scope`/`target`/`via` are only ever compared with strings, so a
 * non-string stored value is `undefined` here and compares unequal to every
 * literal, exactly as the raw value did. `stored` keeps the three raw values
 * for the period tuple, which persists them. A saved record, so nothing here
 * raises (directive 2026-11-19): `when` is the captured `as_timestamp(when, 0)`
 * and `periodUpdated` is carried as stored, as the captured tuple stores it.
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
  /** `value.period_updated` as stored, `undefined` when absent. */
  periodUpdated: StoredFact;
  when: number;
};
function isRemote(r: OverrideFacts): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }
/** A stored record; `record` is `undefined` for one that is not a mapping, which every captured loop skips. */
export type OverrideEntry = { key: OverlayKey; document: Verbatim; record: OverrideFacts | undefined };

function byKey(entries: OverrideEntry[]): OverrideEntry[] {
  return [...entries].sort((a, b) => byOverlayKeyText(a.key, b.key));
}
/** The newest remote stream for the room, reading records leniently. */
function latestRemote(sorted: OverrideEntry[], room: RoomId): OverlayKey {
  // The scripts start from the empty key and keep it when no remote record applies.
  let key: OverlayKey = EMPTY_KEY, stamp = -1;
  for (const entry of sorted) {
    const r = entry.record;
    if (r === undefined || r.scope !== 'room' || r.target !== room || !isRemote(r)) continue;
    const ts = r.when;
    if (ts >= stamp) { key = entry.key; stamp = ts; }
  }
  return key;
}
/** The records in stored order, plus the mapping itself, which is forwarded unchanged. */
export type Overrides = { document: Verbatim; entries: OverrideEntry[] };
/** The stored overrides the refresh did not mark stale, as stored. */
export function activeOverrides(overrides: Overrides, stale: OverlayKey[]): Record<string, Verbatim> {
  return Object.fromEntries(overrides.entries.filter(entry => !stale.some(key => sameOverlayKey(key, entry.key)))
    .map(entry => [overlayKeyText(entry.key), entry.document]));
}
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

export type BaselineTarget = { document: Verbatim; lampOrRoom: LampOrRoom };
/**
 * A room baseline: `ls_room_base`'s document on a miss, the cached one on a
 * hit. The documents are carried, and only what planning decides on is parsed.
 */
export type RoomBaseline = {
  document: Verbatim;
  targets: Verbatim;
  targetEntries: Array<{ entity: string; target(): BaselineTarget }>;
  schedule: Verbatim;
  details(room: RoomId, context: string): RoomDetails;
  /** `profile()` raises when the lamp has no baseline target, then reads the profile. */
  profiles: Array<{ lamp: string; profile(): Verbatim }>;
};
/** When the room's cache stops being valid: now while the room is moving, else its next boundary. */
export function expiry(view: HouseView, baseline: RoomBaseline, room: RoomId, at: number): number {
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
export type RoomCache = {
  version: string | undefined;
  room: RoomId | undefined;
  dependencies: Verbatim;
  periods: Verbatim;
  baseline: RoomBaseline;
  gradients: Verbatim;
  catalog: Verbatim;
  validFrom: number;
  validUntil: number;
};
export type TestNow = { document: Verbatim | undefined; instant(now: string): number };

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
/** The cache fingerprint: what the room's plan depends on, as observed now. */
export function dependencies(view: HouseView, room: RoomId, reason: string, warm: Verbatim): Dependencies {
  const lamps = labelled(view, 'house_schedule').filter(e => e.startsWith('light.') && view.rooms.ofId[e] === room).sort();
  const switches = [...new Set([...labelled(view, 'on_off'), ...switchRangeEntities(view.attr('sensor.ls_overrides',
    'switch_ranges'))])].filter(e => view.rooms.ofId[e] === room).sort();
  const values: Array<string | Verbatim> = [];
  for (const scope of ['house', room]) for (const block of BLOCKS) {
    for (const suffix of ['start', 'weekend']) values.push(view.get(`input_datetime.ls_${scope}_${block}_${suffix}`));
    values.push(view.get(`input_number.ls_${scope}_${block}_fade`), view.get(`input_boolean.ls_${scope}_${block}_own_timing`),
      view.get(`input_boolean.ls_${scope}_${block}_own_light`));
  }
  for (const scope of ['house', room, ...lamps.map(e => e.replace('light.', 'lamp_'))]) for (const block of BLOCKS) {
    const entity = `light.ls_${scope}_${block}`;
    values.push(view.get(`input_text.ls_${scope}_${block}`), view.get(entity), stored(view.attr(entity, 'brightness')),
      stored(view.attr(entity, 'color_mode')), stored(view.attr(entity, 'color_temp_kelvin')), storedList(view.attr(entity, 'rgb_color')));
  }
  return { lamps, switches, values,
    wake: [view.get(`input_datetime.ls_${room}_wake`), stored(view.attr(`input_datetime.ls_${room}_wake`, 'timestamp')),
      view.get(`input_number.ls_${room}_wake_fade`)],
    expiry: view.get('input_boolean.ls_ovr_next_block_on'), private: privateRooms(view).includes(room), warm, tick: reason === 'tick' };
}
export type PeriodRow = [Verbatim, Verbatim, Verbatim, Block, StoredValue, boolean];
/** Computed on a miss; cached on a hit. */
export type Gradients = CompiledGradients | Verbatim;
export type CacheUpdate = {
  version: string;
  room: RoomId;
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
export type RoomPlan = { plan: Verbatim; cache_update: CacheUpdate | null; cache_hit: boolean };
export type Refreshed = { targets: Record<string, Verbatim>; schedule: Verbatim; stale: OverlayKey[] };
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


export type RoomPlanRequest = {
  room: RoomId;
  reason: string;
  testNow: TestNow;
  overrides: Overrides;
  cache: RoomCache | undefined;
  power: Verbatim | undefined;
  ranges: Verbatim | undefined;
  defaults: Verbatim | undefined;
};

/** `hitFrom` is the cache's `valid_from` on a hit, `undefined` on a miss. */
export function refreshBaseline(view: HouseView, baseline: RoomBaseline, hitFrom: number | undefined, room: RoomId, deps: Dependencies,
  overrides: Overrides, at: number): Refreshed {
  const S = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
  const lastFs = (): number => S.number('last_fs', 'ls_room_plan schedule details');
  const targets: Record<string, Verbatim> = {}, ignoredBy = new Map<string, OverlayKey[]>(), stale: OverlayKey[] = [];
  for (const { entity, target } of baseline.targetEntries) {
    const t = target(), ignored: OverlayKey[] = [];
    if (deps.expiry === 'on') for (const { key, record } of overrides.entries) {
      if (record === undefined) continue;
      const r = record;
      const match = (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !deps.private) || (key.kind === 'sara mode' &&
        !deps.private) || (r.kind === 'block' && r.target === room)
        || (t.lampOrRoom.kind === 'lamp' && (r.scope === 'lamp' || r.kind === 'light') && r.target === t.lampOrRoom.lamp);
      if (match && r.when <= lastFs()) ignored.push(key);
    }
    // A lamp's reading is re-taken now: off is `{on: false}`, and a lamp that is
    // missing or unavailable has no reading, so a cached one is dropped.
    const refreshed = withFields(t.document, { ignore_overrides: ignored.map(overlayKeyText) });
    if (t.lampOrRoom.kind === 'room') targets[entity] = refreshed;
    else {
      const observed = entityProfile(view, t.lampOrRoom.lamp);
      targets[entity] = observed === undefined ? withoutField(refreshed, 'observed') : withFields(refreshed, { observed });
    }
    ignoredBy.set(entity, ignored);
  }
  if (deps.expiry === 'on' && !S.fading) for (const { key, record } of overrides.entries) {
    if (record === undefined) continue;
    const r = record;
    const local = (r.scope === 'room' && r.target === room) || ((r.scope === 'lamp' || r.kind === 'light') && r.target !== undefined &&
      deps.lamps.includes(r.target)) || (r.kind === 'block' && r.target === room);
    if (local && r.when <= lastFs()) stale.push(key);
  }
  const blockKey: OverlayKey = { kind: 'block', scope: room };
  const chosen = overrides.entries.find(entry => sameOverlayKey(entry.key, blockKey))?.record?.valueBlock;
  // The captured source spells this `(S.get('cur') or 'night') | capitalize`.
  // The saved `cur` arrives already parsed by the lenient `savedBlock`: absent
  // or Jinja-falsy means Night, a block name in any case is that block, and
  // anything else falls back to Night. It never raises. The option label comes
  // from the union, so there is no string transformation left to get wrong.
  const override = chosen !== undefined && !stale.some(key => sameOverlayKey(key, blockKey)) ? chosen : undefined;
  const effective = override ?? S.block;
  const entity = `input_select.ls_${room}_override`, option = blockOption(effective);
  const mirrors: ScheduleMirror[] = view.state[entity] !== undefined && view.get(entity) !== option ? [{ entity, option }] : [];
  const profiles: Record<string, Verbatim> = {};
  for (const { lamp, profile: p } of baseline.profiles) {
    // `p()` raises when the profile names a lamp the baseline has no target for.
    profiles[lamp] = withFields(p(), { ignore_overrides: (ignoredBy.get(lamp) ?? []).map(overlayKeyText) });
  }
  const details = hitFrom === undefined ? S.document : withFields(S.document, {
    left: hitFrom + S.required('left', 'ls_room_plan schedule details') - at,
    edge: at - S.required('cur_ts', 'ls_room_plan schedule details') < 90,
  });
  const schedule = withFields(baseline.schedule, { profiles, sched: { [room]: S.cur }, schedule_details: { [room]: details },
    stale_keys: stale.map(overlayKeyText), mirror: mirrors });
  return { targets, schedule, stale };
}
export function roomOpening(view: HouseView, args: RoomPlanRequest): RoomOpening {
  const { room, reason, overrides, cache } = args;
  const at = args.testNow.instant(view.now);
  // Captured: the first variables block reads the revision bare, after `at` and
  // ahead of every action, so a missing sensor raises before any script runs.
  const revision = overridesRevision(view, 'ls_room_plan');
  const warmEnd = warmEndOf(view.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  const deps = dependencies(view, room, reason, warmEnd);
  const cachedDetails = cache === undefined ? undefined : cache.baseline.details(room, 'ls_room_plan.cache.baseline.schedule.schedule_details');
  const periodRecords = periods(overrides, room, deps, cachedDetails === undefined ? 0 : cachedDetails.number('last_fs',
    'ls_room_plan cached schedule details'));
  const hit = cache !== undefined && cache.version === cacheVersion && cache.room === room && storedEquals(cache.dependencies, deps)
    && storedEquals(cache.periods, periodRecords) && cache.validFrom <= at && at < cache.validUntil;
  return { at, revision, warmEnd, deps, periods: periodRecords, hit: hit ? cache : undefined };
}

function periods(overrides: Overrides, room: RoomId, deps: Dependencies, boundary: number): Record<string, PeriodRow> {
  const sorted = byKey(overrides.entries);
  const newest = latestRemote(sorted, room), result: Record<string, PeriodRow> = {};
  for (const entry of sorted) {
    const r = entry.record;
    if (r === undefined) continue;
    const match = (r.kind === 'block' && r.target === room) || ((r.kind === 'channels' || r.kind === 'input') &&
      ((r.scope === 'room' && r.target === room) || (r.scope === 'lamp' && r.target !== undefined && deps.lamps.includes(r.target)) ||
        (r.scope === 'house' && !deps.private)));
    const period = r.period;
    if (!match || (r.scope === 'room' && isRemote(r) && !sameOverlayKey(entry.key, newest)) || period === undefined) continue;
    const when = r.when;
    const stamp = r.periodUpdated === undefined ? when : r.periodUpdated;
    result[r.scope === 'room' && isRemote(r) ? `remote-input:${room}` : overlayKeyText(entry.key)] = [r.stored.kind, r.stored.scope, r.stored.target,
      period, stamp, deps.expiry === 'on' && when <= boundary];
  }
  return result;
}

/** A miss's new cache, read after the baseline, catalog and gradient runs. */
export function missUpdate(view: HouseView, args: RoomPlanRequest, opening: RoomOpening, baseline: RoomBaseline, gradients: Gradients,
  catalog: Verbatim): CacheUpdate {
  const { room } = args, { at, deps } = opening;
  const details = baseline.details(room, 'ls_room_plan.baseline.schedule.schedule_details');
  const periodRecords = periods(args.overrides, room, deps, details.number('last_fs', 'ls_room_plan schedule details'));
  return { version: cacheVersion, room, dependencies: deps, periods: periodRecords, valid_from: at, valid_until: expiry(view, baseline, room, at),
    baseline: baseline.document, gradients, catalog };
}

/**
 * The answer: the refreshed schedule with the plan over it, stamped with
 * `now` as read last, from the parts `ls_room_plan` answers with once every
 * run is done.
 */
export function roomPlanAnswer(view: HouseView, parts: {
  room: RoomId; reason: string; revision: string; refreshed: Refreshed; active: Record<string, Verbatim>; resolved: Resolution;
  gradients: Gradients; catalog: Verbatim; switches: Record<SwitchId, SwitchDecision>; update: CacheUpdate | null; hit: boolean;
}): RoomPlan {
  const { room, reason, refreshed, active } = parts;
  const wanted = Object.hasOwn(active, overlayKeyText(SARA_MODE)) ? 'on' : 'off';
  return { plan: withFields(refreshed.schedule, { room, base: refreshed.targets, resolved: parts.resolved, gradients: parts.gradients,
    catalog: parts.catalog, switches: parts.switches,
    revision: parts.revision, plan_order: timestamp(view.now), remote: reason === 'remote',
    sara_mirror: view.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null }), cache_update: parts.update, cache_hit: parts.hit };
}
