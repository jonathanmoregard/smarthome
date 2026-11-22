import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWarmEnd } from '../../src/parse/controller.ts';
import { WARM_END } from '../../src/legacy/domain/scale.ts';

// Captured ls_plan: `state_attr(..., 'rgb_color') or [255,126,0]` — Jinja `or`,
// so every falsy value takes the default, not only absent/null.
for (const [label, value] of [['absent', undefined], ['null', null], ['empty list', []], ['empty mapping', {}], ['zero', 0], ['empty string', '']] as const) {
  test(`ls_plan warm end: ${label} takes the built-in warm end`, () => {
    assert.deepEqual(planWarmEnd(value as never), WARM_END);
  });
}

test('ls_plan warm end: an rgb triple is used as-is', () => {
  assert.deepEqual(planWarmEnd([10, 20, 30]), [10, 20, 30]);
});
