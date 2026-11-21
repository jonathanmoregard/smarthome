import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, JsonValue, ScriptHandlers, Snapshot } from '../../src/runtime/context.ts';

/**
 * `ls_remote_plan` reads of saved records (round-4 sweeps). Where the captured
 * template answers without raising, the port answers the same; Jinja semantics
 * were rendered in Home Assistant 2026.7.4:
 *
 * - `as_timestamp(r.get('when'),0)` is 0 for anything but date text, numbers included.
 * - `a.v.get('has_up',false) or command=='up'` is Jinja `or`: the stored value
 *   when Jinja-truthy, else the comparison.
 * - `v.get('adjustment',{}).get('updated',0) if v.get('adjustment') is mapping else 0`.
 * - `value.get('position') is number` holds for booleans.
 * - `for L in (switch_ranges or {}) if area_id(L)==room`: a list iterates its
 *   elements, a string its characters; `area_id` of a non-text scalar is none.
 *
 * Where the captured template raises on a saved value, the lenient saved-value
 * directive (2026-11-19) names a default instead; each default is the absent
 * spelling the template itself uses.
 */
const now = '2026-10-26T12:00:00.000Z';
const stamp = Date.parse(now) / 1000;
const earlier = '2026-10-26T11:00:00.000Z';
type Overrides = Record<string, JsonValue>;
function snapshot(overrides: Overrides, extra: JsonObject = {}, states: Snapshot['state'] = {}): Snapshot {
  return { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio', 'switch.plug': 'studio' },
    catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: {}, multicast: [], effects: {} },
    state: {
      'sensor.ls_overrides': { state: '0', last_updated: now, attributes: { overrides, ...extra } },
      'light.lamp': { state: 'off', attributes: {} },
      'switch.plug': { state: 'on', attributes: {} },
      ...states,
    } };
}
function plan(overrides: Overrides, command: string, options: { extra?: JsonObject; handlers?: ScriptHandlers;
  states?: Snapshot['state']; source?: string } = {}): JsonObject {
  const { result } = execute({ script: 'ls_remote_plan', snapshot: snapshot(overrides, options.extra, options.states),
    args: { source: options.source ?? 'remote', area: 'studio', command } }, { ...handlers, ...options.handlers });
  return result as JsonObject;
}
const input = (value: JsonValue, fields: JsonObject = {}): JsonValue =>
  ({ kind: 'input', scope: 'room', target: 'studio', when: earlier, value, ...fields });
const recordValue = (result: JsonObject) => ((result.records as JsonObject[])[0]!.value as JsonObject);
const adjustmentOf = (result: JsonObject) => recordValue(result).adjustment as JsonObject;

test("a saved record's numeric when is as_timestamp(when, 0) == 0 when picking the room's latest input", () => {
  const overrides = {
    'channels:a': input({ adjustment: { updated: 0, lower: 2, upper: 2, steps: 0 } }),
    'channels:b': input({ adjustment: { updated: 0, lower: -3, upper: -3, steps: 0 } }, { when: 9999999999 }),
  };
  const adjustment = adjustmentOf(plan(overrides, 'up', { source: 'x' }));
  assert.deepEqual([adjustment.lower, adjustment.upper], [3, 3]);
});

test("a saved input's numeric when is 0 as the built adjustment's updated, so any newer claim restarts it", () => {
  // kind channels via remote with a numeric position carries legacy_position;
  // a restart replaces the adjustment with the identity, which drops it.
  const overrides = {
    'channels:remote': input({ position: 3 }, { kind: 'channels', via: 'remote', when: 1792771800 }),
    'other': { kind: 'channels', scope: 'room', target: 'studio', when: earlier, value: { channels: { brightness: { updated: 100 } } } },
  };
  assert.equal(Object.hasOwn(adjustmentOf(plan(overrides, 'up')), 'legacy_position'), false);
});

test('a saved has_up is Jinja `or`: a truthy stored value is kept, a falsy one yields the press', () => {
  const cases: [JsonValue, string, JsonValue][] = [['yes', 'down', 'yes'], [0, 'down', false], [[], 'up', true], [null, 'down', false],
    [1, 'down', 1], [false, 'up', true]];
  for (const [has_up, command, expected] of cases) {
    const overrides = { 'channels:remote': input({ adjustment: { updated: 0, lower: 0, upper: 0, steps: 0, has_up } }) };
    assert.deepEqual(adjustmentOf(plan(overrides, command)).has_up, expected, JSON.stringify([has_up, command]));
  }
});

