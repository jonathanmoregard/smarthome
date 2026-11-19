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
import { drive, perform } from '../runtime/effects.ts';
import type { Effect, HouseView } from '../runtime/effects.ts';

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

export function switchPlan(areas: Readonly<Record<string, string>>, args: SwitchPlanArgs): SwitchPlanResult {
  const switches: Record<string, SwitchDecision> = {};
  for (const { entity, range } of args.rules) {
    const room = areas[entity];
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
  return planAnswer(ctx, { schedule, base: baselineTargets, resolved, gradients, switches: switches.switches, active, reason: args.reason });
}

/** The parts `ls_plan` answers with, once every call is done. */
export interface PlanParts {
  schedule: ScheduleEnvelope;
  base: Record<string, TargetEntry>;
  resolved: ResolutionResult;
  gradients: GradientPlanResult['gradients'];
  switches: Record<string, SwitchDecision>;
  /** The overrides the baseline did not mark stale. */
  active: OpaqueMap;
  reason: string;
}

/**
 * The plan document: the schedule with the plan's fields over it. The
 * revision, the plan order and the Sara mirror are read here, after the last
 * call, where the captured script reads them.
 */
export function planAnswer(view: HouseView, parts: PlanParts): PlanResult {
  const revision = planRevision(view.state['sensor.ls_overrides']?.last_updated);
  const wanted = Object.hasOwn(parts.active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...parts.schedule, base: parts.base, resolved: parts.resolved, gradients: parts.gradients,
    switches: parts.switches, revision,
    plan_order: recordTimestamp(view.now), remote: parts.reason === 'remote',
    sara_mirror: view.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null } };
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

/** The remote command `ls_remote_plan` plans. */
export type RemoteInput = { source: string; area: string; command: string };
/** A planned change, committed against the revision it was planned at. */
export type RemoteCommit = RemotePlanResult & { expected_revision: string; area: string; via: 'remote'; source: string };

/** The captured script's retry budget for a revision that keeps moving under the commit. */
const REMOTE_ATTEMPTS = 1_000;

/**
 * `ls_remote_command` as a state machine. It plans, commits the plan against
 * the revision it was planned at, and plans again while a commit is refused,
 * up to {@link REMOTE_ATTEMPTS} times; `attempt` is that loop's counter.
 */
export type RemoteCommandPhase =
  | { tag: 'idle'; input: RemoteInput; dryRun: boolean }
  | { tag: 'planning'; input: RemoteInput; dryRun: boolean; attempt: number }
  | { tag: 'committing'; input: RemoteInput; attempt: number; plan: RemotePlanResult }
  | { tag: 'done'; answer: RemotePlanResult | null }
  /** Every attempt's commit was refused. */
  | { tag: 'exhausted' };
export type RemoteCommandMsg =
  | { tag: 'start' }
  | { tag: 'planned'; result: RemotePlanResult }
  | { tag: 'committed'; accepted: boolean };
export type RemoteCommandCmd =
  /** Run `ls_remote_plan`; answers `planned`. */
  | { tag: 'plan'; input: RemoteInput }
  /** Run `ls_commit`; answers `committed`. */
  | { tag: 'commit'; data: RemoteCommit }
  | { tag: 'effect'; effect: Effect };

export function remoteCommandStart(args: RemoteCommandArgs): RemoteCommandPhase {
  return { tag: 'idle', input: { source: args.source, area: args.area, command: args.command }, dryRun: args.dryRun };
}

export function remoteCommandStep(phase: RemoteCommandPhase, msg: RemoteCommandMsg): [RemoteCommandPhase, RemoteCommandCmd[]] {
  switch (phase.tag) {
    case 'idle': {
      if (msg.tag !== 'start') return unexpected(phase, msg);
      return planAgain(phase.input, phase.dryRun, 0);
    }
    case 'planning': {
      if (msg.tag !== 'planned') return unexpected(phase, msg);
      const result = msg.result;
      if (phase.dryRun) return [{ tag: 'done', answer: result }, []];
      if (result.op === 'noop') return accepted(result);
      const input = phase.input;
      const data: RemoteCommit = { ...result, expected_revision: result.input_revision, area: input.area, via: 'remote', source: input.source };
      return [{ tag: 'committing', input, attempt: phase.attempt, plan: result }, [{ tag: 'commit', data }]];
    }
    case 'committing': {
      if (msg.tag !== 'committed') return unexpected(phase, msg);
      if (msg.accepted) return accepted(phase.plan);
      const attempt = phase.attempt + 1;
      return attempt < REMOTE_ATTEMPTS ? planAgain(phase.input, false, attempt) : [{ tag: 'exhausted' }, []];
    }
    case 'done':
    case 'exhausted':
      return unexpected(phase, msg);
    default: {
      const unknown: never = phase;
      throw new Error(`Unhandled ls_remote_command phase ${JSON.stringify(unknown)}`);
    }
  }
}

function planAgain(input: RemoteInput, dryRun: boolean, attempt: number): [RemoteCommandPhase, RemoteCommandCmd[]] {
  return [{ tag: 'planning', input, dryRun, attempt }, [{ tag: 'plan', input }]];
}

/** An accepted power plan switches its targets, then a power-on renders them as a lamp-on apply. */
function accepted(plan: RemotePlanResult): [RemoteCommandPhase, RemoteCommandCmd[]] {
  const done: RemoteCommandPhase = { tag: 'done', answer: null };
  if (plan.op !== 'power') return [done, []];
  const { on, targets } = plan;
  const cmds: RemoteCommandCmd[] = [{ tag: 'effect', effect: {
    kind: 'service', service: on ? 'homeassistant.turn_on' : 'homeassistant.turn_off', data: {}, target: { entity_id: targets },
  } }];
  if (on) cmds.push({ tag: 'effect', effect: { kind: 'script', name: 'ls_apply', args: { reason: 'lamp_on', lights: targets } } });
  return [done, cmds];
}

function unexpected(phase: RemoteCommandPhase, msg: RemoteCommandMsg): never {
  throw new Error(`ls_remote_command: phase ${phase.tag} cannot take ${msg.tag}`);
}

/** The interpreter: each command is one inter-handler call or one effect. */
function remoteCommand(ctx: ScriptContext, args: RemoteCommandArgs): RemotePlanResult | null {
  return drive(remoteCommandStep, remoteCommandStart(args), { tag: 'start' }, (cmd: RemoteCommandCmd): RemoteCommandMsg | undefined => {
    switch (cmd.tag) {
      case 'plan': return { tag: 'planned', result: ctx.call('ls_remote_plan', cmd.input) };
      case 'commit': return { tag: 'committed', accepted: ctx.call('ls_commit', { data: cmd.data }).accepted };
      case 'effect': perform(ctx, cmd.effect); return undefined;
      default: {
        const unknown: never = cmd;
        throw new Error(`Unhandled ls_remote_command command ${JSON.stringify(unknown)}`);
      }
    }
  }, phase => {
    if (phase.tag === 'done') return { value: phase.answer };
    if (phase.tag === 'exhausted') throw new Error('Override revision kept changing; retry budget exhausted');
    return undefined;
  });
}

export const controllerHandlers: ScriptHandlers = {
  ls_switch_plan: typed('ls_switch_plan', { parse: parseSwitchPlanArgs, run: (ctx, args) => switchPlan(ctx.areas, args) }),
  ls_plan: withParsedArgs({ parse: parsePlanArgs, run: plan }),
  ls_apply: withParsedArgs({ parse: parseApplyArgs, run: apply }),
  ls_remote_command: withParsedArgs({ parse: parseRemoteCommandArgs, run: remoteCommand }),
};
