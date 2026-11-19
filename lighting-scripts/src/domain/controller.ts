import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { ScheduleEnvelope, TargetEntry } from './schedule.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import type { OpaqueMap } from '../parse/overrides.ts';
import {
  cachedGradients, parseApplyArgs, parsePlanArgs, parseRemoteCommandArgs, parseSwitchPlanArgs, planMapping, planOverrides,
  planPassThrough, planRangeDefaults, planRevision, planWarmEnd,
} from '../parse/controller.ts';
import type { ResolutionResult } from './resolution.ts';
import type { GradientPlanResult } from './gradient.ts';
import type { RemotePlanResult } from './remote-input.ts';

export interface SwitchPlanArgs {
  /** Each switch-range rule, its interval read at its turn: `[low, high]`, or `undefined` unless valid. */
  rules: Array<{ entity: string; range: () => [number, number] | undefined }>;
  /** The resolved room target a rule follows, read leniently; `on` is required once read. */
  roomTarget(room: string | undefined): { populated: boolean; level: () => number; on: () => boolean };
}

/** The override mapping `ls_plan` plans with: as stored (forwarded to the baseline), and entry by entry. */
export interface PlanOverrides {
  document: Verbatim;
  entries: OpaqueMap;
}

export interface PlanArgs {
  testOverrides: PlanOverrides | undefined;
  testNow: number | null;
  reason: string;
  room: string;
}

export interface ApplyArgs {
  dryRun: boolean;
  forceAll: boolean;
  testNow: number | undefined;
  hasTestOverrides: boolean;
  /** Forwarded to `ls_plan` unread. */
  testOverrides: Verbatim | undefined;
  reason: string;
  /** Forwarded to `ls_commit` unread. */
  lights: () => Verbatim;
}

export interface RemoteCommandArgs {
  source: string;
  area: string;
  command: string;
  dryRun: boolean;
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

export function switchPlan(ctx: ScriptContext, args: SwitchPlanArgs): SwitchPlanResult {
  const switches: Record<string, SwitchDecision> = {};
  for (const { entity, range } of args.rules) {
    const room = ctx.areas[entity];
    const group = args.roomTarget(room);
    const interval = range();
    if (interval === undefined || !group.populated) continue;
    const [low, high] = interval;
    const brightness = group.level() * 100 / 255;
    const on = group.on();
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
    ? planOverrides(ctx.attr('sensor.ls_overrides', 'overrides'))
    : args.testOverrides;
  // `requiredResultObject`, two `requireObject`s and `list(...)` on
  // `stale_keys` are gone: `decodeScheduledBase` performs all four for a stub
  // and `scheduledBase` builds every field for the real handler.
  const baseline = ctx.call('ls_base', { overrides: overrides.document, test_now: args.testNow,
    reason: args.reason, room_only: args.room });
  const schedule = baseline.schedule;
  const baselineTargets = baseline.targets;
  const active: OpaqueMap = Object.fromEntries(Object.entries(overrides.entries).filter(([key]) => !schedule.stale_keys.includes(key)));
  const catalog = ctx.run('effects_catalog');
  const warmEnd = planWarmEnd(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  let cached: OpaqueMap = {};
  for (const target of Object.values(baselineTargets)) {
    cached = { ...cached, ...cachedGradients(ctx.attr(`sensor.ls_cache_${target.area}`, 'cache')) };
  }
  const gradients = ctx.call('effects_gradient_plan', { base: baselineTargets, warm_end: warmEnd, cached }).gradients;
  const privateRooms = ctx.labels?.private_room;
  const power = planMapping(ctx.attr('sensor.ls_overrides', 'power'), 'ls_plan.power');
  const resolved = ctx.call('effects_resolve', { base: baselineTargets, overrides: active, catalog,
    sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms === undefined ? [] : privateRooms,
    power, warm_end: warmEnd, gradients });
  const resolvedTargets = resolved.targets;
  const ranges = planMapping(ctx.attr('sensor.ls_overrides', 'switch_ranges'), 'ls_plan.switch_ranges');
  const defaults = planRangeDefaults(ctx.attr('sensor.ls_overrides', 'range_defaults'));
  const switches = ctx.call('ls_switch_plan', { targets: resolvedTargets, ranges, defaults });
  const revision = planRevision(ctx.state['sensor.ls_overrides']?.last_updated);
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...schedule, base: baselineTargets, resolved, gradients,
    switches: switches.switches, revision,
    plan_order: recordTimestamp(ctx.now), remote: args.reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null } };
}

/**
 * Answers `Verbatim`, and NOT because `ls_plan` is untyped -- because verbatim
 * pass-through of whatever answered to `ls_plan` is an asserted contract.
 * `tests/parity/test_bridge.py:54-60` stubs `ls_plan` with
 * `{'marker': ['literal', 7]}` and asserts this function returns that object
 * unchanged, so the dry-run path must forward an arbitrary document. Narrowing
 * this to `PlanResult | null` would be a claim the harness disproves, and
 * `ctx.call` here would raise on a document with no `plan` key. Carried, it is
 * forwarded unread and is still the very same document.
 */
function apply(ctx: ScriptContext, args: ApplyArgs): Verbatim | null {
  if (!args.dryRun && (args.testNow !== undefined || args.hasTestOverrides || args.forceAll)) return null;
  if (args.dryRun) return planPassThrough(ctx.run('ls_plan', { reason: args.reason, test_now: args.testNow === undefined ? null : args.testNow,
    test_overrides: args.testOverrides === undefined ? null : args.testOverrides }));
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
  ls_switch_plan: typed('ls_switch_plan', { parse: parseSwitchPlanArgs, run: switchPlan }),
  ls_plan: withParsedArgs({ parse: parsePlanArgs, run: plan }),
  ls_apply: withParsedArgs({ parse: parseApplyArgs, run: apply }),
  ls_remote_command: withParsedArgs({ parse: parseRemoteCommandArgs, run: remoteCommand }),
};
