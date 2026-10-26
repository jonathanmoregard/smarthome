import assert from 'node:assert/strict';
import test from 'node:test';
import { context, commandCalls } from './gestures-context.ts';

const modulePath = '../../src/domain/gestures.ts';
const load = async () => {
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.gestureHandlers?.ls_remote_gesture, 'function', 'gesture decoder exists');
  return port.gestureHandlers;
};

test('dynamic remote area, canonical preset, and helper call ordering survive power reset', async () => {
  const handlers = await load();
  const ctx = context(handlers);
  ctx.areas.remote_device = 'studio';
  ctx.put('input_number.ls_new_room_remote_preset', '4');
  const args = { room: 'new_room', device_id: 'remote_device', source: 'remote_ieee' };
  ctx.run('ls_remote_gesture', { ...args, command: 'power' });
  assert.deepEqual(ctx.calls[0], { service: 'input_number.set_value', data: { value: -1 }, target: { entity_id: 'input_number.ls_new_room_remote_preset' } });
  ctx.run('ls_remote_gesture', { ...args, command: 'preset', payload: { action: 'brightness_move_to_level', action_level: 254 } });
  assert.equal(ctx.get('input_number.ls_new_room_remote_preset'), '-1');
  ctx.run('ls_remote_gesture', { ...args, command: 'preset', payload: { action: 'color_temperature_move', action_color_temperature: 200 } });
  ctx.run('ls_remote_gesture', { ...args, command: 'power_done', token: ctx.get('input_text.ls_new_room_remote_power_token') });
  assert.deepEqual(commandCalls(ctx).map(c => [c.command, c.area, c.source]), [['right', 'studio', 'remote_ieee'], ['toggle', 'studio', 'remote_ieee']]);
  assert.equal(ctx.get('input_number.ls_new_room_remote_preset'), '0');
});

test('stale power completion cannot consume a newer burst and expired burst flushes first', async () => {
  const ctx = context(await load());
  const args = { room: 'studio', command: 'power' };
  ctx.run('ls_remote_gesture', args);
  const old = ctx.get('input_text.ls_studio_remote_power_token');
  ctx.now = '2026-10-26T12:00:01+01:00';
  ctx.run('ls_remote_gesture', args);
  ctx.run('ls_remote_gesture', { room: 'studio', command: 'power_done', token: old });
  assert.equal(ctx.get('input_number.ls_studio_remote_power_count'), '1');
  assert.deepEqual(commandCalls(ctx).map(c => c.command), ['toggle']);
  ctx.run('ls_remote_gesture', { room: 'studio', command: 'power_done', token: ctx.get('input_text.ls_studio_remote_power_token') });
  assert.deepEqual(commandCalls(ctx).map(c => c.command), ['toggle', 'toggle']);
});

test('unknown cursor never invents navigation and invalid canonical preset cancels chord', async () => {
  const ctx = context(await load());
  ctx.put('input_number.ls_studio_remote_preset', 'unavailable');
  ctx.put('input_number.ls_studio_remote_chord_step', '1');
  ctx.put('timer.ls_studio_remote_chord', 'active');
  ctx.run('ls_remote_gesture', { room: 'studio', command: 'preset', payload: { action: 'color_temperature_move', action_color_temperature: 200 } });
  assert.deepEqual(commandCalls(ctx), []);
  assert.equal(ctx.get('input_number.ls_studio_remote_preset'), '0');
  assert.equal(ctx.get('timer.ls_studio_remote_chord'), 'idle');
  ctx.run('ls_remote_gesture', { room: 'studio', command: 'preset', payload: { action: 'color_temperature_move', action_color_temperature: true } });
  assert.equal(ctx.get('input_number.ls_studio_remote_preset'), '0');
});
