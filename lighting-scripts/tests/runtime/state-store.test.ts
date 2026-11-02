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
