import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

/**
 * Candle runs on the bulb (custom Innr firmware, Identify TriggerEffect 0x0b,
 * Zigbee2MQTT `effect: channel_change`). The bulb flickers under the level it
 * is at, so the port sends the candle's colour and ceiling first and the
 * trigger second, then leaves the lamp alone; `stop_effect` ends it.
 */

const now = '2026-10-26T12:00:00.000Z';
const topics = { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set', 'light.bulb_2': 'zigbee2mqtt/bulb_2/set' };
const catalog: JsonObject = {
  effects: {
    Candle: { renderer: 'script.effect_candle_frame', channels: ['brightness', 'color'] },
    Breathe: { renderer: 'script.effect_breathe_frame', channels: ['brightness'] },
  },
  members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'] },
  topics,
  phases: {},
  multicast: [],
};

function effect(name: string, intensity: number): JsonObject {
  return { kind: 'effect', effect: name, instance: `base:light.lamp:${name}`, intensity, updated: 1 };
}
const candle: JsonObject = { on: true, area: 'room', brightness: effect('Candle', 120), color: effect('Candle', 120) };
const steady: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };

function snapshot(runtime: JsonObject = {}): Snapshot {
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

function dispatch(target: JsonObject, runtime: JsonObject = {}): ServiceCall[] {
  const assignments = target.brightness !== undefined && (target.brightness as JsonObject).kind === 'effect' ? { 'light.lamp': target } : {};
  const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': target }, assignments } };
  return execute({ script: 'ls_dispatch', args: { plan, lights: ['light.lamp'] }, snapshot: snapshot(runtime) }, handlers).calls;
}

/** The MQTT bodies one bulb received, in publish order. */
function received(calls: ServiceCall[], topic: string): JsonObject[] {
  return calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
    .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
}

test('starting a candle sends each bulb its colour and ceiling, then channel_change', () => {
  const calls = dispatch(candle);
  for (const topic of Object.values(topics)) {
    assert.deepEqual(received(calls, topic), [
      { brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 },
      { effect: 'channel_change' },
    ]);
  }
});

test('the candle colour command never switches the lamp on', () => {
  const bodies = Object.values(topics).flatMap(topic => received(dispatch(candle), topic));
  assert.ok(bodies.length > 0, 'the candle reached the bulbs');
  for (const body of bodies) assert.equal(Object.hasOwn(body, 'state'), false);
});

test('a constant colour claimed over the candle is sent before the trigger', () => {
  const tinted: JsonObject = { ...candle, color: { kind: 'constant', value: { rgb: [255, 105, 180] } } };
  assert.deepEqual(received(dispatch(tinted), topics['light.bulb_1']), [
    { brightness: 120, color: { rgb: '255,105,180' }, transition: 0.4 },
    { effect: 'channel_change' },
  ]);
});

test('leaving the candle sends stop_effect before the new light', () => {
  const calls = dispatch(steady, { assignments: { 'light.lamp': candle }, targets: { 'light.lamp': candle } });
  const bodies = received(calls, topics['light.bulb_1']);
  const stop = bodies.findIndex(body => body.effect === 'stop_effect');
  const light = bodies.findIndex(body => body.brightness === 100);
  assert.notEqual(stop, -1, 'stop_effect was sent');
  assert.ok(stop < light, 'stop_effect precedes the new brightness');
  assert.equal(bodies.some(body => body.effect === 'channel_change'), false);
});
