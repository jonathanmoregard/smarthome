import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { controllerHandlers, switchPlan } from '../../src/domain/controller.ts';
import { remoteInputHandlers, remotePlan } from '../../src/domain/remote-input.ts';
import { stateStoreHandlers } from '../../src/domain/state-store.ts';
import { transportHandlers } from '../../src/domain/transport.ts';
import { uiHandlers } from '../../src/domain/ui-state.ts';
import { context, setCatalog, stub } from './gestures-context.ts';

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
    // This test's subject is `ls_commit`'s acknowledgement, not the plan's
    // shape, so the plan is a complete one and the stub gets past its decode.
    ls_remote_plan: () => ({ op: 'set', records: [], via: 'remote',
      input_revision: 'revision', received_at: 0, request_id: 'remote:0' }),
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
    effects_gradient_plan: stub('effects_gradient_plan', () => ({ gradients: {} })),
    effects_resolve: stub('effects_resolve', () => ({ targets: {}, assignments: {} })),
    ls_switch_plan: () => ({ switches: {} }),
    ls_commit: () => ({ accepted: true, revision: 'revision', committed_at: 0 }),
  });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  assert.throws(() => ctx.run('ls_plan', { reason: null }), /ls_plan\.reason.*string/);
  assert.throws(() => ctx.run('ls_apply', { lights: null }), /ls_apply\.lights.*array/);
});

test('controller requires producer-owned plan and remote result fields', () => {
  const ctx = context({
    ...controllerHandlers,
    // Absent `targets` is this assertion's subject. The refusal moved from
    // `plan`'s own `requireObject(baseline, 'targets')` into
    // `decodeScheduledBase` when `ls_base` became typed, hence the label.
    ls_base: () => ({ schedule: { stale_keys: [] } }),
    effects_catalog: () => ({}),
    effects_gradient_plan: stub('effects_gradient_plan', () => ({ gradients: {} })),
    effects_resolve: stub('effects_resolve', () => ({ targets: {}, assignments: {} })),
    ls_switch_plan: () => ({ switches: {} }),
  });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  assert.throws(() => ctx.run('ls_plan', {}), /ls_base\.targets/);

  const remote = context({
    ...controllerHandlers,
    // A realistic power plan missing exactly one field: `targets`. That
    // rejection is this assertion's whole subject, and it moved from
    // `ls_remote_command`'s `requireArray` into `decodeRemotePlan` when the
    // result became typed. The other fields are filled so the decoder reaches
    // it rather than refusing something else first.
    ls_remote_plan: () => ({ op: 'power', area: 'studio', on: true, via: 'remote',
      input_revision: 'revision', received_at: 0, request_id: 'remote:0' }),
    ls_commit: () => ({ accepted: true, revision: 'revision', committed_at: 0 }),
  });
  assert.throws(() => remote.run('ls_remote_command', { source: 'remote', area: 'studio', command: 'toggle' }), /targets.*array/);
});

// The remaining bare-truthiness reads on JsonValue. Each captured site puts the
// value in a Jinja boolean position, where `[]` and `{}` are FALSE and
// JavaScript calls them true -- so `if (x)` is wrong in both directions and the
// directive routes every one through jinjaTruthy.

const UI_ROW = {
  source: 'light.group', proxy: 'light.ep_test', members: ['light.a'], store: '',
  topics: Object.fromEntries(['availability', 'power', 'effect', 'brightness', 'temperature', 'rgb']
    .map(key => [key, `test/${key}`])),
};

function uiContext(targets: JsonObject) {
  const ctx = context({ ...uiHandlers, effects_catalog: inner => inner.rawCatalog() });
  setCatalog(ctx, { ui_rows: [UI_ROW] });
  ctx.areas['light.a'] = 'studio';
  ctx.put('light.group', 'on', { brightness: 20 });
  ctx.put('sensor.ls_effects_runtime', '2', { targets });
  return ctx;
}

const effectPayload = (result: JsonValue): JsonValue | undefined => {
  const messages = (result as JsonObject).messages as JsonObject[];
  return messages.find(message => message.topic === 'test/effect')?.payload;
};

