/**
 * Parsing for `ls_remote_plan`: the stored remote input record and its value,
 * the other stored records the restart check reads, the `ls_room_plan` answer
 * the preset arrows read, and the override sensor's `power` attribute.
 *
 * The input value is carried, never narrowed: the planner rebuilds it by
 * spreading the stored document and setting a few keys, so every key it does
 * not name reaches the new record in place. Its numbers are read where the
 * inline reads sat (lazily, with `num()`'s own `schedule number` message), and
 * every fact compared by identity is a stored fact.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaTruthy, object, requireString } from '../runtime/parse.ts';
import { carry, carryOptional } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { list, num, savedNumberOr } from './accessors.ts';
import { latestRemoteKey, savedWhen } from './resolution.ts';
import { assembledMap, storedFact } from './overrides.ts';
import type { Assembled, AssembledMap, StoredFact, StoredValue } from './overrides.ts';
import type { Adjustment, RemotePlanArgs } from '../domain/remote-input.ts';

const OVERRIDES = 'sensor.ls_overrides';
const numeric = (v: JsonValue | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** The captured default `step_range`, `{'min':-20,'max':20}`. */
const DEFAULT_STEP_RANGE = { min: -20, max: 20 } as const;

/**
 * A stored adjustment (or selection input): its document, and its numbers.
 * Each number is read by {@link savedNumberOr} with the identity adjustment's
 * value as its named default -- `updated` 0 (the captured `.get('updated',0)`),
 * `lower`/`upper` the step range's ends, `steps` 0 -- where the captured
 * arithmetic raises. `has_up` is the captured Jinja `or`.
 */
function storedAdjustment(document: JsonObject, range: { min: number; max: number }): Adjustment {
  return {
    fields: assembledMap(document),
    updated: () => savedNumberOr(document.updated, 0),
    lower: () => savedNumberOr(document.lower, range.min),
    upper: () => savedNumberOr(document.upper, range.max),
    steps: () => savedNumberOr(document.steps, 0),
    hasUp: pressedUp => document.has_up !== undefined && jinjaTruthy(document.has_up) ? storedFact(document.has_up) : pressedUp,
  };
}

/** A remote input record's `value`, read leniently: a non-mapping is `{}`. */
export interface RemoteInputValue {
  /** The stored entries, in stored order. */
  fields: AssembledMap;
  /** `step_range` as stored (or the default), and its bounds when they are valid. */
  stepRange: { document: Assembled; bounds: { min: number; max: number } | undefined };
  /** `adjustment`, else `selection_input`, when a mapping. */
  adjustment: Adjustment | undefined;
  /** `position`, when a Jinja number (booleans included). */
  legacyPosition: number | boolean | undefined;
  /** `channels` as stored, when one of them runs an effect. */
  effectChannels: StoredValue | undefined;
  selection: StoredFact;
  /** `preset_contexts` read leniently; entries carried. */
  presetContexts: AssembledMap;
  /** `remote_valid_until`, absent or not comparable read as 0. */
  validUntil(): number;
  timingRevision: StoredFact;
}

function inputValue(raw: JsonValue | undefined): RemoteInputValue {
  const value = object(raw);
  const range = Object.hasOwn(value, 'step_range') ? value.step_range : { ...DEFAULT_STEP_RANGE };
  const bounds = isObject(range) && numeric(range.min) && numeric(range.max)
    && -20 <= range.min && range.min <= range.max && range.max <= 20 ? { min: range.min, max: range.max } : undefined;
  const adjustment = isObject(value.adjustment) ? value.adjustment : isObject(value.selection_input) ? value.selection_input : undefined;
  return {
    fields: assembledMap(value),
    // Forwarded unread; `carryOptional` because an own key may hold `undefined` in memory.
    stepRange: { document: carryOptional(range), bounds },
    // The adjustment's numbers are read only on a press, which needs valid bounds.
    adjustment: adjustment === undefined ? undefined : storedAdjustment(adjustment, bounds === undefined ? DEFAULT_STEP_RANGE : bounds),
    legacyPosition: numeric(value.position) || typeof value.position === 'boolean' ? value.position : undefined,
    effectChannels: Object.values(object(value.channels)).some(x => object(x).kind === 'effect') ? storedFact(value.channels) : undefined,
    selection: storedFact(value.selection),
    presetContexts: assembledMap(object(value.preset_contexts)),
    validUntil: () => savedNumberOr(value.remote_valid_until, 0),
    timingRevision: storedFact(value.remote_timing_revision),
  };
}

/** A stored remote input record, read leniently. */
export interface RemoteInputRecordView {
  kind: StoredFact;
  scope: StoredFact;
  target: StoredFact;
  /** `when` as captured `as_timestamp(when,0)`: 0 for anything but date text. */
  whenStamp: number;
  value: RemoteInputValue;
}

function inputRecord(raw: JsonValue | undefined): RemoteInputRecordView {
  const record = object(raw);
  return {
    kind: storedFact(record.kind),
    scope: storedFact(record.scope),
    target: storedFact(record.target),
    whenStamp: savedWhen(record.when),
    value: inputValue(record.value),
  };
}

