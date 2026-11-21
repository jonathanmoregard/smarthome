import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';

/**
 * The bulbs run exactly three effects (Candle, Breathe, Colour loop). The
 * frame plan decides what a channel's effect means once, at the parse edge:
 *
 * - one of the three: a bulb effect, sent as its static light (then started);
 * - a name the frame plan's catalog does not list: what the oracle does with
 *   it -- `source.effect in catalog.effects` is false, so the source is sent as
 *   its value (`value | float` for brightness);
 * - a name the catalog lists that the bulbs cannot run: the oracle would call
 *   that effect's software renderer, which the port does not have, so the
 *   parse raises instead of sending it as brightness 1.
 */

const now = '2026-10-26T12:00:00.000Z';
const snapshot: Snapshot = { now, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
  'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
  'light.lamp': { state: 'on', attributes: {} },
  'light.bulb_1': { state: 'on', attributes: {} },
} };
const catalog = (effects: JsonObject | undefined): JsonObject => ({
  ...(effects === undefined ? {} : { effects }),
  members: { 'light.lamp': ['light.bulb_1'] }, topics: { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set' }, multicast: [],
});
const target = (effect: string): JsonObject => ({ on: true, area: 'room',
  brightness: { kind: 'effect', effect, instance: `base:light.lamp:${effect}`, intensity: 120, value: 80, updated: 1 },
  color: { kind: 'constant', value: { kelvin: 2500 } } });
const plan = (effect: string, effects: JsonObject | undefined) => execute({ script: 'effects_frame_plan',
  args: { targets: { 'light.lamp': target(effect) }, catalog: catalog(effects), timestamp: 0 }, snapshot }, handlers).result as JsonObject;
const payloads = (result: JsonObject) => (result.commands as JsonObject[]).map(command => command.payload);

test('a catalog effect the bulbs cannot run fails at parse instead of being sent as brightness', () => {
  assert.throws(() => plan('Pulse', { Pulse: { channels: ['brightness'] } }), {
    name: 'ParseError',
    message: "effects_frame_plan.targets.light.lamp.brightness.effect 'Pulse' is in the catalog but is not an effect the bulbs run (Candle, Breathe, Colour loop)",
  });
});

for (const effects of [{ Candle: { channels: ['brightness', 'color'] } }, undefined]) {
  test(`an effect the catalog does not list is sent as its value, like the oracle (catalog effects ${effects === undefined ? 'absent' : 'present'})`, () => {
    assert.deepEqual(payloads(plan('Missing', effects)), [{ brightness: 80, color_temp: 400, transition: 0.4 }]);
  });
}

test('a bulb effect is sent at its intensity', () => {
  assert.deepEqual(payloads(plan('Breathe', { Breathe: { channels: ['brightness'] } })), [{ brightness: 120, color_temp: 400, transition: 0.4 }]);
});
