import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// The firmware ends the candle when a bulb is switched off. `bulb_effects`
// records the starts the port sent, per bulb; a bulb that is not on at a
// dispatch runs none of them, so that dispatch drops its entry even when it
// sends nothing. Once the bulb is on again, the next dispatch that keeps its
// lamp on Candle sends it the colour and then `channel_change`. A bulb that
// stays on keeps its entry, so a steady candle is not restarted.

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
const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } } };
const started = [{ brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 }, { effect: 'channel_change' }];

function initial(): Snapshot {
  return { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0 } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb_1': { state: 'on', attributes: {} },
    'light.bulb_2': { state: 'on', attributes: {} },
  } };
}
const bodies = (calls: ServiceCall[], topic: string) => calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
  .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
const dispatch = (snapshot: Snapshot) => execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot }, handlers);
const switched = (snapshot: Snapshot, states: Record<string, 'on' | 'off'>): Snapshot => {
  const next = structuredClone(snapshot);
  for (const [entity, state] of Object.entries(states)) next.state[entity] = { state, attributes: {} };
  return next;
};
const recorded = (snapshot: Snapshot) => snapshot.state['sensor.ls_effects_runtime']!.attributes.bulb_effects;

test('a bulb switched off while its lamp keeps Candle is started again once it is on', () => {
  const first = dispatch(initial());
  for (const topic of Object.values(topics)) assert.deepEqual(bodies(first.calls, topic), started, `precondition: ${topic} started`);

  const dark = dispatch(switched(first.snapshot, { 'light.bulb_2': 'off' }));
  assert.deepEqual(bodies(dark.calls, topics['light.bulb_1']), [], 'bulb_1 runs the candle steadily and is left alone');
  assert.deepEqual(recorded(dark.snapshot), { 'light.bulb_1': ['channel_change'] }, 'the dark bulb is dropped from the record');

  const back = dispatch(switched(dark.snapshot, { 'light.bulb_2': 'on' }));
  assert.deepEqual(bodies(back.calls, topics['light.bulb_2']), started, 'bulb_2 never got the candle back');

  const steady = dispatch(back.snapshot);
  assert.deepEqual(steady.calls.filter(call => call.service === 'mqtt.publish'), [], 'a steady candle is restarted');
});

test('a whole lamp switched off and on again, not requested, gets the candle again', () => {
  const first = dispatch(initial());
  const dark = dispatch(switched(first.snapshot, { 'light.lamp': 'off', 'light.bulb_1': 'off', 'light.bulb_2': 'off' }));
  assert.deepEqual(dark.calls.filter(call => call.service === 'mqtt.publish'), [], 'precondition: an off lamp is not sent');
  assert.deepEqual(recorded(dark.snapshot), {});
  const back = dispatch(switched(dark.snapshot, { 'light.lamp': 'on', 'light.bulb_1': 'on', 'light.bulb_2': 'on' }));
  for (const topic of Object.values(topics)) assert.deepEqual(bodies(back.calls, topic), started, topic);
});

test('a dispatch with every recorded bulb on writes no record', () => {
  const first = dispatch(initial());
  const steady = dispatch(first.snapshot);
  const writes = steady.calls.filter(call => call.service === 'variable.update_sensor'
    && Object.hasOwn((call.data.attributes ?? {}) as JsonObject, 'bulb_effects'));
  assert.deepEqual(writes, []);
});