test('UI effect names treat an empty container as no effect, as the captured boolean does', () => {
  // Captured: `claim.get('kind')=='effect' and claim.get('effect')`, and
  // `entry.get('effect') and entry.effect!='Normal light'`. An empty container
  // was truthy here, so it reached String() and became a literal effect name --
  // '[object Object]' for a mapping, the empty string for a list.
  for (const empty of [[], {}] as JsonValue[]) {
    const claim = uiContext({ 'light.a': { brightness: { kind: 'effect', effect: empty } } });
    assert.equal(effectPayload(claim.run('effects_ui_sync', { dry_run: true, force: true })), 'Normal Light',
      `a channel claim whose effect is ${JSON.stringify(empty)} must not become an effect name`);

    const entry = uiContext({ 'light.a': { effect: empty } });
    assert.equal(effectPayload(entry.run('effects_ui_sync', { dry_run: true, force: true })), 'Normal Light',
      `an entry effect of ${JSON.stringify(empty)} must not become an effect name`);
  }
});

function tickContext(on: JsonValue, power: JsonObject) {
  let seen: JsonObject = {};
  const ctx = context({
    ...transportHandlers,
    // engineTick re-reads the catalog itself; the membership gate uses that copy.
    effects_catalog: () => ({ members: { 'light.a': {} } }),
    effects_frame_plan: (_inner, args) => { seen = args.targets as JsonObject;
      return { commands: [], rejected: [], input_count: 0, endpoint_count: 0, command_count: 0 }; },
    effects_emit: () => null,
  });
  ctx.areas['light.a'] = 'studio';
  ctx.put('light.a', 'on');
  ctx.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on');
  ctx.put('sensor.ls_overrides', '0', { power });
  ctx.put('sensor.ls_effects_runtime', '2', { assignments: { 'light.a': { on } }, revision: ctx.now });
  const run = () => {
    ctx.run('effects_engine_tick', { served: {}, admission: 0, catalog: { members: { 'light.a': {} } } });
    return Object.keys(seen);
  };
  return run;
}

test('engine tick admits a target only when the captured boolean says its on is true', () => {
  // Captured: `... and target.on and power.get(area_id(lamp),true)`.
  assert.deepEqual(tickContext(true, {})(), ['light.a'], 'the baseline case must still admit the lamp');
  for (const on of [[], {}, 0, '', null] as JsonValue[]) {
    assert.deepEqual(tickContext(on, {})(), [],
      `an assignment whose on is ${JSON.stringify(on)} is falsy to the captured boolean`);
  }
});

test('engine tick power gate falls back only on an absent area, then tests Jinja truthiness', () => {
  // `power.get(area_id(lamp), true)` defaults on an ABSENT key and then puts the
  // value in a boolean position. `power[area] !== false` got the absent case
  // right by accident but admitted every other falsy value.
  assert.deepEqual(tickContext(true, {})(), ['light.a'], 'an absent area takes the true default');
  for (const value of [false, 0, '', null, [], {}] as JsonValue[]) {
    assert.deepEqual(tickContext(true, { studio: value })(), [],
      `a power value of ${JSON.stringify(value)} is falsy to the captured boolean`);
  }
  assert.deepEqual(tickContext(true, { studio: true })(), ['light.a']);
});

test('ls_commit handled_full comparison uses the captured Jinja or, not JavaScript truthiness', () => {
  // Captured: `unhandled = old != (state_attr(runtime,'handled_full') or none)`.
  // Jinja `or` fires on every falsy value, `[]` and `{}` included, so an empty
  // container becomes none and compares equal to an absent full_version. `|| null`
  // left `[]` as itself, and `undefined !== []` is always true, which marked the
  // last full render unhandled and resurrected its stale light list.
  for (const empty of [[], {}] as JsonValue[]) {
    const ctx = context(stateStoreHandlers);
    ctx.put('sensor.ls_overrides', '0', { full_lights: ['light.stale'] });
    ctx.put('sensor.ls_effects_runtime', '1', { handled_full: empty });
    ctx.run('ls_commit', { data: { op: 'render_request', area: 'studio' } });
    const update = ctx.calls.find(call => call.service === 'variable.update_sensor');
    assert.ok(update, 'ls_commit writes the override sensor');
    assert.deepEqual((update.data.attributes as JsonObject).full_lights, [],
      `a handled_full of ${JSON.stringify(empty)} must compare equal to an absent full_version`);
  }
});
