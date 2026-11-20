import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { switchPlan } from '../../src/domain/controller.ts';
import { parseSwitchPlanArgs } from '../../src/parse/controller.ts';

/**
 * `ls_switch_plan` over the saved `switch_ranges` rules (round-4 sweeps). Captured:
 *
 *   interval = [rule.get('min'),rule.get('max')] if rule.get('profile')=='custom'
 *              else defaults.get(rule.get('profile'),[])
 *   valid    = interval|count==2 and interval[0] is number and interval[1] is number
 *              and 0<=interval[0]<=interval[1]<=100
 *
 * `is number` holds for booleans (Python 0/1), and `ls_commit`'s range_set
 * stores a boolean bound as given, so a custom `{min: true}` is a valid rule
 * whose range is reported as stored. `defaults.get(profile)` looks up only a
 * text profile; a list profile raises (lenient: no range), a number is no key.
 */
function plan(rule: JsonValue, defaults: JsonObject = { bright: [90, 100], cosy: [30, 60] }) {
  return switchPlan({ 'switch.plug': 'studio' }, parseSwitchPlanArgs({
    targets: { 'room:studio': { on: true, level: 255 } }, ranges: { 'switch.plug': rule }, defaults,
  })).switches;
}

test('a boolean custom bound is a Jinja number: the rule applies and reports its range as stored', () => {
  assert.deepEqual(plan({ profile: 'custom', min: true, max: 100 }),
    { 'switch.plug': { on: true, room: 'studio', brightness: 100, range: [true, 100] } });
});

test('a profile that is not text names no default range', () => {
  assert.deepEqual(plan({ profile: ['bright'] }), {});
  assert.deepEqual(plan({ profile: 5 }, { 5: [0, 100] }), {});
  assert.deepEqual(plan({ profile: 'bright' })['switch.plug']?.range, [90, 100]);
});
