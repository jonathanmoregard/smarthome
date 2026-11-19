import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';
const modulePath = '../../src/domain/frames.ts';
async function load() {
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.frameHandlers?.effect_breathe_frame, 'function', 'frame renderers exist');
  return context(port.frameHandlers);
}

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

test('frame filters keep Python numeric grammar', async () => {
  const ctx = await load();
  assert.deepEqual(ctx.run('effect_colour_loop_frame', { timestamp: '0x10' }), { rgb: [255, 0, 0], transition: 0.4 });
});
