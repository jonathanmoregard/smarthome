import assert from 'node:assert/strict';
import test from 'node:test';
import { gestureHandlers } from '../../src/handlers/gestures.ts';
import { context, commandCalls } from './gestures-context.ts';

/**
 * `ls_remote_gesture_*` reads the preset cursor as captured
 * `states('input_number.ls_<room>_remote_preset')|float(-2)`, then tests
 * `index==previous` and `previous in [0,1,2,3,4]`. A fractional cursor is
 * neither equal to an index nor one of the five, so the press cancels; it is
 * not truncated to the neighbouring index.
 */
test('a fractional saved preset cursor is a float: the press cancels instead of navigating', () => {
  const ctx = context(gestureHandlers);
  ctx.areas.remote_device = 'studio';
  ctx.put('input_number.ls_studio_remote_preset', '2.5');
  ctx.run('ls_remote_gesture', { room: 'studio', device_id: 'remote_device', source: 'remote', command: 'preset',
    payload: { action: 'color_temperature_move', action_color_temperature: 454 } });
  assert.deepEqual(commandCalls(ctx), []);
  assert.equal(ctx.get('input_number.ls_studio_remote_preset'), '3');
});

test('an integral saved preset cursor spelled as a float still navigates', () => {
  const ctx = context(gestureHandlers);
  ctx.areas.remote_device = 'studio';
  ctx.put('input_number.ls_studio_remote_preset', '2.0');
  ctx.run('ls_remote_gesture', { room: 'studio', device_id: 'remote_device', source: 'remote', command: 'preset',
    payload: { action: 'color_temperature_move', action_color_temperature: 454 } });
  assert.deepEqual(commandCalls(ctx).map(c => c.command), ['right']);
});
