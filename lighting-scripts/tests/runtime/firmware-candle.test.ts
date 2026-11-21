import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { LightingHost } from '../../src/runtime/host.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

/**
 * Candle runs on the bulb (custom Innr firmware, Identify TriggerEffect 0x0b,
 * Zigbee2MQTT `effect: channel_change`). The bulb flickers under the level it
 * is at, so the port sends the candle's colour and ceiling first and the
 * trigger second, then leaves the lamp alone; `stop_effect` ends it.
 *
 * There is no record of what the bulbs run beside `applied`: the start goes
 * out whenever ls_dispatch sends the lamp (its target differs from `applied`,
 * it was requested, it was switched back on), and a lamp it does not send is
 * not touched. Recovery is `applied`'s: a dispatch whose output failed does
 * not advance it, so the next dispatch sends the lamp, start included.
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

function planFor(target: JsonObject): JsonObject {
  const assignments = target.brightness !== undefined && (target.brightness as JsonObject).kind === 'effect' ? { 'light.lamp': target } : {};
  return { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': target }, assignments } };
}
function dispatch(target: JsonObject, runtime: JsonObject = {}): ServiceCall[] {
  return execute({ script: 'ls_dispatch', args: { plan: planFor(target), lights: ['light.lamp'] }, snapshot: snapshot(runtime) }, handlers).calls;
}
/** One ls_dispatch on a snapshot, the lamps it was asked for as `lights`. */
function dispatchOn(state: Snapshot, target: JsonObject, lights: string[] = []) {
  return execute({ script: 'ls_dispatch', args: { plan: planFor(target), lights }, snapshot: state }, handlers);
}
/** A runtime whose lamp was last sent (and assigned) `target`. */
function holding(target: JsonObject): JsonObject {
  const assigned = (target.brightness as JsonObject).kind === 'effect';
  return { applied: { 'light.lamp': target }, targets: { 'light.lamp': target }, assignments: assigned ? { 'light.lamp': target } : {} };
}
/**
 * One ls_dispatch through the host, whose transport loses every publish
 * `lost` picks: the host then records nothing that waits on output success.
 */
async function hostedDispatch(state: Snapshot, target: JsonObject, lost: (body: JsonObject) => boolean, lights: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'firmware-candle-'));
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial: state, autoTimers: false,
    now: () => Date.parse(now), program: request => execute(request, handlers), transport: {
      send: async call => {
        if (call.service === 'mqtt.publish' && lost(JSON.parse(String(call.data.payload)) as JsonObject)) throw new Error('publish lost');
      },
      close: async () => {},
    } });
  try {
    await host.dispatch('ls_dispatch', { plan: planFor(target), lights });
    await host.drain();
    return host.snapshot();
  } finally { await host.close(); }
}
const started = [{ brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 }, { effect: 'channel_change' }];
const publishes = (calls: ServiceCall[]) => calls.filter(call => call.service === 'mqtt.publish');

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

const leftCandle = [{ effect: 'stop_colorloop' }, { effect: 'stop_effect' }, { brightness: 100, color_temp: 400, transition: 3 }];

test('leaving the candle sends each bulb the stops, then the new light, and nothing else', () => {
  const calls = dispatch(steady, { assignments: { 'light.lamp': candle }, targets: { 'light.lamp': candle } });
  for (const topic of Object.values(topics)) assert.deepEqual(received(calls, topic), leftCandle, topic);
});

test('a candle lamp whose applied light is already its target is not touched', () => {
  // The cutover case too: the old engine wrote `applied` equal to the Candle
  // target, so such a lamp is not sent until `applied` is cleared (README, cutover).
  const result = dispatchOn(snapshot(holding(candle)), candle);
  assert.deepEqual(publishes(result.calls), []);
});

test('a candle started from nothing is not restarted by the next dispatch', () => {
  const first = dispatchOn(snapshot({}), candle);
  for (const topic of Object.values(topics)) assert.deepEqual(received(first.calls, topic), started, `precondition: ${topic} started`);
  assert.deepEqual(publishes(dispatchOn(first.snapshot, candle).calls), []);
});

test('no dispatch writes anything beside applied to record a start', () => {
  const first = dispatchOn(snapshot({}), candle);
  const runtime = first.snapshot.state['sensor.ls_effects_runtime']!.attributes;
  assert.deepEqual(Object.keys(runtime).sort(), ['applied', 'assignments', 'generation', 'plan_order', 'revision', 'targets']);
});

test('leaving the candle, then the steady light is sent once', () => {
  const left = dispatchOn(dispatchOn(snapshot({}), candle).snapshot, steady);
  for (const topic of Object.values(topics)) assert.deepEqual(received(left.calls, topic), leftCandle, `precondition: ${topic}`);
  assert.deepEqual(publishes(dispatchOn(left.snapshot, steady).calls), []);
});

