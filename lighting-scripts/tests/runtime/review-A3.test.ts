import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// Review A3: leaving the firmware candle queues stop commands for every on
// member. A member missing from `catalog.topics` is pushed with `topic: null`
// (transport.ts, assignEffects), effects_emit's strict command parse raises on
// it, and the whole ls_dispatch aborts. The light path (effects_frame_plan ->
// effects_group_plan) rejects the same member's row and carries on; the stop
// path now skips that member's row the same way.

const now = '2026-10-26T12:00:00.000Z';
const catalog: JsonObject = {
  effects: { Candle: { renderer: 'script.effect_candle_frame', channels: ['brightness', 'color'] } },
  members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'] },
  topics: { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set' },
  phases: {}, multicast: [],
};
const effect = (name: string, intensity: number): JsonObject =>
  ({ kind: 'effect', effect: name, instance: `base:light.lamp:${name}`, intensity, updated: 1 });
const candle: JsonObject = { on: true, area: 'room', brightness: effect('Candle', 120), color: effect('Candle', 120) };
const steady: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };

const snapshot: Snapshot = { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
  'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
  'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0, assignments: { 'light.lamp': candle }, targets: { 'light.lamp': candle } } },
  'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
  'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
  'light.lamp': { state: 'on', attributes: {} },
  'light.bulb_1': { state: 'on', attributes: {} },
  'light.bulb_2': { state: 'on', attributes: {} },
} };

test('review A3: leaving the candle with one member lacking a topic still lights the member that has one', () => {
  const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': steady }, assignments: {} } };
  let calls: ServiceCall[] = [];
  assert.doesNotThrow(() => { calls = execute({ script: 'ls_dispatch', args: { plan, lights: ['light.lamp'] }, snapshot }, handlers).calls; });
  const bodies = calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === 'zigbee2mqtt/bulb_1/set')
    .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
  assert.ok(bodies.some(body => body.brightness === 100), 'bulb_1 got its new light');
  assert.ok(bodies.findIndex(body => body.effect === 'stop_effect') !== -1, 'bulb_1, which has a topic, was still told to stop');
  assert.deepEqual(calls.filter(call => call.service === 'mqtt.publish' && typeof call.data.topic !== 'string'), [], 'nothing published without a topic');
});
