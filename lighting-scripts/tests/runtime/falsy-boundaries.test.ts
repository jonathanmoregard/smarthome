import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { controllerHandlers, switchPlan } from '../../src/domain/controller.ts';
import { remoteInputHandlers, remotePlan } from '../../src/domain/remote-input.ts';
import { context } from './gestures-context.ts';

function remoteContext(value: JsonObject, nextFs: JsonObject['value'] = 100) {
  const ctx = context({
    ls_room_plan: () => ({ plan: {
      stale_keys: [],
      resolved: { targets: { 'room:studio': { period: 'day' } } },
      schedule_details: { studio: { next_fs: nextFs } },
    } }),
    effects_catalog: () => ({ effects: {}, members: {} }),
  });
  ctx.areas['light.lamp'] = 'studio';
  ctx.put('sensor.ls_overrides', '0', { overrides: {
    'channels:remote': { kind: 'input', scope: 'room', target: 'studio', when: ctx.now, value },
  } });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  return ctx;
}

test('switch targets accept only a real on boolean', () => {
  const ctx = context();
  ctx.areas['switch.lamp'] = 'studio';
  assert.throws(() => switchPlan(ctx, {
    targets: { 'room:studio': { on: 'yes', level: 128 } },
    ranges: { 'switch.lamp': { profile: 'custom', min: 0, max: 100 } },
    defaults: {},
  }), /must be true or false/);
});

test('switch planning rejects malformed top-level mappings', () => {
  const ctx = context(controllerHandlers);
  for (const [field, args] of [
    ['targets', { ranges: {}, defaults: {} }],
    ['ranges', { targets: {}, defaults: {} }],
    ['defaults', { targets: {}, ranges: {} }],
  ] as const) {
    assert.throws(() => ctx.run('ls_switch_plan', args), new RegExp(`ls_switch_plan\\.${field}.*object`));
  }
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

test('remote plan requires its three raw string inputs', () => {
  const ctx = context(remoteInputHandlers);
  for (const missing of ['source', 'area', 'command']) {
    const args = { source: 'remote', area: 'studio', command: 'up' };
    delete args[missing as keyof typeof args];
    assert.throws(() => ctx.run('ls_remote_plan', args), new RegExp(`ls_remote_plan\\.${missing}.*string`));
  }
});

test('remote plan preserves absent-only numeric and selection fallbacks', async t => {
  await t.test('explicit null remote validity does not take the zero fallback', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
      remote_valid_until: null,
      remote_timing_revision: 0,
    });
    ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
    assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'up' }), /schedule number.*finite number/);
  });

  await t.test('raw adjustment steps cannot be missing', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { lower: -20, upper: 20, updated: 0 },
    });
    assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'left' }), /schedule number.*finite number/);
  });

  await t.test('explicit null selection does not take the period fallback', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
      selection: null,
    });
    assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'right' }), /selection.*string/);
  });

  await t.test('explicit null next_fs does not take the zero fallback', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
      remote_valid_until: 0,
      remote_timing_revision: 0,
    }, null);
    ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
    assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'up' }), /schedule number.*finite number/);
  });

  await t.test('explicit null update stamps do not take any of the three get fallbacks', () => {
    const cases = [
      {
        ownUpdated: 0,
        competingValue: { channels: { brightness: { updated: null } } },
      },
      {
        ownUpdated: 0,
        competingValue: { adjustment: { updated: null } },
      },
      {
        ownUpdated: null,
        competingValue: { channels: { brightness: { updated: 1 } } },
      },
    ];
    for (const item of cases) {
      const ctx = remoteContext({
        step_range: { min: -20, max: 20 },
        adjustment: { steps: 0, lower: -20, upper: 20, updated: item.ownUpdated },
      });
      const overrides = ctx.state['sensor.ls_overrides']!.attributes.overrides as JsonObject;
      overrides.other = { kind: 'channels', via: 'app', scope: 'room', target: 'studio', when: ctx.now, value: item.competingValue };
      assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'up' }), /schedule number.*finite number/);
    }
  });

  await t.test('a channel update does not parse its unused adjustment fallback', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
    });
    const overrides = ctx.state['sensor.ls_overrides']!.attributes.overrides as JsonObject;
    overrides.other = {
      kind: 'channels', via: 'app', scope: 'room', target: 'studio', when: ctx.now,
      value: { channels: { brightness: { updated: 1 } }, adjustment: null },
    };
    assert.doesNotThrow(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'up' }));
  });

  await t.test('raw adjustment bounds reject malformed present numbers', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: 'hot', upper: 20, updated: 0 },
    });
    assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: 'left' }), /schedule number.*finite number/);
  });
});

test('remote cache uses the captured Jinja or fallback for empty containers', () => {
  let seenCache: JsonObject['value'];
  const ctx = context({
    ls_room_plan: (_ctx, args) => {
      seenCache = args.cache;
      return { plan: { stale_keys: [], resolved: { targets: {} }, schedule_details: {} } };
    },
    effects_catalog: () => ({ effects: {}, members: {} }),
  });
  ctx.areas['light.lamp'] = 'studio';
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  ctx.put('sensor.ls_cache_studio', '0', { cache: [] });
  remotePlan(ctx, { source: 'remote', area: 'studio', command: 'left' });
  assert.deepEqual(seenCache, {});
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
