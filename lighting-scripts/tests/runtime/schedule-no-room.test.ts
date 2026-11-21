import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { isObject } from '../../src/runtime/parse.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { context, setCatalog } from './gestures-context.ts';

/*
 * A lamp the registry places in no room, or in the empty area id, follows the
 * house in `ls_base`: its profile's area is null, it reads the house's
 * scenes even when an `ls__<block>_own_light` helper is on, and it is private
 * exactly when the private-room list names the empty room (the scripts'
 * `area_id(L) or ''` lookup). Characterization for review round 2, item 9
 * (the `?? ''` no-room sentinel in `domain/schedule.ts`): these hold before
 * and after it is replaced.
 */
const cosy = '2026-10-23T19:00:00+02:00';
/** The value at a path through nested mappings; none where the path leaves them. */
function at(value: JsonValue | undefined, ...path: string[]): JsonValue | undefined {
  let current = value;
  for (const key of path) current = isObject(current) ? current[key] : undefined;
  return current;
}

function house(area: string | undefined, labels: Record<string, string[]> | undefined = undefined) {
  const ctx = context({ ...handlers, ...scheduleHandlers });
  ctx.now = cosy;
  ctx.members = ['light.solo'];
  if (area !== undefined) ctx.areas['light.solo'] = area;
  if (labels !== undefined) ctx.labels = labels;
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  // Own-light helpers and scenes spelled for the empty room and for a room named after a missing
  // value: a lamp in no room must read neither.
  for (const text of ['', 'undefined', 'null']) {
    ctx.put(`input_boolean.ls_${text}_cosy_own_light`, 'on');
    ctx.put(`light.ls_${text}_cosy`, 'on', { brightness: 33, color_mode: 'color_temp', color_temp_kelvin: 2100 });
  }
  ctx.put('light.solo', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  setCatalog(ctx, { effects: {}, processors: {} });
  return ctx;
}
const base = (ctx: ReturnType<typeof house>, overrides: JsonObject = {}) =>
  ctx.run('ls_base', { test_now: cosy, overrides });
const dayClaim = { kind: 'channels', scope: 'house', target: 'house', when: '2026-10-23T18:30:00+02:00', value: { period: 'day' } };

for (const [label, area] of [['no area', undefined], ['the empty area id', '']] as const) {
  test(`a lamp in ${label} follows the house: null area, the house scene, not an own-light scene for the empty room`, () => {
    const result = base(house(area));
    assert.equal(at(result, 'schedule', 'profiles', 'light.solo', 'area'), null);
    assert.equal(at(result, 'targets', 'light.solo', 'area'), null);
    assert.equal(at(result, 'targets', 'light.solo', 'brightness'), 90);
  });

  test(`a lamp in ${label} takes a house period claim unless the private list names the empty room`, () => {
    const lamp = ['targets', 'light.solo', 'brightness'];
    assert.equal(at(base(house(area), { claim: dayClaim }), ...lamp), 240);
    assert.equal(at(base(house(area, { private_room: ['studio'] }), { claim: dayClaim }), ...lamp), 240);
    assert.equal(at(base(house(area, { private_room: [''] }), { claim: dayClaim }), ...lamp), 90);
  });
}
