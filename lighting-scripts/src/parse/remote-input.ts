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
import type { JsonObject, JsonValue, ScriptContext } from '../runtime/context.ts';
import { isObject, jinjaTruthy, object, requireBoolean, requireObject, requireString } from '../runtime/parse.ts';
import { carry, carryOptional } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { list, num } from './accessors.ts';
import { latestRemoteKey, recordTimestamp } from './resolution.ts';
import { assembledMap, storedFact } from './overrides.ts';
import type { Assembled, AssembledMap, StoredFact, StoredValue } from './overrides.ts';
import type { Adjustment, RemotePlanArgs } from '../domain/remote-input.ts';

const OVERRIDES = 'sensor.ls_overrides';
const numeric = (v: JsonValue | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored adjustment (or selection input): its document, and its numbers read on demand. */
function storedAdjustment(document: JsonObject): Adjustment {
  return {
    fields: assembledMap(document),
    updated: () => num(document.updated === undefined ? 0 : document.updated),
    lower: () => num(document.lower),
    upper: () => num(document.upper),
    steps: () => num(document.steps),
    hasUp: () => document.has_up === undefined ? false : requireBoolean(document.has_up, 'ls_remote_plan.adjustment.has_up'),
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
  /** `position`, when a finite number. */
  legacyPosition: number | undefined;
  /** `channels` as stored, when one of them runs an effect. */
  effectChannels: StoredValue | undefined;
  selection: StoredFact;
  /** `preset_contexts` read leniently; entries carried. */
  presetContexts: AssembledMap;
  /** `remote_valid_until`, absent read as 0. */
  validUntil(): number;
  timingRevision: StoredFact;
}

function inputValue(raw: JsonValue | undefined): RemoteInputValue {
  const value = object(raw);
  const range = Object.hasOwn(value, 'step_range') ? value.step_range : { min: -20, max: 20 };
  const bounds = isObject(range) && numeric(range.min) && numeric(range.max)
    && -20 <= range.min && range.min <= range.max && range.max <= 20 ? { min: range.min, max: range.max } : undefined;
  const adjustment = isObject(value.adjustment) ? value.adjustment : isObject(value.selection_input) ? value.selection_input : undefined;
  return {
    fields: assembledMap(value),
    // Forwarded unread; `carryOptional` because an own key may hold `undefined` in memory.
    stepRange: { document: carryOptional(range), bounds },
    adjustment: adjustment === undefined ? undefined : storedAdjustment(adjustment),
    legacyPosition: numeric(value.position) ? value.position : undefined,
    effectChannels: Object.values(object(value.channels)).some(x => object(x).kind === 'effect') ? storedFact(value.channels) : undefined,
    selection: storedFact(value.selection),
    presetContexts: assembledMap(object(value.preset_contexts)),
    validUntil: () => num(value.remote_valid_until === undefined ? 0 : value.remote_valid_until),
    timingRevision: storedFact(value.remote_timing_revision),
  };
}

/** A stored remote input record, read leniently. */
export interface RemoteInputRecordView {
  kind: StoredFact;
  scope: StoredFact;
  target: StoredFact;
  /** `when` as a record timestamp, 0 when absent or unreadable. */
  whenStamp: number;
  value: RemoteInputValue;
}

function inputRecord(raw: JsonValue | undefined): RemoteInputRecordView {
  const record = object(raw);
  return {
    kind: storedFact(record.kind),
    scope: storedFact(record.scope),
    target: storedFact(record.target),
    whenStamp: recordTimestamp(record.when),
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
    newer: () => {
      const value = object(r.value);
      const claim = object(object(value.channels).brightness);
      if (Object.keys(claim).length) return num(claim.updated === undefined ? recordTimestamp(r.when) : claim.updated);
      const adjustment = value.adjustment === undefined ? {} : requireObject(value, 'adjustment', 'ls_remote_plan.override.value');
      return num(adjustment.updated === undefined ? 0 : adjustment.updated);
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

export function remoteOverrides(ctx: ScriptContext, room: string): RemoteOverrides {
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
  schedule(room: string): { present: boolean; nextFs(): number };
}

export function remoteRoomPlan(result: JsonValue | undefined): RemoteRoomPlan {
  const plan = object(object(result).plan);
  return {
    stale: key => list(plan.stale_keys).includes(key),
    roomPeriod: room => storedFact(object(object(object(plan.resolved).targets)[`room:${room}`]).period),
    schedule: room => {
      const schedule = object(object(plan.schedule_details)[room]);
      return { present: Object.keys(schedule).length > 0, nextFs: () => num(schedule.next_fs === undefined ? 0 : schedule.next_fs) };
    },
  };
}

/** The selected preset: the stored selection, else the room's period, else `'day'`; must be a string. */
export function presetSelection(selection: StoredFact, period: StoredFact): string {
  const value = selection === undefined ? (period === undefined ? 'day' : period) : selection;
  return requireString({ selection: value }, 'selection', 'ls_remote_plan');
}

/** A preset context, stored or just saved, as its entries when it is a mapping. */
export function contextEntries(entry: Assembled | undefined): AssembledMap | undefined {
  return isObject(entry) ? assembledMap(entry as JsonObject) : undefined;
}

/** The room's saved power state, when it is a boolean. */
export function roomPower(ctx: ScriptContext, room: string): boolean | undefined {
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
