import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../src/adapter/ha-client.ts';
import { onOffOnly, proxyKelvin, proxyShowsRgb } from '../../src/adapter/codecs/ui-state.ts';
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

// Light attributes read back from Home Assistant recover to a default, never raise (2026-11-21).

test("a dashboard proxy's colour temperature that is not a number reads as 0, its default", () => {
  assert.equal(proxyKelvin(house({ 'light.proxy': ['on', { color_temp_kelvin: 'warm' }] }), 'light.proxy'), 0);
});

test("a dashboard proxy's rgb that cannot be listed shows no triple", () => {
  for (const rgb_color of [5, true] as JsonValue[]) {
    const view = house({ 'light.proxy': ['on', { rgb_color }] });
    assert.equal(proxyShowsRgb(view, 'light.proxy', { text: '1,2,3', value: carry([1, 2, 3]) }), false, JSON.stringify(rgb_color));
  }
});
