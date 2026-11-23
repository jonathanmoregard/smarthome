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
  assert.deepEqual(decodeSwitches({ on: false, range: [true, 100] }), { 'switch.fan': { on: false, room: 'studio', range: [true, 100] } });
});

test('a switch decision that is on without a brightness in its range is refused', () => {
  // Break: `on` is read on its own, so a switch on with no level, or one
  // outside its range, decodes.
  for (const decision of [{ on: true, range: [10, 60] }, { on: true, brightness: 70, range: [10, 60] }]) {
    assert.throws(() => decodeSwitches(decision),
      refused(/ls_switch_plan\.switches\.switch\.fan\.on is true only with a brightness within its range/), JSON.stringify(decision));
  }
  const decoded = decodeSwitches({ on: true, brightness: 40, range: [10, 60] });
  assert.deepEqual(decoded === undefined ? undefined : Object.values(decoded).map(decision => decision.on), [true]);
});

// ls_base / ls_room_base: `scheduledBase` gives every lamp and room a block as
// its period, and mirrors each scope's block into
// `input_select.ls_<scope>_override` as the block's capitalised option.

const profile = { effect: 'Normal light', effect_channels: ['brightness', 'color'], on: false, period: 'day', area: null, send: true,
  ignore_overrides: [] };
const room = { area: 'studio', is_room: true, period: 'day', effect: 'Normal light', on: false, ignore_overrides: [] };
const base = (fields: { profiles?: JsonObject; targets?: JsonObject; mirror?: JsonValue[] }): JsonValue => ({
  targets: fields.targets === undefined ? {} : fields.targets,
  schedule: { cmds: [], profiles: fields.profiles === undefined ? {} : fields.profiles, revision: 'r', stale_keys: [],
    sched: { house: 'day', studio: 'cosy' }, schedule_details: {}, mirror: fields.mirror === undefined ? [] : fields.mirror, sara_mirror: null },
});
const decodeBase = (fields: { profiles?: JsonObject; targets?: JsonObject; mirror?: JsonValue[] }) =>
  resultCodecs.ls_base.decode?.(base(fields), 'ls_base');

test('a lamp or room whose period is not a block is refused', () => {
  // Break: a period is read as any text, so 'lamp' or 'evening' decodes.
  for (const period of ['lamp', 'evening', 'Day']) {
    assert.throws(() => decodeBase({ profiles: { 'light.a': { ...profile, period } } }),
      refused(/ls_base\.schedule\.profiles\.light\.a\.period must be one of day\/cosy\/night/), period);
    assert.throws(() => decodeBase({ targets: { 'light.a': { ...profile, period, is_room: false, transition: 3 } } }),
      refused(/ls_base\.targets\.light\.a\.period must be one of day\/cosy\/night/), period);
    assert.throws(() => decodeBase({ targets: { 'room:studio': { ...room, period } } }),
      refused(/ls_base\.targets\.room:studio\.period must be one of day\/cosy\/night/), period);
  }
  assert.equal(decodeBase({ profiles: { 'light.a': profile } })?.schedule.profiles['light.a']?.period, 'day');
});

test("a mirror row that is not a scope's override select set to a block's option is refused", () => {
  // Break: a mirror row's entity and option are read as any text.
  for (const [row, pattern] of [
    [{ entity: 'input_select.ls_studio_override', option: 'cosy' }, /mirror\.0\.option must be one of Day\/Cosy\/Night, got "cosy"/],
    [{ entity: 'input_select.ls_studio_override', option: 'Evening' }, /mirror\.0\.option must be one of Day\/Cosy\/Night, got "Evening"/],
    [{ entity: 'input_select.ls_attic_override', option: 'Day' },
      /mirror\.0\.entity must be input_select\.ls_<scope>_override for a scope in sched, got "input_select\.ls_attic_override"/],
    [{ entity: 'light.studio', option: 'Day' }, /mirror\.0\.entity must be input_select\.ls_<scope>_override/],
  ] as const) {
    assert.throws(() => decodeBase({ mirror: [row] }), refused(pattern), JSON.stringify(row));
  }
  assert.deepEqual(decodeBase({ mirror: [{ entity: 'input_select.ls_house_override', option: 'Night' }] })?.schedule.mirror,
    [{ entity: 'input_select.ls_house_override', option: 'Night' }]);
});
