import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, requireArray, requireBoolean, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import { WARM_END } from './scale.ts';
import { optionalTimestamp } from './schedule.ts';
import type { ScheduleEnvelope, TargetEntry } from './schedule.ts';
import { recordTimestamp } from './resolution.ts';
import type { ResolutionResult } from './resolution.ts';
import type { GradientPlanResult } from './gradient.ts';
import { requireRgb } from '../parse/scale.ts';
import type { RemotePlanResult } from './remote-input.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const rangeDefaults: JsonObject = { bright: [90, 100], cosy: [30, 60] };

interface SwitchPlanArgs {
  targets: JsonObject;
  ranges: JsonObject;
  defaults: JsonObject;
}

/**
 * One switch's planned state.
 *
 * Every field is computed here from the rule and the room's target, so the
 * parsed view and the serialised bytes cannot diverge -- nothing is passed
 * through from an input document. That is what makes this result safe to hand
 * callers as a type while `ls_plan` still serialises it into compared JSON.
 */
export type SwitchDecision = {
  on: boolean;
  room: string;
  brightness: number;
  range: [number, number];
};
export type SwitchPlanResult = { switches: Record<string, SwitchDecision> };

interface PlanArgs {
  testOverrides: JsonObject | undefined;
  testNow: number | null;
  reason: string;
  room: string;
}

interface ApplyArgs {
  dryRun: boolean;
  forceAll: boolean;
  testNow: number | undefined;
  hasTestOverrides: boolean;
  testOverrides: JsonObject | undefined;
  reason: string;
  lights: () => JsonValue[];
}

interface RemoteCommandArgs {
  source: string;
  area: string;
  command: string;
  dryRun: boolean;
}

function lazy<T>(parse: () => T): () => T {
  let parsed = false;
  let value: T;
  return () => {
    if (!parsed) {
      value = parse();
      parsed = true;
    }
    return value;
  };
}

function optionalScriptBoolean(value: JsonValue | undefined, context: string): boolean {
  return value === undefined ? false : requireBoolean(value, context);
}

/** Script callers use null for an explicitly empty optional payload. */
function optionalScriptObject(value: JsonValue | undefined, context: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  return requireObject({ value }, 'value', context);
}

/** HA entity attributes use null for no value; present values must be objects. */
function optionalAttributeObject(value: JsonValue | undefined, context: string): JsonObject {
  if (value === undefined || value === null) return {};
  return requireObject({ value }, 'value', context);
}

function requiredResultObject(value: JsonValue, context: string): JsonObject {
  return requireObject({ value }, 'value', context);
}

export function switchPlan(ctx: ScriptContext, args: SwitchPlanArgs): SwitchPlanResult {
  const targets = args.targets, switches: Record<string, SwitchDecision> = {}, defaults = args.defaults;
  for (const [entity, raw] of Object.entries(args.ranges)) {
    const rule = object(raw), room = ctx.areas[entity];
    const group = room === undefined ? {} : object(targets[`room:${room}`]);
    const interval = rule.profile === 'custom' ? [rule.min, rule.max] : list(defaults[String(rule.profile)]);
    const low = interval[0], high = interval[1];
    if (interval.length !== 2 || typeof low !== 'number' || typeof high !== 'number' || !(0 <= low && low <= high && high <= 100) || !Object.keys(group).length) continue;
    const brightness = Number(group.level) * 100 / 255;
    const on = requireBoolean(group.on, `ls_switch_plan.targets.room:${room}.on`);
    switches[entity] = { on: on && low <= brightness && brightness <= high,
      room: room!, brightness, range: [low, high] };
  }
  return { switches };
}

/**
 * The document `ls_plan` builds, with every field concrete.
 *
 * `Omit` rather than a plain intersection, and that is load-bearing: `plan`
 * spreads `...schedule` and then *overwrites* `revision` and `sara_mirror`, and
 * the widths differ. `ScheduleEnvelope.sara_mirror` is `'off' | null`, but this
 * document's is `'on' | 'off' | null`, because `wanted` is `'on'` whenever
 * `mode:sara` is active. Intersecting would narrow the field back to the
 * envelope's two cases and reject the value this function actually produces.
 *
 * Every field is either computed here or the result of an already-converted
 * entrypoint, so there is no passthrough and THE INVARIANT (a projected field
 * must never reach compared JSON) cannot be broken by this type. The envelope's
 * own loosely-typed fields keep the reasons written at their declarations in
 * `schedule.ts`.
 */
export type PlanDocument = Omit<ScheduleEnvelope, 'revision' | 'sara_mirror'> & {
  base: Record<string, TargetEntry>;
  resolved: ResolutionResult;
  gradients: GradientPlanResult['gradients'];
  switches: Record<string, SwitchDecision>;
  revision: string;
  plan_order: number;
  remote: boolean;
  sara_mirror: 'on' | 'off' | null;
};
export type PlanResult = { plan: PlanDocument };

