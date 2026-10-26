import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, isObject } from './scale.ts';
import { recordTimestamp } from './resolution.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];

export function switchPlan(ctx: ScriptContext, args: JsonObject): JsonObject {
  const targets = object(args.targets), switches: JsonObject = {}, defaults = object(args.defaults);
  for (const [entity, raw] of Object.entries(object(args.ranges))) {
    const rule = object(raw), room = ctx.areas[entity];
    const group = room ? object(targets[`room:${room}`]) : {};
    const interval = rule.profile === 'custom' ? [rule.min, rule.max] : list(defaults[String(rule.profile)]);
    const low = interval[0], high = interval[1];
    if (interval.length !== 2 || typeof low !== 'number' || typeof high !== 'number' || !(0 <= low && low <= high && high <= 100) || !Object.keys(group).length) continue;
    const brightness = Number(group.level) * 100 / 255;
    switches[entity] = { on: Boolean(group.on) && low <= brightness && brightness <= high,
      room: room!, brightness, range: [low, high] };
  }
  return { switches };
}

export function plan(ctx: ScriptContext, args: JsonObject): JsonObject {
  const overrides = isObject(args.test_overrides) ? args.test_overrides : object(ctx.attr('sensor.ls_overrides', 'overrides'));
  const baseline = object(ctx.run('ls_base', { overrides, test_now: args.test_now ?? null,
    reason: args.reason ?? 'config', room_only: args.room ?? '' }));
  const schedule = object(baseline.schedule);
  const active: JsonObject = Object.fromEntries(Object.entries(overrides).filter(([key]) => !list(schedule.stale_keys).includes(key)));
  const catalog = ctx.run('effects_catalog');
  const warmEnd = ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color') ?? [255, 126, 0];
  let cached: JsonObject = {};
  for (const raw of Object.values(object(baseline.targets))) {
    const room = object(raw).area;
    cached = { ...cached, ...object(object(ctx.attr(`sensor.ls_cache_${room}`, 'cache')).gradients) };
  }
  const compiled = object(ctx.run('effects_gradient_plan', { base: baseline.targets ?? {}, warm_end: warmEnd, cached }));
  const resolved = object(ctx.run('effects_resolve', { base: baseline.targets ?? {}, overrides: active, catalog,
    sara: Object.hasOwn(active, 'mode:sara'), private: ctx.labels?.private_room ?? [],
    power: ctx.attr('sensor.ls_overrides', 'power') ?? {}, warm_end: warmEnd, gradients: compiled.gradients ?? {} }));
  const switches = object(ctx.run('ls_switch_plan', { targets: resolved.targets ?? {},
    ranges: ctx.attr('sensor.ls_overrides', 'switch_ranges') ?? {},
    defaults: ctx.attr('sensor.ls_overrides', 'range_defaults') ?? { bright: [90, 100], cosy: [30, 60] } }));
  const wanted = Object.hasOwn(active, 'mode:sara') ? 'on' : 'off';
  return { plan: { ...schedule, base: baseline.targets ?? {}, resolved, gradients: compiled.gradients ?? {},
    switches: switches.switches ?? {}, revision: ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now,
    plan_order: recordTimestamp(ctx.now), remote: args.reason === 'remote',
    sara_mirror: ctx.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null } };
}

function apply(ctx: ScriptContext, args: JsonObject): JsonValue {
  if (!args.dry_run && (args.test_now || Object.hasOwn(args, 'test_overrides') || args.force_all)) return null;
  if (args.dry_run) return ctx.run('ls_plan', { reason: args.reason ?? 'config', test_now: args.test_now ?? null, test_overrides: args.test_overrides ?? null });
  ctx.run('ls_commit', { data: { op: 'render_request', via: 'render_request', reason: args.reason ?? 'config', lights: args.lights ?? [] } });
  return null;
}

function remoteCommand(ctx: ScriptContext, args: JsonObject): JsonValue {
  const input = { source: args.source ?? '', area: args.area ?? '', command: args.command ?? '' };
  if (args.dry_run) return ctx.run('ls_remote_plan', input);
  let result: JsonObject = {}, accepted = false;
  for (let attempt = 0; attempt < 1_000 && !accepted; attempt++) {
    result = object(ctx.run('ls_remote_plan', input));
    accepted = result.op === 'noop' || Boolean(object(ctx.run('ls_commit', { data: { ...result,
      expected_revision: result.input_revision ?? null, area: input.area, via: 'remote', source: input.source } })).accepted);
  }
  if (!accepted) throw new Error('Override revision kept changing; retry budget exhausted');
  if (result.op === 'power') {
    ctx.emit(result.on ? 'homeassistant.turn_on' : 'homeassistant.turn_off', {}, { entity_id: result.targets ?? [] });
    if (result.on) ctx.run('ls_apply', { reason: 'lamp_on', lights: result.targets ?? [] });
  }
  return null;
}

export const controllerHandlers: ScriptHandlers = { ls_switch_plan: switchPlan, ls_plan: plan, ls_apply: apply, ls_remote_command: remoteCommand };
