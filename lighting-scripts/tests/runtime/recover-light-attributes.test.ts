import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue, Snapshot } from '../../src/runtime/context.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { reveal } from '../../src/runtime/verbatim.ts';
import { entityProfile, entitySample } from '../../src/parse/schedule.ts';
import { proxyKelvin, proxyShowsRgb } from '../../src/parse/ui-state.ts';
import { storedList, warmEndOf } from '../../src/parse/planning.ts';
import { planWarmEnd } from '../../src/parse/controller.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { WARM_END } from '../../src/legacy/domain/scale.ts';
import { house } from './house-view.ts';

/**
 * Light attributes read back from Home Assistant recover to a default, never
 * raise (2026-11-21, "This goes for all similar where the user can edit"). A
 * person changes these lights from a dashboard; Home Assistant reports what
 * they show. Whatever it reports, the port keeps working.
 */
const lamp = 'light.ls_house_day';
const lit = (attributes: JsonObject) => entityProfile(house({ [lamp]: ['on', attributes] }), lamp);

test('a lit light whose brightness is not a number is no reading, like a light with no level', () => {
  for (const brightness of ['bright', true, [1], { b: 1 }] as JsonValue[]) {
    assert.equal(lit({ brightness }), undefined, JSON.stringify(brightness));
  }
  assert.deepEqual(lit({ brightness: '120' }), { brightness: 120 });
});

test('a colour temperature that is not a number is no colour', () => {
  for (const color_temp_kelvin of ['warm', true, [2700]] as JsonValue[]) {
    assert.deepEqual(lit({ brightness: 120, color_mode: 'color_temp', color_temp_kelvin }), { brightness: 120 },
      JSON.stringify(color_temp_kelvin));
  }
  assert.deepEqual(lit({ brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 2700.6 }),
    { brightness: 120, color: { kelvin: 2700 } });
});

test('an rgb colour that is not three numbers is no colour', () => {
  for (const rgb_color of [5, true, 'abc', [1, 2], [1, 2, 3, 4], ['1', '2', '3'], { r: 1 }] as JsonValue[]) {
    assert.deepEqual(lit({ brightness: 120, color_mode: 'rgb', rgb_color }), { brightness: 120 }, JSON.stringify(rgb_color));
  }
  assert.deepEqual(lit({ brightness: 120, color_mode: 'rgb', rgb_color: [255, 100, 0] }),
    { brightness: 120, color: { rgb: [255, 100, 0] } });
});

test('a scene whose rgb is not three numbers gives a fade no rgb to mix', () => {
  for (const rgb_color of [5, 'abc', [1, 2], ['a', 'b', 'c']] as JsonValue[]) {
    const sample = entitySample(house({ [lamp]: ['on', { brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 2700, rgb_color }] }), lamp);
    assert.deepEqual(sample, { on: true, brightness: 120, color: { kelvin: 2700 }, rgb: undefined }, JSON.stringify(rgb_color));
  }
});

test("a dashboard proxy's colour temperature that is not a number reads as 0, its default", () => {
  assert.equal(proxyKelvin(house({ 'light.proxy': ['on', { color_temp_kelvin: 'warm' }] }), 'light.proxy'), 0);
});

test("a dashboard proxy's rgb that cannot be listed shows no triple", () => {
  for (const rgb_color of [5, true] as JsonValue[]) {
    const view = house({ 'light.proxy': ['on', { rgb_color }] });
    assert.equal(proxyShowsRgb(view, 'light.proxy', { text: '1,2,3', value: carry([1, 2, 3]) }), false, JSON.stringify(rgb_color));
  }
});

test('an rgb that cannot be listed is fingerprinted as reported', () => {
  for (const value of [5, true] as JsonValue[]) assert.deepEqual(reveal(storedList(value)), value, JSON.stringify(value));
  assert.deepEqual(reveal(storedList([1, 2, 3])), [1, 2, 3]);
});

const notATriple: JsonValue[] = [5, true, 'abc', [1, 2], ['a', 'b', 'c'], { r: 1, g: 2, b: 3 }];

test('a warm end that is not an rgb triple is the built-in warm end', () => {
  for (const value of notATriple) {
    assert.deepEqual(planWarmEnd(value), WARM_END, JSON.stringify(value));
    assert.deepEqual(reveal(warmEndOf(value)), WARM_END, JSON.stringify(value));
  }
  assert.deepEqual(reveal(warmEndOf([200, 100, 10])), [200, 100, 10]);
});

const now = '2026-10-26T12:00:00.000Z';
function roomSnapshot(warmEnd: JsonValue): Snapshot {
  return { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio' },
    catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' }, multicast: [], effects: {} },
    state: {
      'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
      'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: warmEnd } },
      'light.lamp': { state: 'on', attributes: {} },
    } };
}

test('ls_room_plan with a warm end that is not an rgb triple sends the built-in warm end', () => {
  for (const value of notATriple) {
    const seen: JsonValue[] = [];
    execute({ script: 'ls_room_plan', args: { room: 'studio' }, snapshot: roomSnapshot(value) }, handlers, {
      beforeScript: (name, args) => {
        if (name === 'effects_gradient_plan' || name === 'effects_resolve') seen.push(args.warm_end ?? 'missing');
      },
    });
    assert.deepEqual(seen, [WARM_END, WARM_END], JSON.stringify(value));
  }
});