/**
 * `ls_plan` is deliberately NOT in `TypedResults`, so no decoder exists for it
 * and its three reading callers keep `ctx.run`. This is a return annotation
 * only, which is the strongest typing available here.
 *
 * The parity harness answers to this name with two documents that no decoder
 * could accept, and both are gate assertions:
 *
 * 1. `tests/parity/test_bridge.py:54-60` installs the literal
 *    `{'marker': ['literal', 7]}` -- no `plan` key at all -- and asserts
 *    `ls_apply`'s dry-run returns it verbatim. `gate.py:133` runs that file and
 *    its exit code is `bridge_test_exit_code` in the report.
 * 2. `tests/parity/adapters.py:220-222` asserts its literal dependency is
 *    exactly `{plan: {base, resolved}}` and nothing else.
 *
 * So a decoder at either `ctx.call` site would raise where the oracle passes
 * the bytes through. `effects_resolve` also has no decoder on purpose (see
 * `resultCodecs` in `src/parse/results.ts`), so `resolved` had nothing to
 * decode with either. Revisit only if `ls_dispatch`'s arguments ever become
 * typed -- then this document has a typed producer and a typed consumer and the
 * question does not arise.
 */
export function plan(ctx: ScriptContext, args: PlanArgs): PlanResult {
  const overrides = args.testOverrides === undefined
    ? optionalAttributeObject(ctx.attr('sensor.ls_overrides', 'overrides'), 'ls_plan.overrides')
    : args.testOverrides;
  // `requiredResultObject`, two `requireObject`s and `list(...)` on
  // `stale_keys` are gone: `decodeScheduledBase` performs all four for a stub
  // and `scheduledBase` builds every field for the real handler.
  const baseline = ctx.call('ls_base', { overrides, test_now: args.testNow,
    reason: args.reason, room_only: args.room });
  const schedule = baseline.schedule;
  const baselineTargets = baseline.targets;
  const active: JsonObject = Object.fromEntries(Object.entries(overrides).filter(([key]) => !schedule.stale_keys.includes(key)));
  const catalog = ctx.run('effects_catalog');
  const rawWarmEnd = ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color');
  // Home Assistant uses null for an attribute with no value.
  const warmEnd = rawWarmEnd === undefined || rawWarmEnd === null
    ? WARM_END
    : requireRgb(rawWarmEnd, 'ls_plan.warm_end');
  let cached: JsonObject = {};
  for (const raw of Object.values(baselineTargets)) {
    const room = object(raw).area;
    cached = { ...cached, ...object(object(ctx.attr(`sensor.ls_cache_${room}`, 'cache')).gradients) };
  }
  const gradients = ctx.call('effects_gradient_plan', { base: baselineTargets, warm_end: warmEnd, cached }).gradients;
  const privateRooms = ctx.labels?.private_room;
  const power = optionalAttributeObject(ctx.attr('sensor.ls_overrides', 'power'), 'ls_plan.power');
  const resolved = ctx.call('effects_resolve', { base: baselineTargets, overrides: active, catalog,
    sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms === undefined ? [] : privateRooms,
    power, warm_end: warmEnd, gradients });
  const resolvedTargets = resolved.targets;
  const ranges = optionalAttributeObject(ctx.attr('sensor.ls_overrides', 'switch_ranges'), 'ls_plan.switch_ranges');
  const rawDefaults = ctx.attr('sensor.ls_overrides', 'range_defaults');
  const defaults = rawDefaults === undefined || rawDefaults === null
    ? rangeDefaults
    : requireObject({ value: rawDefaults }, 'value', 'ls_plan.range_defaults');
  const switches = ctx.call('ls_switch_plan', { targets: resolvedTargets, ranges, defaults });
  const revisionValue = ctx.state['sensor.ls_overrides']?.last_updated;
  const revision = requireString({ value: revisionValue === undefined ? null : revisionValue }, 'value', 'ls_plan.revision');
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...schedule, base: baselineTargets, resolved, gradients,
    switches: switches.switches, revision,
    plan_order: recordTimestamp(ctx.now), remote: args.reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null } };
}

/**
 * Stays `JsonValue`, and NOT because `ls_plan` is untyped -- because verbatim
 * pass-through of whatever answered to `ls_plan` is an asserted contract.
 * `tests/parity/test_bridge.py:54-60` stubs `ls_plan` with
 * `{'marker': ['literal', 7]}` and asserts this function returns that object
 * unchanged, so the dry-run path must forward an arbitrary document. Narrowing
 * this to `PlanResult | null` would be a claim the harness disproves, and
 * `ctx.call` here would raise on a document with no `plan` key.
 */
