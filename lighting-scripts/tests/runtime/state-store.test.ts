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
