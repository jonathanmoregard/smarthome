import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import type { JsonValue } from '../../src/runtime/context.ts';
import { nativeHandlers } from '../../src/handlers/native-controls.ts';

/**
 * `effects_set`'s power command visits `for L in (state_attr('sensor.ls_overrides',
 * 'switch_ranges') or {}) if area_id(L) in scope.areas`: Jinja iteration (a
 * mapping's keys, a list's elements, a string's characters), and nothing else
 * in the script reads the attribute. A value Jinja cannot iterate reads as the
 * `or {}` default (lenient saved-value directive).
 */
const catalog = { groups: { 'light.living': ['light.logical'] }, members: { 'light.logical': ['light.bulb'] }, effects: {} };
const resolved = { level: 110, color: { kind: 'constant', value: { kelvin: 2200 } } };
const base = { brightness: 110, color: { kelvin: 2200 } };
const current = { plan: { base: { 'light.logical': base, 'room:living': base }, resolved: { targets: { 'light.logical': resolved, 'room:living': resolved } } } };
function powerIds(switch_ranges: JsonValue): JsonValue {
  const snapshot = { now: '2026-10-26T12:00:00+01:00', members: [],
    areas: { 'light.logical': 'living', 'light.bulb': 'living', 'switch.plug': 'living' },
    state: { 'sensor.ls_overrides': { state: '0', last_updated: '2026-10-26T11:00:00+00:00', attributes: { switch_ranges } } } };
  const { result } = execute({ script: 'effects_set', snapshot, args: { source: 'light.living', attribute: 'power', value: 'OFF', dry_run: true } },
    { ...nativeHandlers, effects_catalog: () => catalog, ls_plan: () => current });
  return ((result as { commands: { target: { entity_id: JsonValue } }[] }).commands[0]!.target.entity_id);
}

test('the power command iterates saved switch_ranges as Jinja does', () => {
  assert.deepEqual(powerIds({ 'switch.plug': {} }), ['light.logical', 'switch.plug']);
  assert.deepEqual(powerIds(['switch.plug']), ['light.logical', 'switch.plug']);
  assert.deepEqual(powerIds('switch.plug'), ['light.logical']);
  assert.deepEqual(powerIds(5), ['light.logical']);
});
