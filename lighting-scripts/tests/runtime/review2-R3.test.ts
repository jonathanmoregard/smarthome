import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// Review 2, R3: effects_assign stops the firmware candle on every lamp target
// leaving it, including a lamp ls_dispatch then skips (not requested, baseline
// `send: false`). The stop ends the candle on the bulbs, so the record that
// the port started it (`bulb_effects`) must not survive the stop: when the
// lamp's target is Candle again, its bulbs must be sent the colour and
// `channel_change` again.

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
const steady: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };

function snapshot(runtime: JsonObject): Snapshot {
  return { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0, ...runtime } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb_1': { state: 'on', attributes: {} },
    'light.bulb_2': { state: 'on', attributes: {} },
  } };
}
const bodies = (calls: ServiceCall[], topic: string) => calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
  .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
const plan = (target: JsonObject, base: JsonObject, planOrder: number) => ({ revision: now, plan_order: planOrder, base,
  resolved: { targets: { 'light.lamp': target }, assignments: target === candle ? { 'light.lamp': target } : {} } });

test('review2 R3: a candle stopped on a lamp dispatch skipped is started again when the lamp returns to Candle', () => {
  const running = { applied: { 'light.lamp': candle }, targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle },
    bulb_effects: { 'light.bulb_1': ['channel_change'], 'light.bulb_2': ['channel_change'] } };
  const left = execute({ script: 'ls_dispatch', args: { plan: plan(steady, { 'light.lamp': { send: false } }, 1), lights: [] },
    snapshot: snapshot(running) }, handlers);
  for (const topic of Object.values(topics)) {
    assert.ok(bodies(left.calls, topic).some(body => body.effect === 'stop_effect'), `precondition: ${topic} was told to stop the candle`);
    assert.equal(bodies(left.calls, topic).some(body => body.brightness === 100), false, `precondition: ${topic} was skipped`);
  }
  const back = execute({ script: 'ls_dispatch', args: { plan: plan(candle, {}, 2), lights: [] }, snapshot: left.snapshot }, handlers);
  for (const topic of Object.values(topics)) {
    assert.deepEqual(bodies(back.calls, topic), [
      { brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 },
      { effect: 'channel_change' },
    ], `${topic} was not restarted after its stop`);
  }
});
