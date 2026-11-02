import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerHandlers, switchPlan } from '../../src/domain/controller.ts';
import { remotePlan } from '../../src/domain/remote-input.ts';
import { context } from './gestures-context.ts';

test('switch targets accept only a real on boolean', () => {
  const ctx = context();
  ctx.areas['switch.lamp'] = 'studio';
  assert.throws(() => switchPlan(ctx, {
    targets: { 'room:studio': { on: 'yes', level: 128 } },
    ranges: { 'switch.lamp': { profile: 'custom', min: 0, max: 100 } },
    defaults: {},
  }), /must be true or false/);
});

test('remote commit acknowledgement accepts only a real boolean', () => {
  const ctx = context({
    ...controllerHandlers,
    ls_remote_plan: () => ({ op: 'set', input_revision: 'revision' }),
    ls_commit: () => ({ accepted: 'yes' }),
  });
  assert.throws(() => ctx.run('ls_remote_command', { source: 'remote', area: 'studio', command: 'up' }), /must be true or false/);
});

test('persisted remote has_up accepts only a real optional boolean', () => {
  const ctx = context();
  ctx.areas['light.lamp'] = 'studio';
  ctx.put('sensor.ls_overrides', '0', { overrides: {
    'channels:remote': {
      kind: 'input', scope: 'room', target: 'studio', when: ctx.now,
      value: { step_range: { min: -20, max: 20 }, adjustment: { steps: 0, lower: -20, upper: 20, updated: 0, has_up: [] } },
    },
  } });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'down' }), /must be true or false/);
});
