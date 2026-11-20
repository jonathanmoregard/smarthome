import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { context, stub } from './gestures-context.ts';

// The captured ls_plan and ls_apply forward test_now unread
// (`{{ test_now|default(none) }}`); ls_base and ls_room_base parse it behind
// `test_now is defined and test_now`, so a numeric epoch is legal and a
// Jinja-falsy value (0 included) is "now" (round 4; r4-controller-jinja and
// r4-schedule-jinja tests). Nothing coerces it to a string.
//
// The parity gate cannot observe this: no preserved suite passes a numeric
// test_now to ls_plan or ls_apply. These assertions are the only guard.

function planContext() {
  const ctx = context({
    ...controllerHandlers,
    // `targets` is absent ON PURPOSE: these tests assert that a legal
    // test_now gets all the way to the baseline, and the baseline's refusal
    // is the evidence. Completing this stub would make every assertion below
    // vacuous. The refusal now comes from `decodeScheduledBase`, which is why
    // it is labelled `ls_base.targets` and no longer `ls_plan.baseline`.
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
      /ls_base\.targets/, `numeric test_now ${value} must reach the baseline`);
  }
});

test('a malformed present test_now is rejected by ls_base, the script that parses it', () => {
  for (const test_now of ['not a date', [1]]) {
    assert.throws(() => context(scheduleHandlers).run('ls_base', { test_now, overrides: {} }), /timestamp/, JSON.stringify(test_now));
  }
});

test('ls_plan treats an absent or null test_now as absent', () => {
  assert.throws(() => planContext().run('ls_plan', {}), /ls_base\.targets/);
  assert.throws(() => planContext().run('ls_plan', { test_now: null }), /ls_base\.targets/);
});

test('ls_apply accepts a numeric epoch test_now', () => {
  // ls_apply returns null for a non-dry-run call that carries a truthy test_now.
  assert.equal(planContext().run('ls_apply', { test_now: 1762000000 }), null);
});
