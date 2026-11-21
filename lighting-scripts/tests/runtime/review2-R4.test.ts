import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, JsonValue, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// Review 2, R4: the candle's colour is the candle test lamp's warm end. The
// oracle (`effect_candle_frame`) reads it as
// `state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0]`:
// Jinja's `or`, so Home Assistant's null (no colour), or any other falsy value,
// takes the default. A full Candle dispatch must not abort after the
// assignment because the attribute is null.

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

function snapshot(warmEnd: JsonValue | undefined): Snapshot {
  return { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0 } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.candle_test_rgb_warm_end': { state: 'on', attributes: warmEnd === undefined ? {} : { rgb_color: warmEnd } },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb_1': { state: 'on', attributes: {} },
    'light.bulb_2': { state: 'on', attributes: {} },
  } };
}
const bodies = (calls: ServiceCall[], topic: string) => calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
  .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } } };

for (const [label, warmEnd] of [['null', null], ['absent', undefined], ['[]', []], ['{}', {}], ['0', 0], ['""', '']] as const) {
  test(`review2 R4: a ${label} warm end takes the default 255,126,0 and the candle still starts`, () => {
    const calls = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: snapshot(warmEnd) }, handlers).calls;
    for (const topic of Object.values(topics)) {
      assert.deepEqual(bodies(calls, topic), [
        { brightness: 120, color: { rgb: '255,126,0' }, transition: 0.4 },
        { effect: 'channel_change' },
      ], topic);
    }
  });
}