function apply(ctx: ScriptContext, args: ApplyArgs): JsonValue {
  if (!args.dryRun && (args.testNow !== undefined || args.hasTestOverrides || args.forceAll)) return null;
  if (args.dryRun) return ctx.run('ls_plan', { reason: args.reason, test_now: args.testNow === undefined ? null : args.testNow,
    test_overrides: args.testOverrides === undefined ? null : args.testOverrides });
  ctx.run('ls_commit', { data: { op: 'render_request', via: 'render_request', reason: args.reason, lights: args.lights() } });
  return null;
}

function remoteCommand(ctx: ScriptContext, args: RemoteCommandArgs): RemotePlanResult | null {
  const input = { source: args.source, area: args.area, command: args.command };
  if (args.dryRun) return ctx.call('ls_remote_plan', input);
  let result: RemotePlanResult | undefined, accepted = false;
  for (let attempt = 0; attempt < 1_000 && !accepted; attempt++) {
    result = ctx.call('ls_remote_plan', input);
    if (result.op === 'noop') accepted = true;
    else {
      accepted = ctx.call('ls_commit', { data: { ...result,
        expected_revision: result.input_revision, area: input.area, via: 'remote', source: input.source } }).accepted;
    }
  }
  if (!accepted) throw new Error('Override revision kept changing; retry budget exhausted');
  // `accepted` starts false, so the loop body always runs and assigns this.
  // TypeScript cannot prove definite assignment through a loop, and widening
  // the throw above to cover `undefined` would change a condition the gate
  // compares, so the assertion stays here instead.
  // `requireBoolean(result.on)` and `requireArray(result, 'targets')` are gone:
  // the `op` discriminant narrows both, and `remotePlan` builds them.
  if (result!.op === 'power') {
    const { on, targets } = result!;
    ctx.emit(on ? 'homeassistant.turn_on' : 'homeassistant.turn_off', {}, { entity_id: targets });
    if (on) ctx.run('ls_apply', { reason: 'lamp_on', lights: targets });
  }
  return null;
}

export const controllerHandlers: ScriptHandlers = {
  // Captured targets/defaults each use mapping.get once and ranges uses
  // mapping.items once; all three therefore require real mappings.
  ls_switch_plan: typed('ls_switch_plan', {
    parse: args => ({
      targets: requireObject(args, 'targets', 'ls_switch_plan'),
      ranges: requireObject(args, 'ranges', 'ls_switch_plan'),
      defaults: requireObject(args, 'defaults', 'ls_switch_plan'),
    }),
    run: switchPlan,
  }),
  // Captured test_now has one default(none), reason two default('config')
  // sites, room one default(''), and test_overrides is optional at two sites.
  ls_plan: withParsedArgs({
    parse: args => ({
      testOverrides: optionalScriptObject(args.test_overrides, 'ls_plan.test_overrides'),
      // Captured ls_plan reads test_now raw behind default(none); a numeric
      // epoch is as legal as a date string, and ls_base parses the same field
      // with optionalTimestamp. requireString here rejected a valid value.
      testNow: optionalTimestamp(args.test_now) ?? null,
      reason: args.reason === undefined ? 'config' : requireString(args, 'reason', 'ls_plan'),
      room: args.room === undefined ? '' : requireString(args, 'room', 'ls_plan'),
    }),
    run: plan,
  }),
  // Captured dry_run/force_all use boolean defaults, test_now and
  // test_overrides are definition-guarded, reason defaults only when absent,
  // and lights is consumed only after the dry-run/test guard.
  ls_apply: withParsedArgs({
    parse: args => ({
      dryRun: optionalScriptBoolean(args.dry_run, 'ls_apply.dry_run'),
      forceAll: optionalScriptBoolean(args.force_all, 'ls_apply.force_all'),
      // Same as ls_plan: captured source reads test_now raw.
      testNow: optionalTimestamp(args.test_now),
      hasTestOverrides: Object.hasOwn(args, 'test_overrides'),
      testOverrides: optionalScriptObject(args.test_overrides, 'ls_apply.test_overrides'),
      reason: args.reason === undefined ? 'config' : requireString(args, 'reason', 'ls_apply'),
      lights: lazy(() => args.lights === undefined ? [] : requireArray(args, 'lights', 'ls_apply')),
    }),
    run: apply,
  }),
  // Captured source/area/command are raw at four/four/two sites and drive
  // identifiers and command dispatch; dry_run has default(false).
  ls_remote_command: withParsedArgs({
    parse: args => ({
      source: requireString(args, 'source', 'ls_remote_command'),
      area: requireString(args, 'area', 'ls_remote_command'),
      command: requireString(args, 'command', 'ls_remote_command'),
      dryRun: optionalScriptBoolean(args.dry_run, 'ls_remote_command.dry_run'),
    }),
    run: remoteCommand,
  }),
};
