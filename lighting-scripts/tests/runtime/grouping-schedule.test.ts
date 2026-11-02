import assert from 'node:assert/strict';
import test from 'node:test';
import { list, num, saved, strings, timestamp } from '../../src/domain/schedule.ts';
import { context } from './gestures-context.ts';

test('schedule numeric parsing uses explicit absence and rejects malformed present values', () => {
  assert.equal(num(undefined, 255), 255);
  assert.equal(num(null, 3000), 3000);
  assert.equal(num('unknown', 20), 20);
  assert.equal(num('unavailable', 20), 20);
  assert.equal(num(0, 255), 0);
  assert.equal(num('1e3'), 1000);
  for (const value of ['0x10', 'hot', '', true, Infinity]) {
    assert.throws(() => num(value as never, 255), /finite number/,
      `${JSON.stringify(value)} must not silently become a numeric default`);
  }
});

test('schedule list parsing defaults only absence and rejects present non-arrays', () => {
  assert.deepEqual(list(undefined), []);
  assert.deepEqual(list([0, false, '']), [0, false, '']);
  for (const value of [null, 'light.one', 0, false, {}]) {
    assert.throws(() => list(value as never), /array/,
      `${JSON.stringify(value)} is present and must not be erased to an empty list`);
  }
});

test('schedule string arrays reject malformed members instead of dropping them', () => {
  assert.deepEqual(strings(undefined), []);
  assert.deepEqual(strings(['light.one', 'light.two']), ['light.one', 'light.two']);
  assert.throws(() => strings(['light.one', 7]), /string/);
});

test('schedule timestamps distinguish epoch zero from parse failure', () => {
  assert.equal(timestamp(0), 0);
  assert.equal(timestamp('1970-01-01T00:00:00Z'), 0);
  for (const value of ['not-a-date', '', null, undefined, true]) {
    assert.throws(() => timestamp(value as never), /timestamp/,
      `${JSON.stringify(value) ?? 'undefined'} must not alias epoch zero`);
  }
});

test('saved profiles reject corrupt present caches but allow HA no-value states', () => {
  const ctx = context();
  assert.deepEqual(saved(ctx, 'input_text.missing'), {});
  ctx.put('input_text.profile', 'unavailable');
  assert.deepEqual(saved(ctx, 'input_text.profile'), {});
  ctx.put('input_text.profile', '{bad json');
  assert.throws(() => saved(ctx, 'input_text.profile'), /valid JSON object/);
  ctx.put('input_text.profile', '[]');
  assert.throws(() => saved(ctx, 'input_text.profile'), /object/);
});

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

test('saved profile ownership accepts only a real optional boolean', async () => {
  const ctx = await configured();
  ctx.put('input_text.ls_lamp_studio_day', JSON.stringify({ own: [], on: true, b: 100, m: 'ct', k: 3000 }));
  assert.throws(() => ctx.run('ls_base', { test_now: '2026-10-23T12:00:00+02:00', overrides: {} }), /must be true or false/);
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
  // A cached block is a Block or it is nothing. The captured source would
  // coerce — `or 'night'` turns 0 into Night and `| capitalize` repairs
  // 'NIGHT' — and both of those hide a malformed cache, so the port rejects
  // instead (mandate v2). Earlier revisions of this test asserted the
  // coercions; they asserted a bug.
  ctx.put('input_select.ls_studio_override', 'Day');
  for (const bad of [5, 0, '', 'NIGHT', 'evening', [], {}, true]) {
    const badCache = structuredClone(first.cache_update);
    badCache.baseline.schedule.schedule_details.studio.cur = bad;
    assert.throws(() => ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache: badCache }),
      /must be one of day\/cosy\/night/, `cached cur ${JSON.stringify(bad)} must be rejected, not coerced`);
  }
  // Absent and null both mean "no block decided yet", which legitimately
  // falls back to Night rather than raising.
  for (const absent of [undefined, null]) {
    const emptyCache = structuredClone(first.cache_update);
    emptyCache.baseline.schedule.schedule_details.studio.cur = absent;
    if (absent === undefined) delete emptyCache.baseline.schedule.schedule_details.studio.cur;
    const plan = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache: emptyCache });
    assert.deepEqual(plan.plan.mirror, [{ entity: 'input_select.ls_studio_override', option: 'Night' }],
      `cur ${JSON.stringify(absent) ?? 'absent'} should mirror Night`);
  }
  // A valid cached block still round-trips, option label included.
  const cosyCache = structuredClone(first.cache_update);
  cosyCache.baseline.schedule.schedule_details.studio.cur = 'cosy';
  const cosy = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache: cosyCache });
  assert.equal(cosy.cache_hit, true);
  assert.equal(cosy.plan.sched.studio, 'cosy');
  assert.deepEqual(cosy.plan.mirror, [{ entity: 'input_select.ls_studio_override', option: 'Cosy' }]);
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
