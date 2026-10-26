import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';
const modulePath = '../../src/domain/frames.ts';
async function load() {
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.frameHandlers?.effect_candle_frame, 'function', 'frame renderers exist');
  return context(port.frameHandlers);
}

test('Candle deterministic lamp phases preserve warm endpoint and clamp brightness', async () => {
  const ctx = await load();
  ctx.put('light.candle_test_rgb_warm_end', 'on', { rgb_color: [255, 110, 4] });
  assert.deepEqual(ctx.run('effect_candle_frame', { timestamp: 100, phase: 'lamp', brightness: 100, transition: 0.2 }), { brightness: 85, rgb: [255, 110, 4], transition: 0.2 });
  assert.deepEqual(ctx.run('effect_candle_frame', { timestamp: 100, phase: 'other', brightness: 100, transition: 0.2 }), { brightness: 91, rgb: [255, 110, 4], transition: 0.2 });
  assert.equal(ctx.run('effect_candle_frame', { timestamp: 100, brightness: 0 }).brightness, 1);
});

test('breathe handles negative time with Python modulo and round-to-even at half levels', async () => {
  const ctx = await load();
  assert.deepEqual(ctx.run('effect_breathe_frame', { timestamp: -3, brightness: 150 }), { brightness: 150, transition: 0.4 });
  assert.deepEqual(ctx.run('effect_breathe_frame', { timestamp: 0, brightness: 150 }), { brightness: 52, transition: 0.4 });
});

test('colour loop preserves sector boundaries and round-to-even channel interpolation', async () => {
  const ctx = await load();
  assert.deepEqual(ctx.run('effect_colour_loop_frame', { timestamp: 2.5 }), { rgb: [255, 128, 0], transition: 0.4 });
  assert.deepEqual(ctx.run('effect_colour_loop_frame', { timestamp: -5 }), { rgb: [255, 0, 255], transition: 0.4 });
  assert.deepEqual(ctx.run('effect_colour_loop_frame', { timestamp: 30 }), { rgb: [255, 0, 0], transition: 0.4 });
});

test('positive subsecond colour-loop samples retain exact half rounding', async () => {
  const ctx = await load();
  assert.deepEqual(ctx.run('effect_colour_loop_frame', { timestamp: 0.00980392156862745 }), { rgb: [255, 0, 0], transition: 0.4 });
});
