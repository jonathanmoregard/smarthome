import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { resultCodecs } from '../../src/parse/results.ts';
import { ParseError } from '../../src/runtime/parse.ts';

/*
 * Review round 3: each decoder in `src/parse/results.ts` is the JSON edge for
 * an answer that does not come from the registered handler (a stub), so it
 * accepts only what that handler can emit. These pin the tightened ones
 * beyond ls_remote_plan (`remote-plan-records.test.ts`).
 */

const refused = (pattern: RegExp) => (error: unknown) => error instanceof ParseError && pattern.test(error.message);

// ls_switch_plan: `switchPlan` takes its range from `switchRange`, which keeps
// only two Jinja numbers (a boolean reads as 0 or 1) with 0 <= low <= high <=
// 100, and switches a switch on only when its room's brightness is in that range.

const switches = (decision: JsonObject): JsonValue => ({ switches: { 'switch.fan': { room: 'studio', ...decision } } });
const decodeSwitches = (decision: JsonObject) => resultCodecs.ls_switch_plan.decode?.(switches(decision), 'ls_switch_plan');

test('a switch decision with a range no switch range gives is refused', () => {
  // Break: the bounds are read one by one as numbers or booleans, so an
  // inverted or out-of-scale range decodes.
  for (const range of [[50, 10], [-5, 10], [0, 101], [true, false]] as JsonValue[]) {
    assert.throws(() => decodeSwitches({ on: false, range }),
      refused(/ls_switch_plan\.switches\.switch\.fan\.range must be two bounds with 0 <= low <= high <= 100/), JSON.stringify(range));
  }
  assert.deepEqual(decodeSwitches({ on: false, range: [true, 100] })?.switches, { 'switch.fan': { on: false, room: 'studio', range: [true, 100] } });
});

test('a switch decision that is on without a brightness in its range is refused', () => {
  // Break: `on` is read on its own, so a switch on with no level, or one
  // outside its range, decodes.
  for (const decision of [{ on: true, range: [10, 60] }, { on: true, brightness: 70, range: [10, 60] }]) {
    assert.throws(() => decodeSwitches(decision),
      refused(/ls_switch_plan\.switches\.switch\.fan\.on is true only with a brightness within its range/), JSON.stringify(decision));
  }
  const decoded = decodeSwitches({ on: true, brightness: 40, range: [10, 60] });
  assert.deepEqual(decoded === undefined ? undefined : Object.values(decoded.switches).map(decision => decision.on), [true]);
});
