import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { planningHandlers } from '../../src/handlers/planning.ts';
import { resolutionHandlers } from '../../src/handlers/resolution.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { nativeHandlers } from '../../src/handlers/native-controls.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { warmEndOf } from '../../src/parse/planning.ts';
import { reveal } from '../../src/runtime/verbatim.ts';
import { context, setCatalog } from './gestures-context.ts';

/**
 * `ls_room_plan`'s Jinja falsy reads and its saved override records.
 * Captured: the dependency fingerprint lists `(state_attr(e,'rgb_color') or [])|list`
 * for every schedule light, the warm end is `(rgb_color or [255,126,0])|list`, and
 * every record loop is `for key,r in overrides... if r is mapping` with
 * `as_timestamp(r.get('when'),0)` and a raw `value.get('period_updated', ...)` stamp.
 */
const noon = '2026-10-23T12:00:00+02:00';
function roomPlanner() {
  const ctx = context({ ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...planningHandlers });
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k, rgb_color: [255, 255, 255] });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.now = noon;
  setCatalog(ctx, { effects: {}, processors: {} });
  return ctx;
}
type RoomPlan = { cache_update: { periods: Record<string, JsonValue[]>; dependencies: { values: JsonValue[] } } };
const plan = (ctx: ReturnType<typeof roomPlanner>, overrides: JsonObject = {}) =>
  ctx.run('ls_room_plan', { room: 'studio', overrides, reason: 'remote' }) as unknown as RoomPlan;

test('a schedule light that is off, rgb_color null, fingerprints as []', () => {
  const ctx = roomPlanner();
  ctx.put('light.ls_house_night', 'off', { brightness: null, color_mode: null, color_temp_kelvin: null, rgb_color: null });
  const values = plan(ctx).cache_update.dependencies.values;
  const at = values.indexOf('off');
  assert.deepEqual(values.slice(at - 1, at + 5), [JSON.stringify({ on: true, b: 10, m: 'ct', k: 2000 }), 'off', null, null, null, []]);
});

test('the warm end is Jinja `(rgb_color or [255,126,0])`, and a value that is not a triple is the default', () => {
  for (const value of [undefined, null, [], {}, '', 0, false]) assert.deepEqual(reveal(warmEndOf(value)), [255, 126, 0], JSON.stringify(value));
  // The captured `| list` lists these, and the gradient plan then raises on
  // them; a warm end a person sets recovers to the default instead (2026-11-21).
  assert.deepEqual(reveal(warmEndOf('abc')), [255, 126, 0]);
  assert.deepEqual(reveal(warmEndOf({ a: 1 })), [255, 126, 0]);
  assert.deepEqual(reveal(warmEndOf([1, 2, 3])), [1, 2, 3]);
});

test("a saved record's when is as_timestamp(when, 0) in the period fingerprint, never a raise", () => {
  for (const when of ['not-a-date', '', 1792771200, false, null] as JsonValue[]) {
    const periods = plan(roomPlanner(), { 'a:block': { kind: 'block', target: 'studio', value: 'cosy', when } }).cache_update.periods;
    assert.deepEqual(periods, { 'a:block': ['block', null, 'studio', 'cosy', 0, false] }, JSON.stringify(when));
  }
});

test('a saved period_updated is stored in the fingerprint as it is, unread', () => {
  for (const period_updated of ['x', null, true, [1]] as JsonValue[]) {
    const record = { kind: 'channels', scope: 'house', target: null, when: noon, value: { period: 'cosy', period_updated } };
    assert.deepEqual(plan(roomPlanner(), { c: record }).cache_update.periods, { c: ['channels', 'house', null, 'cosy', period_updated, false] },
      JSON.stringify(period_updated));
  }
});

test('a saved record that is not a mapping is skipped, as every captured loop does', () => {
  for (const broken of [7, 'x', null, [1]] as JsonValue[]) {
    assert.deepEqual(plan(roomPlanner(), { 'b:broken': broken }).cache_update.periods, {}, JSON.stringify(broken));
    const ctx = roomPlanner(); ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
    const result = ctx.run('ls_room_plan', { room: 'studio', overrides: { 'mode:sara': broken }, reason: 'remote' }) as unknown as
      { plan: { base: Record<string, JsonObject> }; cache_update: { periods: JsonObject } };
    assert.deepEqual(result.cache_update.periods, {}, JSON.stringify(broken));
    assert.deepEqual(result.plan.base['light.studio']!.ignore_overrides, [], JSON.stringify(broken));
  }
});

test("ls_room_plan reads a saved truthy non-mapping range_defaults as the built-in ranges", () => {
  for (const bad of [5, 'x', [1], true] as JsonValue[]) {
    const ctx = roomPlanner();
    ctx.put('sensor.ls_overrides', '0', { overrides: {}, range_defaults: bad });
    assert.doesNotThrow(() => plan(ctx), JSON.stringify(bad));
  }
});
