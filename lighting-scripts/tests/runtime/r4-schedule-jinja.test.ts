import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { context } from './gestures-context.ts';

/**
 * `ls_base` / `ls_room_base` reads that the captured templates take through a
 * Jinja falsy operator. Every expectation was rendered by the captured template
 * itself in Home Assistant 2026.7.4 on the same house (round-4 differential).
 *
 * - `(rgb_color or [255,255,255]) | list`: Home Assistant reports
 *   `rgb_color: null` for a lamp that is off, so the falsy default was the
 *   ordinary path. The port no longer invents the white (2026-11-20, off is a
 *   state that cannot carry a colour): falsy is no colour; truthy still goes
 *   through Jinja's `list`.
 * - `test_now is defined and test_now`: a Jinja-falsy test_now is "now".
 */
const cosy = '2026-10-23T19:00:00+02:00';
const NULL_LIGHT = { brightness: null, color_mode: null, color_temp_kelvin: null, rgb_color: null };
function configured(overrides: JsonObject = {}) {
  const ctx = context(scheduleHandlers);
  ctx.now = cosy;
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k, rgb_color: [255, 180, 100] });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500, rgb_color: [255, 200, 150] });
  ctx.put('sensor.ls_overrides', '0', { overrides });
  return ctx;
}
type Result = { targets: Record<string, JsonObject>; schedule: { cmds: JsonObject[] } };
const base = (ctx: ReturnType<typeof configured>, args: JsonObject = {}) =>
  ctx.run('ls_base', { test_now: cosy, overrides: {}, ...args }) as unknown as Result;
const roomBase = (ctx: ReturnType<typeof configured>, args: JsonObject = {}) =>
  ctx.run('ls_room_base', { test_now: cosy, overrides: {}, room: 'studio', ...args }) as unknown as Result;

test('a lamp that is off, with every colour attribute null, is observed as off (the oracle invented white 255)', () => {
  const ctx = configured();
  ctx.put('light.studio', 'off', NULL_LIGHT);
  for (const run of [base, roomBase]) {
    assert.deepEqual(run(ctx).targets['light.studio']!.observed, { on: false });
  }
});

test('an rgb source whose rgb_color is Jinja-falsy has no colour (the oracle invented white)', () => {
  for (const value of [null, [], {}, '', 0, false] as JsonValue[]) {
    const ctx = configured();
    ctx.put('light.ls_house_cosy', 'on', { brightness: 90, color_mode: 'rgb', color_temp_kelvin: null, rgb_color: value });
    const cmds = base(ctx).schedule.cmds;
    assert.deepEqual(cmds, [{ kind: 'brightness', brightness: 90, transition: 3, ids: ['light.studio'] }], JSON.stringify(value));
    const room = roomBase(ctx).targets['room:studio']!;
    assert.equal(Object.hasOwn(room, 'color'), false, JSON.stringify(value));
  }
});

test('a truthy rgb_color that is not three numbers is no colour (Jinja would list it)', () => {
  // The captured `| list` makes a string its characters and a mapping its
  // keys; such a colour raises further on where the resolver reads a scene's
  // colour. A light attribute recovers instead (2026-11-21): no colour.
  const ctx = configured();
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'rgb', color_temp_kelvin: null, rgb_color: 'abc' });
  assert.deepEqual(base(ctx).targets['light.studio']!.observed, { brightness: 100 });
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'rgb', color_temp_kelvin: null, rgb_color: { a: 1 } });
  assert.deepEqual(base(ctx).targets['light.studio']!.observed, { brightness: 100 });
});

test("a colour-temperature lamp's rgb_color is never read for its profile", () => {
  // The captured profile macro reads rgb_color only in its non-colour-temp arm.
  const ctx = configured();
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500, rgb_color: 5 });
  for (const run of [base, roomBase]) {
    assert.deepEqual(run(ctx).targets['light.studio']!.observed, { brightness: 100, color: { kelvin: 2500 } });
  }
});

test('a Jinja-falsy test_now is now, not epoch zero and not a parse error', () => {
  const expected = base(configured(), { test_now: undefined as never });
  for (const value of [0, '', false] as JsonValue[]) {
    assert.deepEqual(base(configured(), { test_now: value }).schedule, expected.schedule, JSON.stringify(value));
    assert.deepEqual(roomBase(configured(), { test_now: value }).schedule, roomBase(configured(), { test_now: undefined as never }).schedule,
      JSON.stringify(value));
  }
});

test('dbg is included only for a Jinja-truthy debug, as `debug is defined and debug`', () => {
  for (const run of [base, roomBase]) {
    for (const value of [false, 0, '', null] as JsonValue[]) {
      assert.equal(Object.hasOwn(run(configured(), { debug: value }).schedule, 'dbg'), false, JSON.stringify(value));
    }
    for (const value of [true, 1, 'yes'] as JsonValue[]) {
      assert.equal(Object.hasOwn(run(configured(), { debug: value }).schedule, 'dbg'), true, JSON.stringify(value));
    }
  }
});