/** The record the planner starts from when the stored one does not apply. */
export function noInputRecord(): RemoteInputRecordView {
  return inputRecord(undefined);
}

/** Another stored record, as the restart check reads it. */
export interface OtherRecord {
  key: string;
  scope: StoredFact;
  target: StoredFact;
  valueIsMapping: boolean;
  /** The record's latest brightness update, read only once it applies. */
  newer(): number;
}

function otherRecord(key: string, raw: JsonValue): OtherRecord {
  const r = object(raw);
  return {
    key,
    scope: storedFact(r.scope),
    target: storedFact(r.target),
    valueIsMapping: isObject(r.value),
    // Captured: `claim.get('updated', as_timestamp(r.get('when'),0)) if claim else
    // v.get('adjustment',{}).get('updated',0) if v.get('adjustment') is mapping else 0`.
    // A claim that is not a mapping is no claim, and an unreadable `updated`
    // takes its absent spelling (lenient saved-value directive).
    newer: () => {
      const value = object(r.value);
      const claim = object(object(value.channels).brightness);
      if (jinjaTruthy(claim)) return savedNumberOr(claim.updated, savedWhen(r.when));
      return isObject(value.adjustment) ? savedNumberOr(value.adjustment.updated, 0) : 0;
    },
  };
}

/** `sensor.ls_overrides`'s `overrides`, read leniently, as `ls_remote_plan` reads it. */
export interface RemoteOverrides {
  /** The mapping as stored, forwarded to `ls_room_plan`. */
  document: Verbatim;
  /** The room's latest remote input record's key. */
  inputKey: string;
  input: RemoteInputRecordView;
  has(key: string): boolean;
  /** Every stored record, in stored order; a non-mapping has no facts. */
  others: OtherRecord[];
}

export function remoteOverrides(ctx: HouseView, room: string): RemoteOverrides {
  const overrides = object(ctx.attr(OVERRIDES, 'overrides'));
  const inputKey = latestRemoteKey(overrides, room);
  return {
    document: carry(overrides),
    inputKey,
    input: inputRecord(overrides[inputKey]),
    has: key => Object.hasOwn(overrides, key),
    others: Object.entries(overrides).map(([key, raw]) => otherRecord(key, raw)),
  };
}

/** The room cache forwarded to `ls_room_plan`: as stored, or `{}` when absent or Jinja-falsy. */
export function remoteCache(value: JsonValue | undefined): Verbatim {
  return carry(value !== undefined && jinjaTruthy(value) ? value : {});
}

/** `ls_room_plan`'s answer, or none, as the remote planner reads it. */
export interface RemoteRoomPlan {
  /** `key in plan.stale_keys`; raises on a present non-list. */
  stale(key: string): boolean;
  /** The room target's `period`, as stored. */
  roomPeriod(room: string): StoredFact;
  /** The room's schedule details: present when a non-empty mapping. */
  scheduleDetails(room: string): { present: boolean; nextFs(): number };
}

export function remoteRoomPlan(result: JsonValue | undefined): RemoteRoomPlan {
  const plan = object(object(result).plan);
  return {
    stale: key => list(plan.stale_keys).includes(key),
    roomPeriod: room => storedFact(object(object(object(plan.resolved).targets)[`room:${room}`]).period),
    scheduleDetails: room => {
      const schedule = object(object(plan.schedule_details)[room]);
      return { present: Object.keys(schedule).length > 0, nextFs: () => num(schedule.next_fs === undefined ? 0 : schedule.next_fs) };
    },
  };
}

/**
 * The selected preset, as captured `value.get('selection', group.get('period','day'))`:
 * the stored selection when it is text -- a saved selection that is not text
 * reads as absent (lenient saved-value directive; the captured `**{selected:...}`
 * raises on it) -- else the room plan's period, else `'day'`. The period is the
 * port's own room plan, so a non-text period still raises.
 */
export function presetSelection(selection: StoredFact, period: StoredFact): string {
  if (typeof selection === 'string') return selection;
  return requireString({ selection: period === undefined ? 'day' : period }, 'selection', 'ls_remote_plan');
}


/** A preset context, stored or just saved, as its entries when it is a mapping. */
export function contextEntries(entry: Assembled | undefined): AssembledMap | undefined {
  return isObject(entry) ? assembledMap(entry as JsonObject) : undefined;
}

/** The room's saved power state, when it is a boolean. */
export function roomPower(ctx: HouseView, room: string): boolean | undefined {
  const saved = object(ctx.attr(OVERRIDES, 'power'))[room];
  return typeof saved === 'boolean' ? saved : undefined;
}

/**
 * `ls_remote_plan`'s arguments. Captured source/area/command are raw at
 * 7/4/15 sites and form identifiers, mapping keys and command branches, so a
 * missing or malformed value raises.
 */
export function parseRemotePlanArgs(args: JsonObject): RemotePlanArgs {
  return {
    source: requireString(args, 'source', 'ls_remote_plan'),
    area: requireString(args, 'area', 'ls_remote_plan'),
    command: requireString(args, 'command', 'ls_remote_plan'),
  };
}
