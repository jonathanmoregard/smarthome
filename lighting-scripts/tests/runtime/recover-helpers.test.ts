import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { inputNumber } from '../../src/parse/automations.ts';
import { stateNumber } from '../../src/parse/schedule.ts';
import { context } from './gestures-context.ts';
import { house } from './house-view.ts';

/**
 * Helper states a person sets in Home Assistant recover to a default, never
 * raise (2026-11-21, "This goes for all similar where the user can edit"). An
 * `input_number` whose state is not a number reads as the fallback the read
 * already names for `unknown`/`unavailable`; an `input_datetime` wake whose
 * `timestamp` cannot be read is no wake.
 */
const cosy = '2026-10-23T19:00:00+02:00';
function configured() {
  const ctx = context(scheduleHandlers);
  ctx.now = cosy;
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:50', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  return ctx;
}
function base(setup: (ctx: ReturnType<typeof configured>) => void) {
  const ctx = configured(); setup(ctx);
  return ctx.run('ls_room_base', { test_now: cosy, overrides: {}, room: 'studio' });
}

for (const state of ['garbage', '', '12 minutes', 'inf']) {
  test(`an input_number state that is not a number reads as its fallback: ${JSON.stringify(state)}`, () => {
    assert.equal(stateNumber(house({ 'input_number.x': state }), 'input_number.x', 20), 20);
    assert.equal(inputNumber(house({ 'input_number.x': state }), 'input_number.x', 180), 180);
  });
}

test('an input_number state that is a number is that number', () => {
  assert.equal(stateNumber(house({ 'input_number.x': '12.5' }), 'input_number.x', 20), 12.5);
  assert.equal(inputNumber(house({ 'input_number.x': 'unknown' }), 'input_number.x', 180), 180);
});

test("a block fade that is not a number schedules as the 20 minute default, never a raise", () => {
  assert.deepEqual(base(ctx => ctx.put('input_number.ls_house_night_fade', 'garbage')),
    base(ctx => ctx.put('input_number.ls_house_night_fade', '20')));
});

test('a wake whose timestamp cannot be read is no wake, never a raise', () => {
  for (const timestamp of [undefined, null, 'garbage', [1]]) {
    assert.deepEqual(base(ctx => ctx.put('input_datetime.ls_studio_wake', '06:30:00', timestamp === undefined ? {} : { timestamp })),
      base(() => {}), JSON.stringify(timestamp));
  }
});

test('a wake fade that is not a number reads as the 37.5 minute default', () => {
  const wake = (fade: string) => base(ctx => {
    ctx.put('input_datetime.ls_studio_wake', '06:30:00', { timestamp: Date.parse(cosy) / 1000 - 600 });
    ctx.put('input_number.ls_studio_wake_fade', fade);
  });
  assert.deepEqual(wake('garbage'), wake('37.5'));
});