test('recovery (a): a start the transport lost leaves the lamp out of applied, so the next dispatch sends light then start', async () => {
  const after = await hostedDispatch(snapshot(holding(steady)), candle, body => body.effect === 'channel_change');
  // effects_assign took the lamp out before any light went out; the lost
  // output keeps that, not the pre-dispatch `steady` entry.
  assert.deepEqual(after.state['sensor.ls_effects_runtime']!.attributes.applied, {});
  const next = dispatchOn(after, candle);
  for (const topic of Object.values(topics)) assert.deepEqual(received(next.calls, topic), started, topic);
});

test('recovery (a): a start the host delivered advances applied, so the next dispatch sends nothing', async () => {
  const after = await hostedDispatch(snapshot(holding(steady)), candle, () => false);
  assert.deepEqual(after.state['sensor.ls_effects_runtime']!.attributes.applied, { 'light.lamp': candle });
  assert.deepEqual(publishes(dispatchOn(after, candle).calls), []);
});

test('recovery (c): a candle lamp switched back on (lamp_on asks for it) gets its colour, then the start', () => {
  const state = snapshot(holding(candle));
  const result = dispatchOn(state, candle, ['light.lamp']);
  for (const topic of Object.values(topics)) assert.deepEqual(received(result.calls, topic), started, topic);
});

test('recovery (b), in the engine: effects_assign takes the lamp it sends out of applied before any light goes out', () => {
  const calls = dispatchOn(snapshot(holding(candle)), steady).calls;
  const store = calls.find(call => call.service === 'variable.update_sensor');
  assert.ok(store !== undefined, 'effects_assign stores the runtime');
  assert.deepEqual((store.data.attributes as JsonObject).applied, {});
  assert.ok(calls.indexOf(store) < calls.findIndex(call => call.service === 'mqtt.publish'));
});

// Through the host: a lost output keeps what effects_assign wrote to `applied`
// in the same transaction (the lamp taken out), not the pre-dispatch entry.
test('recovery (b) through the host: a stop delivered, then the batch lost, the next Candle dispatch sends light then start', async () => {
  const after = await hostedDispatch(snapshot(holding(candle)), steady, body => body.brightness === 100);
  const next = dispatchOn(after, candle);
  for (const topic of Object.values(topics)) assert.deepEqual(received(next.calls, topic), started, topic);
});

test('recovery (a) through the host, requested lamp: light delivered, start lost, on a lamp already applied as candle', async () => {
  const after = await hostedDispatch(snapshot(holding(candle)), candle, body => body.effect === 'channel_change', ['light.lamp']);
  const next = dispatchOn(after, candle);
  for (const topic of Object.values(topics)) assert.deepEqual(received(next.calls, topic), started, topic);
});

test('an ordinary light lost in transit leaves the lamp out of applied, so going back to the old light sends it', async () => {
  const brighter: JsonObject = { ...steady, brightness: { kind: 'constant', value: 150 } };
  const after = await hostedDispatch(snapshot(holding(steady)), brighter, body => body.brightness === 150);
  assert.deepEqual(after.state['sensor.ls_effects_runtime']!.attributes.applied, {});
  const back = dispatchOn(after, steady);
  for (const topic of Object.values(topics)) {
    assert.deepEqual(received(back.calls, topic), [{ brightness: 100, color_temp: 400, transition: 3 }], topic);
  }
});

// effects_assign stops every lamp leaving a bulb effect, including one
// ls_dispatch then skips (baseline `send: false`). A stopped lamp is taken out
// of `applied` too, so it is not left recorded as running the candle.
test('a candle stopped on a lamp ls_dispatch skipped is started again when the lamp returns to Candle (was review2 R3)', () => {
  const skipped = { revision: now, plan_order: 1, base: { 'light.lamp': { send: false } },
    resolved: { targets: { 'light.lamp': steady }, assignments: {} } };
  const left = execute({ script: 'ls_dispatch', args: { plan: skipped, lights: [] }, snapshot: snapshot(holding(candle)) }, handlers);
  for (const topic of Object.values(topics)) {
    assert.deepEqual(received(left.calls, topic), [{ effect: 'stop_colorloop' }, { effect: 'stop_effect' }], `precondition: ${topic}`);
  }
  const back = { revision: now, plan_order: 2, base: {}, resolved: { targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } } };
  const again = execute({ script: 'ls_dispatch', args: { plan: back, lights: [] }, snapshot: left.snapshot }, handlers);
  for (const topic of Object.values(topics)) assert.deepEqual(received(again.calls, topic), started, topic);
});
