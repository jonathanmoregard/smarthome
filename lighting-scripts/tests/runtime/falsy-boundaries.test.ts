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

test('remote command requires its three string inputs instead of inventing empty values', () => {
  const ctx = context({ ...controllerHandlers, ls_remote_plan: (_ctx, args) => args });
  for (const missing of ['source', 'area', 'command']) {
    const args = { source: 'remote', area: 'studio', command: 'up', dry_run: true };
    delete args[missing as keyof typeof args];
    assert.throws(() => ctx.run('ls_remote_command', args), new RegExp(`ls_remote_command\\.${missing}`));
  }
});

test('controller dry_run accepts only a real optional boolean', () => {
  const ctx = context({ ...controllerHandlers, ls_remote_plan: () => ({ op: 'noop' }) });
  assert.throws(() => ctx.run('ls_remote_command', { source: 'remote', area: 'studio', command: 'up', dry_run: [] }), /dry_run.*true or false/);
  assert.throws(() => ctx.run('ls_apply', { dry_run: {} }), /dry_run.*true or false/);
});

test('controller preserves absent-only defaults and rejects explicit nulls', () => {
  const ctx = context({
    ...controllerHandlers,
    ls_base: () => ({ schedule: { stale_keys: [] }, targets: {} }),
    effects_catalog: () => ({}),
    effects_gradient_plan: () => ({ gradients: {} }),
    effects_resolve: () => ({ targets: {} }),
    ls_switch_plan: () => ({ switches: {} }),
    ls_commit: () => ({ accepted: true }),
  });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  assert.throws(() => ctx.run('ls_plan', { reason: null }), /ls_plan\.reason.*string/);
  assert.throws(() => ctx.run('ls_apply', { lights: null }), /ls_apply\.lights.*array/);
});

test('controller requires producer-owned plan and remote result fields', () => {
  const ctx = context({
    ...controllerHandlers,
    ls_base: () => ({ schedule: { stale_keys: [] } }),
    effects_catalog: () => ({}),
    effects_gradient_plan: () => ({ gradients: {} }),
    effects_resolve: () => ({ targets: {} }),
    ls_switch_plan: () => ({ switches: {} }),
  });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  assert.throws(() => ctx.run('ls_plan', {}), /ls_plan\.baseline\.targets/);

  const remote = context({
    ...controllerHandlers,
    ls_remote_plan: () => ({ op: 'power', on: true, input_revision: 'revision' }),
    ls_commit: () => ({ accepted: true }),
  });
  assert.throws(() => remote.run('ls_remote_command', { source: 'remote', area: 'studio', command: 'toggle' }), /targets.*array/);
});
