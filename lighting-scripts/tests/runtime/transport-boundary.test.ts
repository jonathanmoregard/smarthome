import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';

/**
 * Boundary characterization for the transport handlers: values they carry
 * through to compared bytes, and the exact leniency of the runtime reads.
 */
const now = '2026-10-26T12:00:00.000Z';
const catalog: JsonObject = {
  effects: {}, members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' }, multicast: [],
};
function snapshot(runtime: JsonObject = {}): Snapshot {
  return { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0, ...runtime } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb': { state: 'on', attributes: {} },
  } };
}
const steady: JsonObject = { on: true, brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };

test('filtered commands keep every key in place, ids replaced where they stood', () => {
  const { result } = execute({ script: 'effects_filter_commands', snapshot: snapshot(), args: { commands: [
    { qos: 1, ids: ['light.lamp', 'light.lamp'], extra: { nested: [1] } },
  ] } }, handlers);
  assert.equal(JSON.stringify(result), '{"commands":[{"qos":1,"ids":["light.lamp"],"extra":{"nested":[1]}}]}');
});

test('a stored applied map that is present but not a mapping is empty, not the old targets', () => {
  // `applied == null ? old targets : object(applied)`: only null/absent falls back.
  const { calls } = execute({ script: 'effects_assign', snapshot: snapshot({ applied: [], targets: { 'light.old': steady } }),
    args: { revision: now, targets: { 'light.lamp': steady }, assignments: {} } }, handlers);
  const update = calls.find(call => call.service === 'variable.update_sensor');
  assert.deepEqual((update?.data.attributes as JsonObject).applied, {});
});

test('a stale assignment answers the runtime generation exactly as stored', () => {
  const { result } = execute({ script: 'effects_assign', snapshot: snapshot({ generation: { epoch: 7 } }),
    args: { revision: 'stale', targets: {}, assignments: {} } }, handlers);
  assert.deepEqual(result, { generation: { epoch: 7 } });
});

test('a frame target with no area is capped when the transition rooms list null', () => {
  // `transition_rooms.includes(area ?? null)`: an absent area is looked up as null.
  const { result } = execute({ script: 'effects_frame_plan', snapshot: snapshot(), args: {
    catalog, targets: { 'light.lamp': { ...steady, transition: 3 } }, transition_cap: 0.1, transition_rooms: [null],
  } }, handlers);
  assert.match(JSON.stringify(result), /"transition":0\.1\b/);
});
