import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';

test('an already-running animation uses the reloaded runtime topology on its next frame', () => {
  const now = '2026-10-26T12:00:00.000Z';
  const target = { on: true, area: 'room', brightness: { kind: 'constant', value: 150 }, color: { kind: 'constant', value: { rgb: [1, 2, 3] } } };
  const catalog: JsonObject = { effects: {}, members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/new/set' }, multicast: [] };
  const oldCatalog = { ...catalog, topics: { 'light.bulb': 'zigbee2mqtt/old/set' } };
  const snapshot: Snapshot = { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { assignments: { 'light.lamp': target }, revision: now, generation: 'g' } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.lamp': { state: 'on', attributes: {} }, 'light.bulb': { state: 'on', attributes: {} },
  } };
  const result = execute({ script: 'effects_engine_tick', args: { catalog: oldCatalog, served: {}, admission: 0 }, snapshot }, handlers);
  assert.deepEqual(result.calls.filter(call => call.service === 'mqtt.publish').map(call => call.data.topic), ['zigbee2mqtt/new/set']);
});
