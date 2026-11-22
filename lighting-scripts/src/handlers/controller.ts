/**
 * `controller`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/legacy/domain/controller.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { OpaqueMap } from '../parse/overrides.ts';
import {
  cachedGradients, parseApplyArgs, parsePlanArgs, parseRemoteCommandArgs, parseSwitchPlanArgs, planMapping, planOverrides, planPassThrough,
    planRangeDefaults, planWarmEnd,
} from '../parse/controller.ts';
import type { RemotePlan } from '../legacy/domain/remote-input.ts';
import { remoteAnswerDocument, remotePlanDocument } from '../parse/results.ts';
import { perform } from '../runtime/effects.ts';
import { acceptedPowerSwitch, planAnswer, remoteCommit, switchPlan } from '../legacy/domain/controller.ts';
import type { ApplyRequest, PlanRequest, LightingPlan, PowerSwitch, RemoteCommandRequest } from '../legacy/domain/controller.ts';
import { overlayKeyText, SARA_MODE } from '../domain/types/overlay.ts';
import { pressText } from '../domain/types/remote.ts';
import { roomText } from '../parse/rooms.ts';

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
export function plan(ctx: ScriptContext, args: PlanRequest): LightingPlan {
  const overrides = args.testOverrides === undefined
    ? planOverrides(ctx.attr('sensor.ls_overrides', 'overrides'))
    : args.testOverrides;
  // `requiredResultObject`, two `requireObject`s and `list(...)` on
  // `stale_keys` are gone: `decodeScheduledBase` performs all four for a stub
  // and `scheduledBase` builds every field for the real handler.
  const baseline = ctx.call('ls_base', { overrides: overrides.document, test_now: args.testNow,
    reason: args.reason, room_only: roomText(args.room) });
  const schedule = baseline.schedule;
  const baselineTargets = baseline.targets;
  const active: OpaqueMap = Object.fromEntries(Object.entries(overrides.entries).filter(([key]) => !schedule.stale_keys.includes(key)));
  const catalog = ctx.run('effects_catalog');
  const warmEnd = planWarmEnd(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color'));
  let cached: OpaqueMap = {};
  for (const { area } of Object.values(baselineTargets)) {
    // A lamp in no room has no room cache: the captured `'sensor.ls_cache_' ~ None` names a sensor no script writes.
    if (area === null) continue;
    cached = { ...cached, ...cachedGradients(ctx.attr(`sensor.ls_cache_${area}`, 'cache')) };
  }
  const gradients = ctx.call('effects_gradient_plan', { base: baselineTargets, warm_end: warmEnd, cached });
  const privateRooms = ctx.labels?.private_room;
  const power = planMapping(ctx.attr('sensor.ls_overrides', 'power'));
  const resolved = ctx.call('effects_resolve', { base: baselineTargets, overrides: active, catalog,
    sara: Object.hasOwn(active, overlayKeyText(SARA_MODE)), private: privateRooms === undefined ? [] : privateRooms,
    power, warm_end: warmEnd, gradients });
  const resolvedTargets = resolved.targets;
  const ranges = planMapping(ctx.attr('sensor.ls_overrides', 'switch_ranges'));
  const defaults = planRangeDefaults(ctx.attr('sensor.ls_overrides', 'range_defaults'));
  const switches = ctx.call('ls_switch_plan', { targets: resolvedTargets, ranges, defaults });
  return planAnswer(ctx, { schedule, base: baselineTargets, resolved, gradients, switches, active, reason: args.reason });
}
/**
 * Answers `Verbatim`, and NOT because `ls_plan` is untyped -- because verbatim
 * pass-through of whatever answered to `ls_plan` is an asserted contract.
 * `tests/parity/test_bridge.py:54-60` stubs `ls_plan` with
 * `{'marker': ['literal', 7]}` and asserts this function returns that object
 * unchanged, so the dry-run path must forward an arbitrary document. Narrowing
 * this to `{ plan: LightingPlan } | null` would be a claim the harness disproves, and
 * `ctx.call` here would raise on a document with no `plan` key. Carried, it is
 * forwarded unread and is still the very same document.
 */
function apply(ctx: ScriptContext, args: ApplyRequest): Verbatim | null {
  if (!args.dryRun && (args.testNowGiven || args.hasTestOverrides || args.forceAll)) return null;
  if (args.dryRun) return planPassThrough(ctx.run('ls_plan', { reason: args.reason, test_now: args.testNow, test_overrides: args.testOverrides }));
  ctx.run('ls_commit', { data: { op: 'render_request', via: 'render_request', reason: args.reason, lights: args.lights() } });
  return null;
}
/** The captured script's retry budget for a revision that keeps moving under the commit. */
const REMOTE_ATTEMPTS = 1_000;

/**
 * `ls_remote_command`: plan, commit the plan against the revision it was
 * planned at, and plan again while the store refuses the commit, up to
 * {@link REMOTE_ATTEMPTS} times. A dry run answers the first plan; a noop is
 * accepted without a commit; an accepted change answers nothing.
 */
function remoteCommand(ctx: ScriptContext, args: RemoteCommandRequest): RemotePlan | null {
  // The press goes out as the text the remote sent, whatever it is.
  const request = { source: args.source, area: args.area, command: pressText(args.command) };
  for (let attempt = 0; attempt < REMOTE_ATTEMPTS; attempt++) {
    const plan = ctx.call('ls_remote_plan', request);
    if (args.dryRun) return plan;
    if (plan.op !== 'noop' && !ctx.call('ls_commit', { data: remotePlanDocument(remoteCommit(plan, args)) }).accepted) continue;
    const power = acceptedPowerSwitch(plan);
    if (power !== undefined) switchPower(ctx, power);
    return null;
  }
  throw new Error('Override revision kept changing; retry budget exhausted');
}

/** Switch the targets, then render switched-on targets as a lamp-on apply. */
function switchPower(ctx: ScriptContext, power: PowerSwitch): void {
  const on = power.tag === 'on_then_render';
  perform(ctx, { kind: 'service', service: on ? 'homeassistant.turn_on' : 'homeassistant.turn_off', data: {},
    target: { entity_id: power.targets } });
  if (on) perform(ctx, { kind: 'script', name: 'ls_apply', args: { reason: 'lamp_on', lights: power.targets } });
}
export const controllerHandlers: ScriptHandlers = {
  ls_switch_plan: typed('ls_switch_plan', { parse: parseSwitchPlanArgs, run: (ctx, args) => switchPlan(ctx.rooms.ofId, args) }),
  // The wire answer is a mapping, so the plan goes out under `plan`.
  ls_plan: withParsedArgs({ parse: parsePlanArgs, run: (ctx, args) => ({ plan: plan(ctx, args) }) }),
  ls_apply: withParsedArgs({ parse: parseApplyArgs, run: apply }),
  ls_remote_command: withParsedArgs({ parse: parseRemoteCommandArgs, run: (ctx, args) => remoteAnswerDocument(remoteCommand(ctx, args)) }),
};