test("another record's non-mapping adjustment is no newer update (0), never a raise", () => {
  const own = { 'channels:remote': input({ adjustment: { updated: 0, lower: 1, upper: 1, steps: 0 } }) };
  const expected = adjustmentOf(plan(own, 'up'));
  for (const adjustment of ['x', [1], 5] as JsonValue[]) {
    // kind channels without via: an applying record, but not the room's input stream.
    const overrides = { ...own, other: { kind: 'channels', scope: 'room', target: 'studio', when: earlier, value: { adjustment } } };
    assert.deepEqual(adjustmentOf(plan(overrides, 'up')), expected, JSON.stringify(adjustment));
  }
});

test("a saved adjustment's unreadable numbers take the identity's: updated 0, lower/upper the range, steps 0", () => {
  for (const bad of ['x', null, [], {}] as JsonValue[]) {
    const overrides = { 'channels:remote': input({ step_range: { min: -4, max: 4 }, adjustment: { updated: bad, lower: bad, upper: bad, steps: bad } }) };
    const adjustment = adjustmentOf(plan(overrides, 'up'));
    assert.deepEqual([adjustment.lower, adjustment.upper, adjustment.steps], [-3, 4, 1], JSON.stringify(bad));
  }
  const missing = { 'channels:remote': input({ step_range: { min: -4, max: 4 }, adjustment: { note: 1 } }) };
  const adjustment = adjustmentOf(plan(missing, 'down'));
  assert.deepEqual([adjustment.lower, adjustment.upper, adjustment.steps, adjustment.note], [-4, 3, -1, 1]);
});

test("a saved adjustment's boolean numbers are Python's 0 and 1", () => {
  const overrides = { 'channels:remote': input({ adjustment: { updated: false, lower: true, upper: true, steps: false } }) };
  const adjustment = adjustmentOf(plan(overrides, 'up'));
  assert.deepEqual([adjustment.lower, adjustment.upper, adjustment.steps], [2, 2, 0]);
});

test("another record's unreadable claim updated reads as absent: the record's when", () => {
  const own = { 'channels:remote': input({ adjustment: { updated: stamp - 10, lower: 1, upper: 1, steps: 0, legacy_position: 7 } }) };
  // The other record's when (earlier) is older than the adjustment, so no restart.
  for (const updated of ['x', null, []] as JsonValue[]) {
    const overrides = { ...own, other: { kind: 'channels', scope: 'room', target: 'studio', when: earlier, value: { channels: { brightness: { updated } } } } };
    assert.equal(adjustmentOf(plan(overrides, 'up')).legacy_position, 7, JSON.stringify(updated));
  }
});

test('a saved boolean position is a Jinja number and becomes legacy_position', () => {
  const overrides = { 'channels:remote': input({ position: true }, { kind: 'channels', via: 'remote' }) };
  assert.equal(adjustmentOf(plan(overrides, 'up')).legacy_position, true);
});

test("a saved remote_valid_until that cannot be compared reads as 0: the context is expired and re-read", () => {
  for (const bad of ['x', null, []] as JsonValue[]) {
    const asked: JsonObject[] = [];
    const overrides = { 'channels:remote': input({ remote_valid_until: bad, remote_timing_revision: 0, adjustment: { updated: 0, lower: 0, upper: 0, steps: 0 } }) };
    plan(overrides, 'up', { states: { 'input_boolean.ls_ovr_next_block_on': { state: 'on', attributes: {} } },
      handlers: { ls_room_plan: (_ctx, args) => { asked.push(args); return { plan: {} }; } } });
    assert.equal(asked.length, 1, JSON.stringify(bad));
  }
});

test("a saved null selection reads as absent (the room's period); one that is not text is no choice", () => {
  // Both as the captured resolver reads the same value: null is no selection,
  // and 5 or ['day'] is a selection that names nothing (`savedSelection`).
  const roomPlan: ScriptHandlers = { ls_room_plan: () => ({ plan: { resolved: { targets: { 'room:studio': { period: 'cosy' } } } } }) };
  for (const [selection, next] of [[null, 'Candle'], [5, 'cosy'], [['day'], 'cosy']] as [JsonValue, string][]) {
    const overrides = { 'channels:remote': input({ selection }) };
    assert.equal(recordValue(plan(overrides, 'right', { handlers: roomPlan })).selection, next, JSON.stringify(selection));
  }
});

test('a saved switch_ranges is iterated as Jinja does: list elements, string characters; a number is none', () => {
  const targets = (switch_ranges: JsonValue) => plan({}, 'toggle', { extra: { switch_ranges } }).targets;
  assert.deepEqual(targets({ 'switch.plug': [1, 2] }), ['light.lamp', 'switch.plug']);
  assert.deepEqual(targets(['switch.plug', 5]), ['light.lamp', 'switch.plug']);
  assert.deepEqual(targets('switch.plug'), ['light.lamp']);
  assert.deepEqual(targets(5), ['light.lamp']);
  assert.deepEqual(targets([]), ['light.lamp']);
});
