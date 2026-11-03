import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerHandlers } from '../../src/domain/controller.ts';
import { context, stub } from './gestures-context.ts';

// The captured ls_plan, ls_apply, ls_base and ls_room_base all read test_now
// raw behind a default(...) guard; nothing coerces it to a string. ls_base and
// ls_room_base parse the field with optionalTimestamp, which accepts a numeric
// epoch, and a prior round specifically fixed `test_now: 0` being swallowed as
// absent. A boundary that rejected a number therefore rejected a legal value.
//
// The parity gate cannot observe this: no preserved suite passes a numeric
// test_now to ls_plan or ls_apply, so the over-strict reading stayed green.
// These assertions are the only guard.

function planContext() {
  const ctx = context({
    ...controllerHandlers,
    ls_base: () => ({ schedule: { stale_keys: [] } }),
    effects_catalog: () => ({}),
    effects_gradient_plan: stub('effects_gradient_plan', () => ({ gradients: {} })),
    effects_resolve: stub('effects_resolve', () => ({ targets: {}, assignments: {} })),
    ls_switch_plan: () => ({ switches: {} }),
  });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  return ctx;
}

test('ls_plan accepts a numeric epoch test_now, including zero', () => {
  // Each call still fails downstream on the producer-owned baseline, which is
  // the point: the failure must come from there and never from test_now.
  for (const value of [0, 1762000000, 1762000000.5]) {
    assert.throws(() => planContext().run('ls_plan', { test_now: value }),
      /ls_plan\.baseline\.targets/, `numeric test_now ${value} must reach the baseline`);
  }
});

test('ls_plan still rejects a malformed present test_now', () => {
  assert.throws(() => planContext().run('ls_plan', { test_now: 'not a date' }), /timestamp/);
  assert.throws(() => planContext().run('ls_plan', { test_now: {} }), /timestamp/);
});

test('ls_plan treats an absent or null test_now as absent', () => {
  assert.throws(() => planContext().run('ls_plan', {}), /ls_plan\.baseline\.targets/);
  assert.throws(() => planContext().run('ls_plan', { test_now: null }), /ls_plan\.baseline\.targets/);
});

test('ls_apply accepts a numeric epoch test_now without treating zero as absent', () => {
  // ls_apply returns null for a non-dry-run call that carries test_now; that
  // guard is a presence test, so epoch zero must still count as present.
  const ctx = planContext();
  assert.equal(ctx.run('ls_apply', { test_now: 0 }), null);
  assert.equal(ctx.run('ls_apply', { test_now: 1762000000 }), null);
});
