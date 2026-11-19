import assert from 'node:assert/strict';
import test from 'node:test';
import { stateStoreHandlers } from '../../src/domain/state-store.ts';
import { context } from './gestures-context.ts';

test('ls_commit power uses the captured Home Assistant bool filter trimming', () => {
  const ctx = context(stateStoreHandlers);
  ctx.run('ls_commit', { data: { op: 'power', area: 'studio', on: ' enable ' } });
  assert.equal(ctx.calls[0]?.data.attributes.power.studio, true);
});

test('ls_commit power rejects values rejected by the captured Home Assistant bool filter', () => {
  const ctx = context(stateStoreHandlers);
  assert.throws(
    () => ctx.run('ls_commit', { data: { op: 'power', area: 'studio', on: 'hot' } }),
    /ls_commit\.data\.on/,
  );
});

test('ls_store profile booleans use the captured Home Assistant bool filter', () => {
  const ctx = context({ ...stateStoreHandlers, effects_catalog: () => ({ effects: {} }) });
  ctx.put('input_text.profile', '{}');
  assert.throws(() => ctx.run('ls_store', { store: 'input_text.profile', own: 'hot' }), /ls_store\.own/);
});

test('ls_commit rejects unhashable record keys on the shared affected-room lookup', () => {
  const ctx = context(stateStoreHandlers);
  assert.throws(
    () => ctx.run('ls_commit', { data: { op: 'clear_all', records: [{ key: [] }] } }),
    /ls_commit\.data\.records\[0\]\.key.*unhashable/,
  );
});

test('ls_override_block rejects unhashable schedule keys', () => {
  const ctx = context({
    ...stateStoreHandlers,
    ls_apply: () => ({ plan: { sched: {} } }),
  });
  assert.throws(
    () => ctx.run('ls_override_block', { scope: [], block: 'night' }),
    /ls_override_block\.scope.*unhashable/,
  );
});

test('ls_override_block raises an unhashable scope only after the ls_apply dry run', () => {
  // The dry-run call is observable (scriptRuns, the parity trace), so the scope
  // parse must not move the raise ahead of it.
  const runs: unknown[] = [];
  const ctx = context({ ...stateStoreHandlers, ls_apply: (_c, args) => { runs.push(args); return { plan: { sched: {} } }; } });
  assert.throws(() => ctx.run('ls_override_block', { scope: { a: 1 }, block: 'night' }), /ls_override_block\.scope.*unhashable/);
  assert.deepEqual(runs, [{ dry_run: true }]);
  assert.deepEqual(ctx.events, []);
});

test('ls_override_block compares only string schedule values and carries scope and via raw', () => {
  const sched = { studio: 5, hall: 'night', '7': 'night' };
  const ctx = context({ ...stateStoreHandlers, ls_apply: () => ({ plan: { sched } }) });
  ctx.run('ls_override_block', { scope: 'studio', block: 'NIGHT', via: 0 });
  ctx.run('ls_override_block', { scope: 'hall', block: 'Night', via: { by: 'x' } });
  ctx.run('ls_override_block', { scope: 7, block: 'night' });
  ctx.run('ls_override_block', { block: 'night', via: null });
  assert.equal(JSON.stringify(ctx.events), JSON.stringify([
    { event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 'studio', value: 'night' }], via: 0 } },
    { event: 'ls_override', data: { op: 'clear', keys: ['block:hall'], via: { by: 'x' } } },
    { event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 7, value: 'night' }], via: 'app' } },
    { event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: null, value: 'night' }], via: null } },
  ]));
});

test('ls_override_block reads the dry-run plan leniently', () => {
  for (const result of [null, [], { plan: 3 }, { plan: { sched: [] } }]) {
    const ctx = context({ ...stateStoreHandlers, ls_apply: () => result });
    ctx.run('ls_override_block', { scope: 'studio', block: 'night' });
    assert.deepEqual(ctx.events, [{ event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 'studio', value: 'night' }], via: 'app' } }],
      `dry-run result ${JSON.stringify(result)}`);
  }
});

test('ls_sara_mode reads the overrides attribute as a mapping only when it is one', () => {
  const run = (overrides: unknown) => {
    const ctx = context(stateStoreHandlers);
    if (overrides !== undefined) ctx.put('sensor.ls_overrides', 'x', { overrides: overrides as never });
    ctx.run('ls_sara_mode', {});
    return (ctx.events[0]?.data as { op: string }).op;
  };
  assert.equal(run(undefined), 'set');
  assert.equal(run(['mode:sara']), 'set');
  assert.equal(run('mode:sara'), 'set');
  assert.equal(run({ 'mode:sara': null }), 'clear');
});

test('ls_clear_overrides defaults only an absent via', () => {
  const ctx = context(stateStoreHandlers);
  ctx.run('ls_clear_overrides', {});
  ctx.run('ls_clear_overrides', { via: false });
  assert.deepEqual(ctx.events.map(e => e.data), [{ op: 'clear_all', via: 'app' }, { op: 'clear_all', via: false }]);
});
