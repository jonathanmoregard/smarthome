import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { context } from './gestures-context.ts';

/**
 * Boundary characterization for `ls_base`'s reads of stored override records:
 * stored facts compare as stored (no `String(...)` coercion), and a record's
 * `when` is the captured `as_timestamp(when, 0)`, never a raise.
 */
const noon = '2026-10-23T12:00:00+02:00';
function configured() {
  const ctx = context(scheduleHandlers);
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', {});
  return ctx;
}
function periods(overrides: JsonObject): [unknown, unknown] {
  const result = configured().run('ls_base', { test_now: noon, overrides }) as JsonObject;
  const targets = result.targets as Record<string, JsonObject>;
  return [targets['light.studio']!.period, targets['room:studio']!.period];
}

test('a stored kind that is a one-element list is not a period claim', () => {
  // Captured `kind in ['channels','input']`: ['channels'] is not equal to 'channels'.
  assert.deepEqual(periods({ claim: { kind: ['channels'], scope: 'room', target: 'studio', when: noon, value: { period: 'cosy' } } }),
    ['day', 'day']);
});

test('a block override is matched as lower-cased text for the lamp, but must be a block for the room', () => {
  assert.deepEqual(periods({ 'block:studio': { kind: 'block', target: 'studio', when: noon, value: 'COSY' } }), ['cosy', 'day']);
});

test('an unreadable stored when is as_timestamp(when, 0), never a raise', () => {
  const unread = { other: { kind: 'light', target: 'light.elsewhere', when: 'not a time' } };
  assert.deepEqual(periods(unread), ['day', 'day']);
  const read = { claim: { kind: 'channels', scope: 'room', target: 'studio', when: 'not a time', value: { period: 'cosy' } } };
  assert.deepEqual(periods(read), ['cosy', 'cosy']);
});
