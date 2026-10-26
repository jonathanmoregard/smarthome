import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';

async function configured() {
  const modulePath = '../../src/domain/schedule.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.scheduleHandlers?.ls_base, 'function', 'scheduled baseline exists');
  const ctx = context(port.scheduleHandlers);
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]]) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k, rgb_color: [255, 255, 255] });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.put('input_datetime.ls_studio_wake', '2026-10-23T06:00:00+02:00', { timestamp: 1792728000 });
  ctx.put('input_number.ls_studio_wake_fade', '30');
  return ctx;
}

test('room wake baseline interpolates discrete profiles and preserves explicit period priority', async () => {
  const ctx = await configured();
  const result = ctx.run('ls_base', { test_now: '2026-10-23T06:15:00+02:00', overrides: {}, reason: 'config' });
  assert.deepEqual([result.targets['room:studio'].brightness, result.targets['room:studio'].color, result.targets['room:studio'].period], [125, { kelvin: 3250 }, 'night']);
  assert.deepEqual(result.targets['light.studio'].brightness, 125);
  const overrides = { custom: { kind: 'channels', scope: 'room', target: 'studio', when: '2026-10-23T06:01:00+02:00', value: { period: 'cosy', channels: {} } } };
  const explicit = ctx.run('ls_base', { test_now: '2026-10-23T06:15:00+02:00', overrides });
  assert.equal(explicit.targets['room:studio'].brightness, 90);
});

test('schedule chooses weekend timing on local calendar across DST fall-back', async () => {
  const ctx = await configured();
  ctx.put('input_datetime.ls_studio_wake', 'unknown');
  ctx.put('input_datetime.ls_house_day_weekend', '09:00:00');
  const result = ctx.run('ls_base', { test_now: '2026-10-25T08:30:00+01:00', overrides: {} });
  assert.equal(result.targets['room:studio'].period, 'night');
  assert.equal(result.schedule.schedule_details.studio.left, 1800);
  assert.equal(result.schedule.schedule_details.studio.cur_ts, Date.parse('2026-10-24T23:00:00+02:00') / 1000);
});

test('room cache skips baseline recomputation while updating observations and power', async () => {
  const ctx = await configured();
  const modulePath = '../../src/domain/planning.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.planningHandlers?.ls_room_plan, 'function', 'room cache planner exists');
  const { resolutionHandlers } = await import('../../src/domain/resolution.ts');
  const { controllerHandlers } = await import('../../src/domain/controller.ts');
  const { nativeHandlers } = await import('../../src/domain/native-controls.ts');
  const { scheduleHandlers } = await import('../../src/domain/schedule.ts');
  const handlers = { ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...port.planningHandlers };
  ctx.run = function(name, args = {}) { return handlers[name.replace(/^script\./, '')](this, args); };
  ctx.now = '2026-10-23T12:00:00+02:00';
  ctx.catalog = { effects: {}, processors: {} };
  const first = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote' });
  ctx.now = '2026-10-23T12:00:01+02:00';
  ctx.put('light.studio', 'on', { brightness: 42, color_mode: 'rgb', rgb_color: [1, 2, 3] });
  const hit = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache: first.cache_update, power: { studio: false } });
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.cache_update, null);
  assert.equal(hit.plan.base['light.studio'].observed.brightness, 42);
  assert.equal(hit.plan.resolved.targets['light.studio'].on, false);
  const fresh = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', power: { studio: false } });
  assert.deepEqual(hit.plan, fresh.plan);
});

test('scheduled baseline packs only explicitly configured complete command groups', async () => {
  const ctx = await configured();
  ctx.members.push('light.other'); ctx.areas['light.other'] = 'studio';
  ctx.put('light.other', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.catalog = { baseline_groups: { 'light.studio_group': ['light.studio', 'light.other'] } };
  const result = ctx.run('ls_base', { test_now: '2026-10-23T12:00:00+02:00', overrides: {} });
  assert.deepEqual(result.schedule.cmds[0].ids, ['light.studio_group']);
  assert.equal(result.targets['light.studio'].brightness, 240);
  assert.equal(result.targets['light.other'].brightness, 240);
});
