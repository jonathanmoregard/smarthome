import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { context } from './gestures-context.ts';

/**
 * `ls_base` / `ls_room_base` reads of saved state -- the override records in
 * `sensor.ls_overrides` and the saved `input_text` profiles. Directive
 * (2026-11-19): a saved value is parsed by a lenient typed parser with a named
 * default and never raises. Where the captured template already has a default
 * (`as_timestamp(when, 0)`) that is the default; elsewhere the default is named
 * in the parser. Oracle-matching expectations were rendered by the captured
 * template in Home Assistant 2026.7.4 on the same house.
 */
const cosy = '2026-10-23T19:00:00+02:00';
const claimAt = '2026-10-23T18:30:00+02:00';
function configured() {
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
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  return ctx;
}
type Result = { targets: Record<string, JsonObject>; schedule: { stale_keys: string[]; mirror: JsonObject[] } };
function periods(overrides: JsonObject, setup: (ctx: ReturnType<typeof configured>) => void = () => {}): [unknown, unknown] {
  const ctx = configured(); setup(ctx);
  const result = ctx.run('ls_base', { test_now: cosy, overrides }) as unknown as Result;
  const room = ctx.run('ls_room_base', { test_now: cosy, overrides, room: 'studio' }) as unknown as Result;
  return [result.targets['light.studio']!.period, room.targets['room:studio']!.period];
}
const claim = (fields: JsonObject) => ({ kind: 'channels', scope: 'room', target: 'studio', when: claimAt, value: { period: 'day' }, ...fields });
const nextBlockOn = (ctx: ReturnType<typeof configured>) => ctx.put('input_boolean.ls_ovr_next_block_on', 'on');

test("a saved record's when is as_timestamp(when, 0): unreadable text and non-text are 0, never a raise", () => {
  for (const when of ['not a time', '', false, [], {}, null] as JsonValue[]) {
    assert.deepEqual(periods({ c: claim({ when }) }), ['day', 'day'], JSON.stringify(when));
    assert.deepEqual(periods({ 'block:studio': { kind: 'block', target: 'studio', when, value: 'day' } }), ['day', 'day'], JSON.stringify(when));
  }
});

test("a saved record's numeric when is 0, as Home Assistant's as_timestamp reads Unix seconds", () => {
  // With next-block expiry on, a when of 0 is before the last fade start, so
  // the claim has expired; the same instant as date text has not.
  assert.deepEqual(periods({ c: claim({ when: 1792771800 }) }, nextBlockOn), ['cosy', 'cosy']);
  assert.deepEqual(periods({ c: claim({ when: claimAt }) }, nextBlockOn), ['day', 'day']);
});

test("a saved period_updated is Python float() where it reads, else the record's own when", () => {
  // false is float(False) == 0.0, as captured; unreadable values take the
  // named default -- the absent spelling, the record's when -- instead of raising.
  for (const period_updated of [false, 0, 'garbage', null, [], {}] as JsonValue[]) {
    assert.deepEqual(periods({ c: claim({ value: { period: 'day', period_updated } }) }), ['day', 'day'], JSON.stringify(period_updated));
  }
  // Read as the record's when, an unreadable stamp still competes by that when.
  const older = claim({ value: { period: 'night', period_updated: 1 } });
  assert.deepEqual(periods({ a: older, b: claim({ value: { period: 'day', period_updated: 'garbage' } }) }), ['day', 'day']);
});

test('a saved kind is compared as stored: a one-element list is not a period claim', () => {
  assert.deepEqual(periods({ c: claim({ kind: ['channels'] }) }), ['cosy', 'cosy']);
});

test('a saved block value is a block only as text: a one-element list is no override', () => {
  assert.deepEqual(periods({ 'block:studio': { kind: 'block', target: 'studio', when: claimAt, value: ['day'] } }), ['cosy', 'cosy']);
  assert.deepEqual(periods({ 'block:studio': { kind: 'block', target: 'studio', when: claimAt, value: 'DAY' } }), ['day', 'cosy']);
});

test('a saved profile whose JSON is not a mapping reads as no saved profile, never a raise', () => {
  for (const text of ['[]', '5', '"x"', 'null']) {
    assert.deepEqual(periods({}, ctx => ctx.put('input_text.ls_house_cosy', text)), ['cosy', 'cosy'], text);
    assert.deepEqual(periods({}, ctx => ctx.put('input_text.ls_lamp_studio_cosy', text)), ['cosy', 'cosy'], text);
  }
});

test("a saved plug's power the bool filter rejects reads as off, never a raise", () => {
  for (const on of [null, 'maybe', [], {}] as JsonValue[]) {
    const ctx = configured();
    ctx.labels = { on_off: ['switch.plug'] }; ctx.areas['switch.plug'] = 'studio';
    ctx.put('switch.plug', 'on');
    ctx.put('input_text.ls_lamp_plug_cosy', JSON.stringify({ own: true, on }));
    const result = ctx.run('ls_base', { test_now: cosy, overrides: {} }) as unknown as { schedule: { cmds: JsonObject[] } };
    assert.deepEqual(result.schedule.cmds.filter(c => c.kind === 'switch'),
      [{ kind: 'switch', service: 'homeassistant.turn_off', ids: ['switch.plug'] }], JSON.stringify(on));
  }
});
