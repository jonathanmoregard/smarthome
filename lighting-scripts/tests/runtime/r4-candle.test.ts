import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';

/** Round-4 candle finding: a bulb two lamps share is rejected with the catalog (a bulb belongs to at most one lamp). */

const now = '2026-10-26T12:00:00.000Z';
const catalog: JsonObject = {
  effects: { Candle: { renderer: 'script.effect_candle_frame', channels: ['brightness', 'color'] } },
  members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'], 'light.other': ['light.bulb_2'] },
  topics: { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set', 'light.bulb_2': 'zigbee2mqtt/bulb_2/set' },
  phases: {},
  multicast: [],
};

/** Two lamps sharing `light.bulb_2`. */
function sharedSnapshot(): Snapshot {
  return { now, catalog, members: ['light.lamp', 'light.other'], areas: { 'light.lamp': 'room', 'light.other': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb_1': { state: 'on', attributes: {} },
    'light.bulb_2': { state: 'on', attributes: {} },
  } };
}

test('a dispatch over a catalog where two lamps share a bulb is refused before anything is sent', () => {
  assert.throws(() => execute({ script: 'ls_dispatch', args: {}, snapshot: sharedSnapshot() }, handlers),
    /light\.bulb_2 belongs to both light\.lamp and light\.other/);
});
