import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { requireArray, requireBoolean, requireObject, requireString } from '../runtime/parse.ts';
import { object, requireRgb, WARM_END } from './scale.ts';
import { recordTimestamp } from './resolution.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const rangeDefaults: JsonObject = { bright: [90, 100], cosy: [30, 60] };

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

export function switchPlan(ctx: ScriptContext, args: JsonObject): JsonObject {
  const targets = object(args.targets), switches: JsonObject = {}, defaults = object(args.defaults);
  for (const [entity, raw] of Object.entries(object(args.ranges))) {
    const rule = object(raw), room = ctx.areas[entity];
    const group = room ? object(targets[`room:${room}`]) : {};
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

export function plan(ctx: ScriptContext, args: JsonObject): JsonObject {
  const testOverrides = optionalScriptObject(args.test_overrides, 'ls_plan.test_overrides');
  const overrides = testOverrides === undefined
    ? optionalAttributeObject(ctx.attr('sensor.ls_overrides', 'overrides'), 'ls_plan.overrides')
    : testOverrides;
  const testNow = args.test_now === undefined || args.test_now === null
    ? null
    : requireString(args, 'test_now', 'ls_plan');
  const reason = args.reason === undefined ? 'config' : requireString(args, 'reason', 'ls_plan');
  const room = args.room === undefined ? '' : requireString(args, 'room', 'ls_plan');
  const baseline = requiredResultObject(ctx.run('ls_base', { overrides, test_now: testNow,
    reason, room_only: room }), 'ls_plan.baseline');
  const schedule = requireObject(baseline, 'schedule', 'ls_plan.baseline');
  const baselineTargets = requireObject(baseline, 'targets', 'ls_plan.baseline');
  const active: JsonObject = Object.fromEntries(Object.entries(overrides).filter(([key]) => !list(schedule.stale_keys).includes(key)));
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
  const compiled = requiredResultObject(ctx.run('effects_gradient_plan', { base: baselineTargets, warm_end: warmEnd, cached }), 'ls_plan.compiled');
  const gradients = requireObject(compiled, 'gradients', 'ls_plan.compiled');
  const privateRooms = ctx.labels?.private_room;
  const power = optionalAttributeObject(ctx.attr('sensor.ls_overrides', 'power'), 'ls_plan.power');
  const resolved = requiredResultObject(ctx.run('effects_resolve', { base: baselineTargets, overrides: active, catalog,
    sara: Object.hasOwn(active, 'mode:sara'), private: privateRooms === undefined ? [] : privateRooms,
    power, warm_end: warmEnd, gradients }), 'ls_plan.resolved');
  const resolvedTargets = requireObject(resolved, 'targets', 'ls_plan.resolved');
  const ranges = optionalAttributeObject(ctx.attr('sensor.ls_overrides', 'switch_ranges'), 'ls_plan.switch_ranges');
  const rawDefaults = ctx.attr('sensor.ls_overrides', 'range_defaults');
  const defaults = rawDefaults === undefined || rawDefaults === null
    ? rangeDefaults
    : requireObject({ value: rawDefaults }, 'value', 'ls_plan.range_defaults');
  const switches = requiredResultObject(ctx.run('ls_switch_plan', { targets: resolvedTargets, ranges, defaults }), 'ls_plan.switches');
  const plannedSwitches = requireObject(switches, 'switches', 'ls_plan.switches');
  const revisionValue = ctx.state['sensor.ls_overrides']?.last_updated;
  const revision = requireString({ value: revisionValue === undefined ? null : revisionValue }, 'value', 'ls_plan.revision');
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...schedule, base: baselineTargets, resolved, gradients,
    switches: plannedSwitches, revision,
    plan_order: recordTimestamp(ctx.now), remote: args.reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null } };
}

function apply(ctx: ScriptContext, args: JsonObject): JsonValue {
  const dryRun = optionalScriptBoolean(args.dry_run, 'ls_apply.dry_run');
  const forceAll = optionalScriptBoolean(args.force_all, 'ls_apply.force_all');
  const testNow = args.test_now === undefined || args.test_now === null
    ? undefined
    : requireString(args, 'test_now', 'ls_apply');
  const hasTestOverrides = Object.hasOwn(args, 'test_overrides');
  const testOverrides = optionalScriptObject(args.test_overrides, 'ls_apply.test_overrides');
  const reason = args.reason === undefined ? 'config' : requireString(args, 'reason', 'ls_apply');
  if (!dryRun && (testNow !== undefined || hasTestOverrides || forceAll)) return null;
  if (dryRun) return ctx.run('ls_plan', { reason, test_now: testNow === undefined ? null : testNow,
    test_overrides: testOverrides === undefined ? null : testOverrides });
  const lights = args.lights === undefined ? [] : requireArray(args, 'lights', 'ls_apply');
  ctx.run('ls_commit', { data: { op: 'render_request', via: 'render_request', reason, lights } });
  return null;
}

function remoteCommand(ctx: ScriptContext, args: JsonObject): JsonValue {
  const input = {
    source: requireString(args, 'source', 'ls_remote_command'),
    area: requireString(args, 'area', 'ls_remote_command'),
    command: requireString(args, 'command', 'ls_remote_command'),
  };
  const dryRun = optionalScriptBoolean(args.dry_run, 'ls_remote_command.dry_run');
  if (dryRun) return ctx.run('ls_remote_plan', input);
  let result: JsonObject = {}, accepted = false;
  for (let attempt = 0; attempt < 1_000 && !accepted; attempt++) {
    result = requiredResultObject(ctx.run('ls_remote_plan', input), 'ls_remote_command.plan');
    if (result.op === 'noop') accepted = true;
    else {
      const inputRevision = requireString(result, 'input_revision', 'ls_remote_command.plan');
      const committed = object(ctx.run('ls_commit', { data: { ...result,
        expected_revision: inputRevision, area: input.area, via: 'remote', source: input.source } }));
      accepted = requireBoolean(committed.accepted, 'ls_remote_command.commit.accepted');
    }
  }
  if (!accepted) throw new Error('Override revision kept changing; retry budget exhausted');
  if (result.op === 'power') {
    const on = requireBoolean(result.on, 'ls_remote_command.plan.on');
    const targets = requireArray(result, 'targets', 'ls_remote_command.plan');
    ctx.emit(on ? 'homeassistant.turn_on' : 'homeassistant.turn_off', {}, { entity_id: targets });
    if (on) ctx.run('ls_apply', { reason: 'lamp_on', lights: targets });
  }
  return null;
}

export const controllerHandlers: ScriptHandlers = { ls_switch_plan: switchPlan, ls_plan: plan, ls_apply: apply, ls_remote_command: remoteCommand };
