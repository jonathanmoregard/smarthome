import assert from 'node:assert/strict';
import test from 'node:test';
import { list, num, saved, strings, timestamp } from '../../src/parse/accessors.ts';
import { context, setCatalog, setHandlers } from './gestures-context.ts';

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

test('a saved profile that is not JSON reads as the captured from_json default, {}', () => {
  // Captured: `states(store) | from_json(default={})` in ls_base, `from_json({})` in effects_ui_sync.
  const ctx = context();
  assert.deepEqual(saved(ctx, 'input_text.missing'), {});
  for (const text of ['unavailable', 'unknown', '{bad json', '', 'on']) {
    ctx.put('input_text.profile', text);
    assert.deepEqual(saved(ctx, 'input_text.profile'), {}, JSON.stringify(text));
  }
});

test('a saved profile that parses to a non-mapping reads as no saved profile (lenient saved-value directive)', () => {
  // The captured `.get` on it raises; saved values take a named default instead.
  const ctx = context();
  for (const text of ['[]', '5', '"x"', 'null']) {
    ctx.put('input_text.profile', text);
    assert.deepEqual(saved(ctx, 'input_text.profile'), {}, text);
  }
});

async function configured() {
  const modulePath = '../../src/handlers/schedule.ts';
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

test('schedule handlers parse optional values without using falsiness as presence', async () => {
  const ctx = await configured();
  // test_now and debug are Jinja-truthiness tests (`x is defined and x`); see
  // r4-schedule-jinja.test.ts. What stays here is the typing of present values.

  for (const [field, value, message] of [
    ['overrides', 0, /ls_base\.overrides.*object/],
    ['reason', false, /ls_base\.reason.*string/],
    ['room_only', 0, /ls_base\.room_only.*string/],
  ] as const) {
    assert.throws(() => ctx.run('ls_base', { [field]: value }), message,
      `${field} must reject an ill-typed present value`);
  }
});

test('room schedule handler requires its declared room string', async () => {
  const ctx = await configured();
  assert.throws(() => ctx.run('ls_room_base', { overrides: {} }), /ls_room_base\.room.*string/);
  assert.throws(() => ctx.run('ls_room_base', { room: 0, overrides: {} }), /ls_room_base\.room.*string/);
});

test('saved profile get fallbacks preserve explicit null values', async () => {
  const ctx = await configured();
  ctx.put('input_text.ls_house_day', JSON.stringify({ effect: null, effect_channels: null }));
  const result = ctx.run('ls_base', { test_now: '2026-10-23T12:00:00+02:00', overrides: {} });
  assert.equal(result.schedule.profiles['light.studio'].effect, null);
  assert.equal(result.schedule.profiles['light.studio'].effect_channels, null);
  assert.equal(result.targets['room:studio'].effect, null);
});

test("a saved lamp profile's ownership is the captured `.get('own', false)` truthiness", async () => {
  // A falsy `own` leaves the lamp on its scope's profile; a truthy one makes the lamp's own profile the source.
  for (const [own, effect] of [[[], 'House'], [0, 'House'], [[0], 'Lamp'], ['yes', 'Lamp']] as const) {
    const ctx = await configured();
    ctx.put('input_text.ls_house_day', JSON.stringify({ on: true, b: 240, m: 'ct', k: 4500, effect: 'House' }));
    ctx.put('input_text.ls_lamp_studio_day', JSON.stringify({ own, on: true, b: 100, m: 'ct', k: 3000, effect: 'Lamp' }));
    const result = ctx.run('ls_base', { test_now: '2026-10-23T12:00:00+02:00', overrides: {} });
    assert.equal(result.schedule.profiles['light.studio'].effect, effect, `own ${JSON.stringify(own)}`);
  }
});

test('room cache skips baseline recomputation while updating observations and power', async () => {
  const ctx = await configured();
  const modulePath = '../../src/handlers/planning.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.planningHandlers?.ls_room_plan, 'function', 'room cache planner exists');
  const { resolutionHandlers } = await import('../../src/handlers/resolution.ts');
  const { controllerHandlers } = await import('../../src/handlers/controller.ts');
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const { scheduleHandlers } = await import('../../src/handlers/schedule.ts');
  setHandlers(ctx, { ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...port.planningHandlers });
  ctx.now = '2026-10-23T12:00:00+02:00';
  setCatalog(ctx, { effects: {}, processors: {} });
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

// The saved room period `cur` is read by a lenient parser that always yields a
// Block and never raises (user directive 2026-11-19: "typed with parser that
// is flexible and has default"). One test per input class; each runs a cache
// hit with the override select on Day, so the mirrored option shows the block
// the parser chose.
async function mirrorForCachedCur(cur: unknown) {
  const ctx = await roomPlanner();
  const first = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote' });
  ctx.put('input_select.ls_studio_override', 'Day');
  const cache = structuredClone(first.cache_update);
  if (cur === undefined) delete cache.baseline.schedule.schedule_details.studio.cur;
  else cache.baseline.schedule.schedule_details.studio.cur = cur;
  const plan = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache });
  assert.equal(plan.cache_hit, true);
  return plan.plan.mirror;
}
const mirrorOf = (option: string) => [{ entity: 'input_select.ls_studio_override', option }];

test('saved cur: absent or null means no block decided yet and mirrors Night', async () => {
  for (const absent of [undefined, null]) {
    assert.deepEqual(await mirrorForCachedCur(absent), mirrorOf('Night'), `cur ${JSON.stringify(absent) ?? 'absent'}`);
  }
});

test('saved cur: a valid block round-trips with its option label', async () => {
  assert.deepEqual(await mirrorForCachedCur('cosy'), mirrorOf('Cosy'));
  assert.deepEqual(await mirrorForCachedCur('day'), []);
});

test('saved cur: Jinja-falsy values fall back to Night', async () => {
  for (const falsy of ['', 0, false, [], {}]) {
    assert.deepEqual(await mirrorForCachedCur(falsy), mirrorOf('Night'), `cur ${JSON.stringify(falsy)}`);
  }
});

test('saved cur: a block name in any case is normalised to the block', async () => {
  assert.deepEqual(await mirrorForCachedCur('NIGHT'), mirrorOf('Night'));
  assert.deepEqual(await mirrorForCachedCur('Cosy'), mirrorOf('Cosy'));
  assert.deepEqual(await mirrorForCachedCur('DaY'), []);
});

test('saved cur: any other value falls back to Night instead of raising', async () => {
  for (const garbage of [5, true, 'evening', ' cosy', ['cosy'], { cur: 'cosy' }]) {
    assert.deepEqual(await mirrorForCachedCur(garbage), mirrorOf('Night'), `cur ${JSON.stringify(garbage)}`);
  }
});

async function roomPlanner() {
  const ctx = await configured();
  const { planningHandlers } = await import('../../src/handlers/planning.ts');
  const { resolutionHandlers } = await import('../../src/handlers/resolution.ts');
  const { controllerHandlers } = await import('../../src/handlers/controller.ts');
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const { scheduleHandlers } = await import('../../src/handlers/schedule.ts');
  setHandlers(ctx, { ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...planningHandlers });
  ctx.now = '2026-10-23T12:00:00+02:00';
  setCatalog(ctx, { effects: {}, processors: {} });
  return ctx;
}

// THE INVARIANT on the room cache: a hit spreads the cached schedule into the
// plan, and that schedule may have been written by the live Jinja script. A
// key this port has never heard of must reach the plan as stored. Parsing the
// cached schedule into a typed shape would drop it.
test('a room cache hit carries keys of the cached schedule it does not know into the plan', async () => {
  const ctx = await roomPlanner();
  const first = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote' });
  const cache = structuredClone(first.cache_update);
  cache.baseline.schedule.written_by = { jinja: [1, 'two', null] };
  const hit = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache });
  assert.equal(hit.cache_hit, true);
  assert.deepEqual(hit.plan.written_by, { jinja: [1, 'two', null] });
});

