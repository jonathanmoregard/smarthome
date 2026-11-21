import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { planningHandlers } from '../../src/handlers/planning.ts';
import { resolutionHandlers } from '../../src/handlers/resolution.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { nativeHandlers } from '../../src/handlers/native-controls.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { context, setCatalog } from './gestures-context.ts';

/**
 * Scheduled fades are gradual in both directions (2026-11-20). A fade from an
 * off scene to a lit one switches the lamp on at level 1 in the lit end's
 * colour when the fade starts and ramps the level linearly to the lit end's
 * level, the same ramp the remote blend uses towards an off end; the colour is
 * the lit end's throughout. On -> off keeps dimming towards 1 and switches off
 * when the stage ends. Deliberate divergence from today's scripts, which jump
 * straight to the lit end.
 *
 * House schedule: day 08:00 (240, 4500 K), cosy 18:00 (90, 2500 K), night 23:00,
 * 20-minute fades, so night -> day fades 07:40-08:00 on 2026-10-24. Level at
 * progress p: max(1, round(1 + 239 p)).
 */
const OFF = { brightness: null, color_mode: null, color_temp_kelvin: null, rgb_color: null };
function house() {
  const ctx = context({ ...handlers, ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...planningHandlers });
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k, rgb_color: [255, 180, 100] });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.ls_house_night', 'off', OFF);
  ctx.put('light.studio', 'off', OFF);
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  setCatalog(ctx, { effects: {}, processors: {} });
  return ctx;
}
type Base = { targets: Record<string, JsonObject>; schedule: { cmds: JsonObject[] } };
const base = (ctx: ReturnType<typeof house>, at: string, extra: JsonObject = {}) =>
  ctx.run('ls_base', { test_now: at, overrides: {}, ...extra }) as unknown as Base;
const lit = (target: JsonObject | undefined) => target === undefined ? undefined
  : { on: target.on, brightness: target.brightness, color: target.color };

test('night (off) -> day: a small way in the lamp is on, dim, in the day colour', () => {
  const result = base(house(), '2026-10-24T07:41:00+02:00'); // p = 0.05
  assert.deepEqual(lit(result.targets['light.studio']), { on: true, brightness: 13, color: { kelvin: 4500 } });
  assert.deepEqual(result.schedule.cmds, [{ kind: 'ct', brightness: 13, kelvin: 4500, transition: 3, ids: ['light.studio'] }]);
});

test('night (off) -> day: halfway the level is halfway up the ramp from 1', () => {
  assert.deepEqual(lit(base(house(), '2026-10-24T07:50:00+02:00').targets['light.studio']), { on: true, brightness: 120, color: { kelvin: 4500 } });
});

test('night (off) -> day: near the end the level is near the day level', () => {
  assert.deepEqual(lit(base(house(), '2026-10-24T07:59:00+02:00').targets['light.studio']), { on: true, brightness: 228, color: { kelvin: 4500 } });
});

test('night (off) -> day: once day starts the lamp is the day scene, unchanged', () => {
  assert.deepEqual(lit(base(house(), '2026-10-24T08:30:00+02:00').targets['light.studio']), { on: true, brightness: 240, color: { kelvin: 4500 } });
});

test('cosy (on) -> night (off) still dims towards 1 and stays lit until night starts', () => {
  const ctx = house();
  assert.deepEqual(lit(base(ctx, '2026-10-23T22:50:00+02:00').targets['light.studio']), { on: true, brightness: 45, color: { kelvin: 2500 } });
  assert.deepEqual(lit(base(ctx, '2026-10-23T22:59:59+02:00').targets['light.studio']), { on: true, brightness: 1, color: { kelvin: 2500 } });
});

test('night (off) -> day (off) stays off through the fade', () => {
  const ctx = house();
  ctx.put('light.ls_house_day', 'off', OFF);
  const result = base(ctx, '2026-10-24T07:50:00+02:00');
  assert.equal(result.targets['light.studio']!.on, false);
  assert.equal(Object.hasOwn(result.targets['light.studio']!, 'brightness'), false);
  assert.deepEqual(result.schedule.cmds, [{ kind: 'off', transition: 3, ids: ['light.studio'] }]);
});

function waking() {
  const ctx = house();
  ctx.put('input_datetime.ls_studio_wake', '2026-10-24T06:00:00+02:00', { timestamp: Date.parse('2026-10-24T06:00:00+02:00') / 1000 });
  ctx.put('input_number.ls_studio_wake_fade', '30');
  return ctx;
}

test('a wake fade from an off night starts at the wake time, on at level 1 in the day colour', () => {
  const result = base(waking(), '2026-10-24T06:00:00+02:00'); // elapsed 0, p = 0
  assert.deepEqual(lit(result.targets['light.studio']), { on: true, brightness: 1, color: { kelvin: 4500 } });
  assert.deepEqual(lit(result.targets['room:studio']), { on: true, brightness: 1, color: { kelvin: 4500 } });
});

test('a wake fade from an off night ramps like a sunrise: halfway is halfway up', () => {
  const result = base(waking(), '2026-10-24T06:15:00+02:00'); // p = 0.5
  assert.deepEqual(lit(result.targets['light.studio']), { on: true, brightness: 120, color: { kelvin: 4500 } });
});

test('the room target ramps too, so a range switch turns on when the ramp reaches its range', () => {
  const ctx = house();
  ctx.areas['switch.plug'] = 'studio';
  ctx.put('sensor.ls_overrides', '0', { overrides: {}, switch_ranges: { 'switch.plug': { profile: 'custom', min: 40, max: 60 } } });
  assert.deepEqual(lit(base(ctx, '2026-10-24T07:50:00+02:00').targets['room:studio']), { on: true, brightness: 120, color: { kelvin: 4500 } });
  const plug = (at: string) => (ctx.run('ls_plan', { reason: 'config', test_now: at, test_overrides: {} }) as unknown as
    { plan: { switches: Record<string, { on: boolean }> } }).plan.switches['switch.plug']!.on;
  assert.equal(plug('2026-10-24T07:41:00+02:00'), false); // level 13 = 5 %
  assert.equal(plug('2026-10-24T07:50:00+02:00'), true); // level 120 = 47 %
});

test('an observed-off lamp fading out an expired override starts near 1 and converges per tick', () => {
  const ctx = house();
  ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
  const overrides = { hold: { kind: 'light', target: 'light.studio', when: '2026-10-24T07:30:00+02:00', value: null } };
  // Non-tick render 10 minutes from day: p = 3 / 600.
  assert.deepEqual(lit(base(ctx, '2026-10-24T07:50:00+02:00', { overrides }).targets['light.studio']),
    { on: true, brightness: 2, color: { kelvin: 4500 } });
  // A tick 60 s from day: p = 1, the day level.
  assert.deepEqual(lit(base(ctx, '2026-10-24T07:59:00+02:00', { overrides, reason: 'tick' }).targets['light.studio']),
    { on: true, brightness: 240, color: { kelvin: 4500 } });
});
