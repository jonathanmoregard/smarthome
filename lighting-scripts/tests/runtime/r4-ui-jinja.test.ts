import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../src/runtime/context.ts';
import { onOffOnly, proxyShowsRgb, runtimeTargets } from '../../src/parse/ui-state.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { house } from './house-view.ts';

/**
 * effects_ui_sync / ls_range_save reads through Jinja falsy operators, each
 * rendered in Home Assistant 2026.7.4:
 * - `(state_attr(proxy,'rgb_color') or []) | list != rgb | list`
 * - `(state_attr(e,'supported_color_modes') or []) != ['onoff']` (a non-list
 *   simply compares unequal; nothing raises)
 */
const rgb = { text: '1,2,3', value: carry([1, 2, 3]) };
const proxy = (rgb_color: JsonValue) => house({ 'light.proxy': ['on', { color_mode: 'rgb', rgb_color }] });

test("a proxy whose rgb_color is Jinja-falsy does not show the colour, and nothing raises", () => {
  for (const value of [null, [], {}, '', 0, false] as JsonValue[]) assert.equal(proxyShowsRgb(proxy(value), 'light.proxy', rgb), false, JSON.stringify(value));
  assert.equal(proxyShowsRgb(proxy('abc'), 'light.proxy', rgb), false);
  assert.equal(proxyShowsRgb(proxy([1, 2, 3]), 'light.proxy', rgb), true);
});

test('supported_color_modes is on/off only exactly when it equals ["onoff"]; nothing raises', () => {
  const lamp = (modes: JsonValue) => house({ 'light.lamp': ['off', { supported_color_modes: modes }] });
  for (const value of [null, false, 0, '', {}, [], 'onoff', ['onoff', 'brightness'], { onoff: 1 }] as JsonValue[]) {
    assert.equal(onOffOnly(lamp(value), 'light.lamp'), false, JSON.stringify(value));
  }
  assert.equal(onOffOnly(lamp(['onoff']), 'light.lamp'), true);
  assert.equal(onOffOnly(house({ 'light.lamp': ['off', {}] }), 'light.lamp'), false);
});

test('a truthy non-text effect on a runtime target is published as Jinja prints it: True, not true', () => {
  // Break: the effect is read with JavaScript's String(), which prints `true` where the scripts' `fx.names+[effect]` prints `True`.
  const runtime = house({ 'sensor.ls_effects_runtime': ['ok', {
    targets: { 'light.lamp': { effect: true, brightness: { kind: 'effect', effect: true } } },
    assignments: {},
  }] });
  const view = runtimeTargets(runtime).member('light.lamp');
  assert.equal(view.effect, 'True');
  assert.deepEqual(view.claimEffects, ['True']);
});
