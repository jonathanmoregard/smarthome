import assert from 'node:assert/strict';
import test from 'node:test';
import { publishCommand, stillCurrent } from '../../src/legacy/domain/transport.ts';
import type { EmitCommand } from '../../src/legacy/domain/transport.ts';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';

/**
 * `effects_emit`'s gate reads (round-4 sweeps). Captured:
 *
 * - `not (state_attr('sensor.ls_overrides','power') or {}).get(area_id(L),true)`:
 *   Jinja `not`, so every falsy saved power value closes the area -- `0`, `''`,
 *   `[]`, `{}` and an explicit none, not only `false`.
 * - `.get(area_id(L), true)` with no area is the default: open.
 * - `generation==state_attr('sensor.ls_effects_runtime','generation')`: Python
 *   `==`, so an absent attribute (none) equals a none generation.
 */
const REVISION = '2026-10-26T11:00:00+00:00';
const runtime = 'sensor.ls_effects_runtime';
const bridge = 'binary_sensor.zigbee2mqtt_bridge_connection_state';
const command: EmitCommand = { body: '{"state":"ON"}', turnsOff: false, owners: ['light.lamp'], members: ['light.bulb'], topic: 'z2m/bulb/set' };
function view(power: JsonValue | undefined, runtimeAttributes: JsonObject = { generation: 'g1' }, areas: Record<string, string> = { 'light.lamp': 'kitchen' }) {
  const attributes: JsonObject = power === undefined ? {} : { power };
  return house({ 'sensor.ls_overrides': { state: '0', attributes, last_updated: REVISION }, [runtime]: ['g', runtimeAttributes],
    [bridge]: 'on', 'light.lamp': 'on', 'light.bulb': 'on' }, { areas });
}
const gate = (generation: string | null = 'g1') => ({ revision: REVISION, generation, current: REVISION, command, effectTargets: {} });

test('every Jinja-falsy saved power value closes the area, not only false', () => {
  for (const value of [false, 0, '', [], {}, null] as JsonValue[]) {
    assert.equal(publishCommand(view({ kitchen: value }), gate()), undefined, JSON.stringify(value));
  }
  for (const value of [true, 1, 'no', [0]] as JsonValue[]) {
    assert.notEqual(publishCommand(view({ kitchen: value }), gate()), undefined, JSON.stringify(value));
  }
});

test("a lamp with no area takes the power default, open, whatever the saved '' key holds", () => {
  assert.notEqual(publishCommand(view({ '': false }, { generation: 'g1' }, {}), gate()), undefined);
});

test('a none generation equals an absent runtime generation', () => {
  assert.notEqual(publishCommand(view(undefined, {}), gate(null)), undefined);
  assert.equal(stillCurrent(view(undefined, {}), 'effects_emit', REVISION, null), true);
});
