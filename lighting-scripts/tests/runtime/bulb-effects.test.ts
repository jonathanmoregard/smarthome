import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { ExecutionResult } from '../../src/runtime/engine.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

/**
 * Breathe and Colour loop are the bulbs' own Zigbee effects (Zigbee2MQTT
 * `effect: breathe` and `effect: colorloop`). The port sends each bulb its
 * light once, then the effect once, and streams nothing: there are no frames
 * and no engine. Leaving the effect sends `stop_colorloop` and `stop_effect`
 * before the new light, the same stop path Candle uses.
 */

const now = '2026-10-26T12:00:00.000Z';
const topics = { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set', 'light.bulb_2': 'zigbee2mqtt/bulb_2/set' };
// The deployed catalog still names a renderer per effect; nothing may need it.
const catalog: JsonObject = {
  effects: {
    Candle: { renderer: 'script.effect_candle_frame', channels: ['brightness', 'color'] },
    Breathe: { renderer: 'script.effect_breathe_frame', channels: ['brightness'] },
    'Colour loop': { renderer: 'script.effect_colour_loop_frame', channels: ['color'] },
  },
  members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'] },
  topics,
  phases: {},
  multicast: [],
};

function effect(name: string, intensity: number): JsonObject {
  return { kind: 'effect', effect: name, instance: `base:light.lamp:${name}`, intensity, updated: 1 };
}
const warm = { kind: 'constant', value: { kelvin: 2500 } };
const breathe: JsonObject = { on: true, area: 'room', brightness: effect('Breathe', 90), color: warm };
const loop: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: effect('Colour loop', 100) };
const steady: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: warm };

function snapshot(runtime: JsonObject = {}): Snapshot {
  return { now, catalog, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
    'sensor.ls_effects_runtime': { state: '0', attributes: { revision: now, generation: 'g', plan_order: 0, ...runtime } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.lamp': { state: 'on', attributes: {} },
    'light.bulb_1': { state: 'on', attributes: {} },
    'light.bulb_2': { state: 'on', attributes: {} },
  } };
}

function isEffect(source: unknown): boolean {
  return typeof source === 'object' && source !== null && (source as JsonObject).kind === 'effect';
}

function dispatch(target: JsonObject, runtime: JsonObject = {}, lights: string[] = ['light.lamp']): ExecutionResult {
  const assignments = isEffect(target.brightness) || isEffect(target.color) ? { 'light.lamp': target } : {};
  const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': target }, assignments } };
  return execute({ script: 'ls_dispatch', args: { plan, lights }, snapshot: snapshot(runtime) }, handlers);
}

/** The MQTT bodies one bulb received, in publish order. */
function received(calls: ServiceCall[], topic: string): JsonObject[] {
  return calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
    .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
}

test('starting Breathe sends each bulb its colour and level, then breathe once', () => {
  const { calls } = dispatch(breathe);
  for (const topic of Object.values(topics)) {
    assert.deepEqual(received(calls, topic), [
      { brightness: 90, color_temp: 400, transition: 0.4 },
      { effect: 'breathe' },
    ]);
  }
});

test('starting Colour loop sends each bulb its level, then colorloop once', () => {
  // The loop owns the colour from the trigger on, so no colour precedes it.
  const { calls } = dispatch(loop);
  for (const topic of Object.values(topics)) {
    assert.deepEqual(received(calls, topic), [
      { brightness: 100, transition: 0.4 },
      { effect: 'colorloop' },
    ]);
  }
});

test('Breathe on brightness and Colour loop on colour start in channel order', () => {
  const both: JsonObject = { ...breathe, color: effect('Colour loop', 90) };
  assert.deepEqual(received(dispatch(both).calls, topics['light.bulb_1']), [
    { brightness: 90, transition: 0.4 },
    { effect: 'breathe' },
    { effect: 'colorloop' },
  ]);
});

test('no Breathe or Colour loop command switches the lamp on', () => {
  const bodies = [breathe, loop].flatMap(target => Object.values(topics).flatMap(topic => received(dispatch(target).calls, topic)));
  assert.ok(bodies.length > 0, 'the effects reached the bulbs');
  for (const body of bodies) assert.equal(Object.hasOwn(body, 'state'), false);
});

for (const [name, running] of [['Breathe', breathe], ['Colour loop', loop]] as const) {
  test(`leaving ${name} sends stop_colorloop and stop_effect before the new light`, () => {
    const { calls } = dispatch(steady, { assignments: { 'light.lamp': running }, targets: { 'light.lamp': running } });
    const bodies = received(calls, topics['light.bulb_1']);
    assert.deepEqual(bodies.slice(0, 2), [{ effect: 'stop_colorloop' }, { effect: 'stop_effect' }]);
    assert.deepEqual(bodies.slice(2), [{ brightness: 100, color_temp: 400, transition: 3 }]);
  });
}

test('an unchanged running effect is not started again', () => {
  // `bulb_effects` is the port's record that it started the effect; without it
  // the lamp reads as never started (the cutover case, review-A2.test.ts).
  const runtime = { assignments: { 'light.lamp': breathe }, targets: { 'light.lamp': breathe }, applied: { 'light.lamp': breathe },
    bulb_effects: { 'light.lamp': ['breathe'] } };
  const { calls } = dispatch(breathe, runtime, []);
  assert.deepEqual(calls.filter(call => call.service === 'mqtt.publish'), []);
});

test('no effect ever schedules an engine tick or runs an engine script', () => {
  const candle: JsonObject = { on: true, area: 'room', brightness: effect('Candle', 120), color: effect('Candle', 120) };
  for (const target of [breathe, loop, candle]) {
    const result = dispatch(target);
    assert.deepEqual(result.snapshot.scheduled ?? [], []);
    assert.deepEqual(result.calls.filter(call => call.service.startsWith('script.')), []);
  }
});
