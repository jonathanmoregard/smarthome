import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import type { Snapshot } from '../../src/runtime/context.ts';
import { gestureHandlers } from '../../src/domain/gestures.ts';

const initial = (): Snapshot => ({ state: {}, areas: {}, members: [], now: '2026-10-26T12:00:00+01:00' });

test('decisions run on a copy and expose state changes, commands and timers', () => {
  const snapshot = initial();
  const result = execute({ script: 'sample', snapshot, args: {} }, {
    sample(ctx) {
      ctx.put('input_number.cursor', '2');
      ctx.emit('mqtt.publish', { topic: 'test/set', payload: '{}' });
      ctx.fire('changed', { room: 'test' });
      ctx.schedule('sample', {}, 600);
      return { cursor: ctx.get('input_number.cursor') };
    },
  });
  assert.deepEqual(snapshot.state, {});
  assert.deepEqual(result.result, { cursor: '2' });
  assert.equal(result.snapshot.state['input_number.cursor']?.state, '2');
  assert.equal(result.calls.length, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.snapshot.scheduled?.[0]?.due, Date.parse(snapshot.now) + 600);
});

test('unsupported entrypoints fail explicitly instead of using legacy execution', () => {
  assert.throws(() => execute({ script: 'unknown', snapshot: initial(), args: {} }, {}), /Unsupported script: unknown/);
});

test('suffix gesture dispatch supplies room and preserves explicit data', () => {
  const result = execute({ script: 'script.ls_remote_gesture_kitchen', snapshot: initial(), args: { command: 'up' } }, {
    ls_remote_gesture(_ctx, args) { return args; },
  });
  assert.deepEqual(result.result, { command: 'up', room: 'kitchen' });
});

test('delayed power completion retains the configured remote identity', () => {
  const snapshot = initial();
  snapshot.catalog = { remotes: { kitchen: { source: 'remote-a', device_id: 'device-a' } } };
  const quiet = execute({ script: 'ls_remote_power_quiet_kitchen', snapshot, args: { token: snapshot.now } }, gestureHandlers);
  const task = quiet.snapshot.scheduled?.[0];
  assert.ok(task);
  assert.equal(task.args.source, 'remote-a');
  assert.equal(task.args.device_id, 'device-a');
  assert.equal(task.args.room, 'kitchen');
  assert.equal(task.args.command, 'power_done');
});

test('failed operation does not change its input and invalid numeric output is rejected', () => {
  const snapshot = initial();
  assert.throws(() => execute({ script: 'bad', snapshot, args: {} }, { bad(ctx) { ctx.put('x.y', '1'); return { value: Infinity }; } }), /finite/);
  assert.deepEqual(snapshot.state, {});
});
