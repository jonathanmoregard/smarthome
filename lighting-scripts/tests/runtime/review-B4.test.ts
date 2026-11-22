import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';

// Review B4: framePlan calls `source.details()` for every channel, and
// `details()` requires `intensity` for any effect source -- matching the
// oracle, which hands `source.intensity` to the renderer for every effect
// channel. So a bulb-effect colour claim with no intensity raises even though
// nothing on the colour channel reads it. The comment in parse/transport.ts
// used to say the opposite; this pins the behaviour the code (and the oracle)
// has.
//
// Exercised with a Candle colour claim (it holds the warm end), the one effect
// the bulbs run.

const now = '2026-10-26T12:00:00.000Z';
const catalog: JsonObject = { members: { 'light.lamp': ['light.bulb_1'] }, topics: { 'light.bulb_1': 'zigbee2mqtt/bulb_1/set' }, multicast: [] };
const snapshot: Snapshot = { now, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
  'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
  'light.lamp': { state: 'on', attributes: {} },
  'light.bulb_1': { state: 'on', attributes: {} },
} };

test('review B4: a bulb-effect colour claim without intensity raises, as the oracle requires intensity on every effect channel', () => {
  const target = { on: true, area: 'room', brightness: { kind: 'constant', value: 100 },
    color: { kind: 'effect', effect: 'Candle', instance: 'base:light.lamp:Candle', updated: 1 } };
  assert.throws(
    () => execute({ script: 'effects_frame_plan', args: { targets: { 'light.lamp': target }, catalog, timestamp: 0 }, snapshot }, handlers),
    { message: 'effects_frame_plan.targets.light.lamp.color.intensity must be a finite number, got undefined' });
});
