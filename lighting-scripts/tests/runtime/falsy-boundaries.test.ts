import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { switchPlan } from '../../src/legacy/domain/controller.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { parseSwitchPlanArgs } from '../../src/parse/controller.ts';
import { remoteInputHandlers, remotePlan } from '../../src/handlers/remote-input.ts';
import { remotePress } from '../../src/parse/remote-input.ts';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { uiHandlers } from '../../src/handlers/ui-state.ts';
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
  assert.throws(() => switchPlan(ctx.areas, parseSwitchPlanArgs({
    targets: { 'room:studio': { on: 'yes', level: 128 } },
    ranges: { 'switch.lamp': { profile: 'custom', min: 0, max: 100 } },
    defaults: {},
  })), /must be true or false/);
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

// Round 4: a saved has_up is the captured Jinja `or` (`a.v.get('has_up',false) or
// command=='up'`), which never raises: `[]` is falsy, so a down press stores False.
test('persisted remote has_up is the captured Jinja or: a falsy stored value yields the press', () => {
  const ctx = context();
  ctx.areas['light.lamp'] = 'studio';
  ctx.put('sensor.ls_overrides', '0', { overrides: {
    'channels:remote': {
      kind: 'input', scope: 'room', target: 'studio', when: ctx.now,
      value: { step_range: { min: -20, max: 20 }, adjustment: { steps: 0, lower: -20, upper: 20, updated: 0, has_up: [] } },
    },
  } });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  const result = remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('down') }) as unknown as { records: { value: JsonObject }[] };
  assert.equal((result.records[0]!.value.adjustment as JsonObject).has_up, false);
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

/**
 * Round 4 (lenient saved-value directive, 2026-11-19): where the captured
 * template raises on a saved number or selection, the port reads it with the
 * template's own absent spelling as the named default. The `next_fs` case stays
 * strict: it is the port's own room plan, not a saved value.
 */
const adjustmentOf = (result: unknown) => ((result as { records: { value: JsonObject }[] }).records[0]!.value.adjustment as JsonObject);
test('remote plan reads saved numbers and the saved selection leniently, with the absent default', async t => {
  await t.test('explicit null remote validity reads as 0: expired, so the context is re-read', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
      remote_valid_until: null,
      remote_timing_revision: 0,
    });
    ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
    // The room plan's next_fs (100) is stamped only when the context was re-read.
    const result = remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('up') }) as unknown as { records: { value: JsonObject }[] };
    assert.equal(result.records[0]!.value.remote_valid_until, 100);
  });

  await t.test('missing adjustment steps read as 0', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { lower: -20, upper: 20, updated: 0 },
    });
    assert.equal(adjustmentOf(remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('left') })).steps, 0);
  });

  await t.test("explicit null selection reads as absent: the room plan's period", () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
      selection: null,
    });
    const result = remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('right') }) as unknown as { records: { value: JsonObject }[] };
    assert.equal(result.records[0]!.value.selection, 'cosy');
  });

  await t.test('explicit null next_fs does not take the zero fallback', () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: -20, upper: 20, updated: 0 },
      remote_valid_until: 0,
      remote_timing_revision: 0,
    }, null);
    ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
    assert.throws(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('up') }), /schedule number.*finite number/);
  });

  await t.test('explicit null update stamps take the three get fallbacks, never a raise', () => {
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
      assert.doesNotThrow(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('up') }), JSON.stringify(item));
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
    assert.doesNotThrow(() => remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('up') }));
  });

  await t.test("a malformed saved bound reads as the step range's end", () => {
    const ctx = remoteContext({
      step_range: { min: -20, max: 20 },
      adjustment: { steps: 0, lower: 'hot', upper: 20, updated: 0 },
    });
    assert.equal(adjustmentOf(remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('left') })).lower, -20);
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
  remotePlan(ctx, { source: 'remote', area: 'studio', command: remotePress('left') });
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
    effects_gradient_plan: stub('effects_gradient_plan', () => ({})),
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
    effects_gradient_plan: stub('effects_gradient_plan', () => ({})),
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