// Record checks interleave with planning: the period scan visits records in
// key order and parses a matched record's `when` before it looks at the next
// record at all. Parsing every record up front would raise on the later
// non-mapping record first.
test('room planning raises on an earlier malformed record before a later non-mapping one', async () => {
  const ctx = await roomPlanner();
  const overrides = {
    'a:block': { kind: 'block', target: 'studio', value: 'cosy', when: 'not-a-date' },
    'b:broken': 7,
  };
  assert.throws(() => ctx.run('ls_room_plan', { room: 'studio', overrides, reason: 'remote' }), /schedule timestamp/);
  assert.throws(() => ctx.run('ls_room_plan', { room: 'studio', overrides: { 'b:broken': 7 }, reason: 'remote' }),
    /ls_room_plan\.overrides\.b:broken must be an object/);
});

test('scheduled baseline packs only explicitly configured complete command groups', async () => {
  const ctx = await configured();
  ctx.members.push('light.other'); ctx.areas['light.other'] = 'studio';
  ctx.put('light.other', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  setCatalog(ctx, { baseline_groups: { 'light.studio_group': ['light.studio', 'light.other'] } });
  const result = ctx.run('ls_base', { test_now: '2026-10-23T12:00:00+02:00', overrides: {} });
  assert.deepEqual(result.schedule.cmds[0].ids, ['light.studio_group']);
  assert.equal(result.targets['light.studio'].brightness, 240);
  assert.equal(result.targets['light.other'].brightness, 240);
});
