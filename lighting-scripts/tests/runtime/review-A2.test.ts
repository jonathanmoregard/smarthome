import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

// Review A2: a lamp whose stored runtime already records its Candle target as
// applied (what the Home Assistant engine left behind at cutover: it wrote
// `applied` after streaming software candle frames) is skipped by ls_dispatch,
// so its bulbs are never told to start the firmware candle. Nothing else
// drives the candle any more: the frame engine that kept it running is gone.
// Directive: starting the firmware candle sends the colour, then
// `effect: channel_change`, and nothing with On or a brightness after it.
//
// The signal: the runtime records, per bulb, the bulb-effect starts the port
// sent after the lamp's light (`bulb_effects`, written with `applied` once
// the output succeeded). A lamp whose target runs a bulb effect the record
// does not show is sent its light and start; an unchanged lamp whose record
// matches is left alone. The assignment transition cannot be the signal: the
// old engine wrote `assignments` as well as `applied`, so at cutover the
// candle is not "entering" anything.

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

const plan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } } };
const bodies = (calls: ServiceCall[], topic: string) => calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === topic)
  .map(call => JSON.parse(String(call.data.payload)) as JsonObject);

test('review A2: a candle already recorded as applied still starts the firmware candle, colour first', () => {
  const runtime = { applied: { 'light.lamp': candle }, targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } };
  const calls: ServiceCall[] = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: snapshot(runtime) }, handlers).calls;
  for (const topic of Object.values(topics)) {
    // Colour (and the candle's level) first, then the trigger, and nothing
    // after it: the firmware ends the candle on On or any brightness command.
    assert.deepEqual(bodies(calls, topic), [
      { brightness: 120, color: { rgb: '255,110,4' }, transition: 0.4 },
      { effect: 'channel_change' },
    ], `${topic} was not started`);
  }
});

test('review A2: an unchanged candle the port started is not restarted on the next dispatch', () => {
  const cutover = { applied: { 'light.lamp': candle }, targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } };
  const first = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: snapshot(cutover) }, handlers);
  assert.ok(bodies(first.calls, topics['light.bulb_1']).length > 0, 'precondition: the first dispatch starts it');
  const second = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: first.snapshot }, handlers);
  for (const topic of Object.values(topics)) assert.deepEqual(bodies(second.calls, topic), [], `${topic} was restarted`);
});

test('review A2: a candle that started from nothing is not restarted on the next dispatch either', () => {
  const first = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: snapshot({}) }, handlers);
  assert.ok(bodies(first.calls, topics['light.bulb_1']).length > 0, 'precondition: the first dispatch starts it');
  const second = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: first.snapshot }, handlers);
  for (const topic of Object.values(topics)) assert.deepEqual(bodies(second.calls, topic), [], `${topic} was restarted`);
});

test('review A2: a lamp that never ran a bulb effect is not resent just because nothing is recorded for it', () => {
  const steady: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
  const steadyPlan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': steady }, assignments: {} } };
  const runtime = { applied: { 'light.lamp': steady }, targets: { 'light.lamp': steady }, assignments: {} };
  const calls = execute({ script: 'ls_dispatch', args: { plan: steadyPlan, lights: [] }, snapshot: snapshot(runtime) }, handlers).calls;
  assert.deepEqual(calls.filter(call => call.service === 'mqtt.publish'), []);
});

for (const delivered of [true, false]) {
  test(`review A2: the host records the start only when the output ${delivered ? 'was delivered' : 'failed'}`, async () => {
    const { LightingHost } = await import('../../src/runtime/host.ts');
    const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
    const cutover = { applied: { 'light.lamp': candle }, targets: { 'light.lamp': candle }, assignments: { 'light.lamp': candle } };
    const host = await LightingHost.open({ path: join(directory, 'state.json'), initial: snapshot(cutover), autoTimers: false,
      now: () => Date.parse(now), program: request => execute(request, handlers),
      transport: { send: async () => { if (!delivered) throw new Error('publish lost'); }, close: async () => {} } });
    try {
      await host.dispatch('ls_dispatch', { plan, lights: [] });
      await host.drain();
      const recorded = host.snapshot().state['sensor.ls_effects_runtime']?.attributes.bulb_effects;
      assert.deepEqual(recorded, delivered ? { 'light.bulb_1': ['channel_change'], 'light.bulb_2': ['channel_change'] } : undefined);
    } finally { await host.close(); }
  });
}

test('review A2: leaving the candle clears its record, so the steady light after it is sent once', () => {
  const steady: JsonObject = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
  const steadyPlan = { revision: now, plan_order: 1, base: {}, resolved: { targets: { 'light.lamp': steady }, assignments: {} } };
  const started = execute({ script: 'ls_dispatch', args: { plan, lights: [] }, snapshot: snapshot({}) }, handlers);
  const left = execute({ script: 'ls_dispatch', args: { plan: steadyPlan, lights: [] }, snapshot: started.snapshot }, handlers);
  assert.ok(bodies(left.calls, topics['light.bulb_1']).some(body => body.brightness === 100), 'precondition: the steady light is sent');
  const again = execute({ script: 'ls_dispatch', args: { plan: steadyPlan, lights: [] }, snapshot: left.snapshot }, handlers);
  for (const topic of Object.values(topics)) assert.deepEqual(bodies(again.calls, topic), [], `${topic} was resent`);
});
