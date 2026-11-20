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
 * Round-4 candle findings. A bulb two lamps share is rejected with the catalog
 * (a bulb belongs to at most one lamp), so no dispatch sees conflicting rows. A
 * member that was off when its lamp was sent stays recorded.
 */

/** A snapshot whose member `bulb` is in `state`. */
function withMember(runtime: JsonObject, bulb: string, state: string): Snapshot {
  const s = snapshot(runtime);
  s.state[bulb] = { state, attributes: {} };
  return s;
}

/** Two lamps sharing `light.bulb_2`. */
function sharedSnapshot(): Snapshot {
  const s = snapshot({});
  s.catalog = { ...catalog, members: { 'light.lamp': ['light.bulb_1', 'light.bulb_2'], 'light.other': ['light.bulb_2'] } };
  return s;
}

test('a dispatch over a catalog where two lamps share a bulb is refused before anything is sent', () => {
  const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': candle, 'light.other': steady },
    assignments: { 'light.lamp': candle } } };
  assert.throws(() => execute({ script: 'ls_dispatch', args: { plan, lights: ['light.lamp', 'light.other'] }, snapshot: sharedSnapshot() },
    handlers), /light\.bulb_2 belongs to both light\.lamp and light\.other/);
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
