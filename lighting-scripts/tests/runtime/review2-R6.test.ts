import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, JsonValue, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// Review 2, R6: `bulb_effects` is a saved value (the port's record of the
// bulb-effect starts it sent). Directive 2026-11-19: a malformed saved value is
// read by a lenient typed parser with a default, never raised on. Garbage
// reads as "nothing recorded": the record is a mapping of bulb to a list of
// start names, and anything else -- the whole value, or one entry -- records
// nothing, so the lamp is (re)started.

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
const plan = (target: JsonObject) => ({ revision: now, plan_order: 1, base: {},
  resolved: { targets: { 'light.lamp': target }, assignments: target === candle ? { 'light.lamp': target } : {} } });

const garbage: Array<[string, JsonValue]> = [
  ['null', null], ['a list', ['channel_change']], ['a string', 'channel_change'], ['a number', 0],
  ['a null entry', { 'light.bulb_1': null, 'light.bulb_2': null }],
  ['a string entry', { 'light.bulb_1': 'channel_change', 'light.bulb_2': 'channel_change' }],
  ['a non-string start', { 'light.bulb_1': [1], 'light.bulb_2': [null] }],
];

for (const [label, recorded] of garbage) {
  test(`review2 R6: bulb_effects holding ${label} reads as nothing recorded, so the candle starts`, () => {
    const runtime = { applied: { 'light.lamp': candle }, targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle },
      bulb_effects: recorded };
    const calls = execute({ script: 'ls_dispatch', args: { plan: plan(candle), lights: [] }, snapshot: snapshot(runtime) }, handlers).calls;
    for (const topic of Object.values(topics)) {
      assert.deepEqual(bodies(calls, topic), [
        { brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 },
        { effect: 'channel_change' },
      ], topic);
    }
  });

  test(`review2 R6: bulb_effects holding ${label} does not abort leaving the candle`, () => {
    const runtime = { applied: { 'light.lamp': candle }, targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle },
      bulb_effects: recorded };
    const calls = execute({ script: 'ls_dispatch', args: { plan: plan(steady), lights: [] }, snapshot: snapshot(runtime) }, handlers).calls;
    for (const topic of Object.values(topics)) {
      assert.ok(bodies(calls, topic).some(body => body.effect === 'stop_effect'), `${topic} stop`);
      assert.ok(bodies(calls, topic).some(body => body.brightness === 100), `${topic} light`);
    }
  });
}
