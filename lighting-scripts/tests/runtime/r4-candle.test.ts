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
/** One ls_dispatch on a snapshot, the lamps it was asked for as `lights`. */
function dispatchOn(state: Snapshot, target: JsonObject, lights: string[] = []) {
  return execute({ script: 'ls_dispatch', args: { plan: planFor(target), lights }, snapshot: state }, handlers);
}
const started = [{ brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 }, { effect: 'channel_change' }];
const publishes = (calls: ServiceCall[]) => calls.filter(call => call.service === 'mqtt.publish');

/** The MQTT bodies one bulb received, in publish order. */
function received(calls: ServiceCall[], topic: string): JsonObject[] {
  return calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
    .map(call => JSON.parse(String(call.data.payload)) as JsonObject);
}


/**
 * Round-4 candle findings. A member whose light row the frame plan rejected
 * (a conflicting row for a bulb two lamps share) got the start without its
 * colour; it now gets neither, and its lamp stays out of `applied`. A member
 * that was off when its lamp was sent is the other case, and stays recorded.
 */

/** A snapshot whose member `bulb` is in `state`. */
function withMember(runtime: JsonObject, bulb: string, state: string): Snapshot {
  const s = snapshot(runtime);
  s.state[bulb] = { state, attributes: {} };
  return s;
}

/** Two lamps sharing `light.bulb_2`: `light.lamp` runs `target`, `light.other` a steady light, so bulb_2's rows conflict. */
function sharedSnapshot(runtime: JsonObject = {}): Snapshot {
  const s = snapshot(runtime);
  s.catalog = { ...catalog, members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'], 'light.other': ['light.bulb_2'] } };
  s.members = ['light.lamp', 'light.other'];
  s.areas = { 'light.lamp': 'room', 'light.other': 'room' };
  s.state['light.other'] = { state: 'on', attributes: {} };
  return s;
}
function sharedDispatch(state: Snapshot, target: JsonObject) {
  const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': target, 'light.other': steady },
    assignments: { 'light.lamp': target } } };
  return execute({ script: 'ls_dispatch', args: { plan, lights: ['light.lamp', 'light.other'] }, snapshot: state }, handlers);
}

test('a member whose light row was rejected gets no start, and its lamp is not recorded as applied', () => {
  const result = sharedDispatch(sharedSnapshot(), candle);
  assert.deepEqual(received(result.calls, topics['light.bulb_1']), started, 'precondition: bulb_1 started');
  assert.deepEqual(received(result.calls, topics['light.bulb_2']), []);
  const applied = result.snapshot.state['sensor.ls_effects_runtime']!.attributes.applied as JsonObject;
  assert.equal(Object.hasOwn(applied, 'light.lamp'), false);
});

test('a rejected row that persists sends its lamp again on each sendable dispatch, never on a steady tick', () => {
  // The cost of not recording a lamp with a rejected member, measured: while
  // the conflict lasts, a dispatch the baseline sends restarts the candle on the
  // members that did get it; a steady tick (baseline send:false) does not.
  const first = sharedDispatch(sharedSnapshot(), candle);
  const plan = { revision: now, plan_order: 2, base: {}, resolved: { targets: { 'light.lamp': candle, 'light.other': steady },
    assignments: { 'light.lamp': candle } } };
  const second = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: first.snapshot }, handlers);
  assert.deepEqual(received(second.calls, topics['light.bulb_1']), started);
  const steadyTick = { ...plan, plan_order: 3, base: { 'light.lamp': { send: false }, 'light.other': { send: false } } };
  const third = execute({ script: 'ls_dispatch', args: { plan: steadyTick, lights: [] }, snapshot: second.snapshot }, handlers);
  assert.deepEqual(received(third.calls, topics['light.bulb_1']), []);
});

test('a lamp sent while a member was unavailable is recorded, so its live members are not restarted', () => {
  // Not recording it would send the lamp, and restart the candle on bulb_1, on
  // every sendable dispatch while bulb_2 stays dead (measured, round 4). Known
  // gap: bulb_2 back on while the lamp stays on waits for the lamp's next send.
  const first = dispatchOn(withMember({}, 'light.bulb_2', 'unavailable'), candle, ['light.lamp']);
  assert.deepEqual(received(first.calls, topics['light.bulb_1']), started, 'precondition: bulb_1 started');
  assert.deepEqual(received(first.calls, topics['light.bulb_2']), [], 'precondition: bulb_2 not reached');
  assert.deepEqual(publishes(dispatchOn(first.snapshot, candle).calls), []);
});
