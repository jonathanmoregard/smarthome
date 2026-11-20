import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// Review 2, R5: a Candle dispatch skips a member that is off (no light, no
// start). The record of what the port started (`bulb_effects`) must not claim
// the candle runs on that member: once the member is on, the next dispatch
// sends it the colour and `channel_change`, and leaves the member already
// running the candle alone.

const now = '2026-10-26T12:00:00.000Z';
const topics = { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set', 'light.bulb_2': 'zigbee2mqtt/bulb_2/set' };
const catalog: JsonObject = {
  effects: { Candle: { renderer: 'script.effect_candle_frame', channels: ['brightness', 'color'] } },
  members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'] },
  topics, phases: {}, multicast: [],
};
const effect = (name: string, intensity: number): JsonObject =>
  ({ kind: 'effect', effect: name, instance: `base:light.lamp:${name}`, intensity, updated: 1 });
const candle: JsonObject = { on: true, area: 'room', brightness: effect('Candle', 120), color: effect('Candle', 120) };

function snapshot(bulb2: 'on' | 'off'): Snapshot {
  return { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0 } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb_1': { state: 'on', attributes: {} },
    'light.bulb_2': { state: bulb2, attributes: {} },
  } };
}
const bodies = (calls: ServiceCall[], topic: string) => calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
  .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } } };

test('review2 R5: a member that was off when the candle started gets it once it is on', () => {
  const first = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: snapshot('off') }, handlers);
  assert.deepEqual(bodies(first.calls, topics['light.bulb_1']).at(-1), { effect: 'channel_change' }, 'precondition: bulb_1 started');
  assert.deepEqual(bodies(first.calls, topics['light.bulb_2']), [], 'precondition: bulb_2 (off) was skipped');
  const after = first.snapshot;
  after.state['light.bulb_2'] = { state: 'on', attributes: {} };
  const second = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: after }, handlers);
  assert.deepEqual(bodies(second.calls, topics['light.bulb_2']), [
    { brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 },
    { effect: 'channel_change' },
  ], 'bulb_2 never got the candle');
});
