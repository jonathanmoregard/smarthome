import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, JsonValue, ScriptHandlers, Snapshot } from '../../src/runtime/context.ts';

/**
 * Boundary characterization for `ls_remote_plan`: the stored input value is
 * carried into the new record with its keys in place, its numbers are read
 * where the planner reads them, and stored preset contexts are spread only
 * when they are mappings.
 */
const now = '2026-10-26T12:00:00.000Z';
const stamp = Date.parse(now) / 1000;
function snapshot(value: JsonObject): Snapshot {
  return { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio' },
    catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: {}, multicast: [], effects: {} },
    state: {
      'sensor.ls_overrides': { state: '0', last_updated: now, attributes: { overrides: {
        'channels:remote': { kind: 'input', scope: 'room', target: 'studio', when: now, value },
      } } },
      'light.lamp': { state: 'on', attributes: {} },
    } };
}
function recordValue(value: JsonObject, command: string, extra: ScriptHandlers = {}): string {
  const { result } = execute({ script: 'ls_remote_plan', snapshot: snapshot(value), args: { source: 'remote', area: 'studio', command } },
    { ...handlers, ...extra });
  const records = (result as JsonObject).records as JsonValue[];
  return JSON.stringify((records[0] as JsonObject).value);
}

test('an up press keeps the stored value\'s keys in place and carries its documents', () => {
  const value = { z: 1, step_range: { min: -5, max: 5, note: 'x' }, channels: { brightness: { kind: 'constant' } }, position: 3,
    adjustment: { extra: [1], updated: 0, lower: -1, upper: 2, steps: 3, has_up: false }, tail: { deep: true } };
  assert.equal(recordValue(value, 'up'), JSON.stringify({
    z: 1, step_range: { min: -5, max: 5, note: 'x' },
    adjustment: { extra: [1], updated: stamp, lower: 0, upper: 3, steps: 4, has_up: true, last: 'up' },
    tail: { deep: true },
  }));
});

// Round 4 (lenient saved-value directive): a missing saved bound reads as the step range's end.
test("a stored adjustment with no lower reads it as the step range's minimum on a press", () => {
  const adjustment = JSON.parse(recordValue({ adjustment: { updated: 0, upper: 2, steps: 0 } }, 'down')).adjustment;
  assert.deepEqual([adjustment.lower, adjustment.upper, adjustment.steps], [-20, 1, -1]);
});

const roomPlan: ScriptHandlers = { ls_room_plan: () => ({ plan: { resolved: { targets: { 'room:studio': { period: 'cosy' } } } } }) };

test('a stored preset context that is a mapping is spread into the value', () => {
  const value = { selection: 'day', preset_contexts: { cosy: { period: 'cosy', other: { x: 1 } } } };
  assert.equal(recordValue(value, 'right', roomPlan), JSON.stringify({
    selection: 'cosy', preset_contexts: { cosy: { period: 'cosy', other: { x: 1 } }, day: {} }, step_range: { min: -20, max: 20 },
    adjustment: { steps: 0, lower: -20, upper: 20, anchor: 'current', updated: stamp }, period: 'cosy', other: { x: 1 },
  }));
});

test('a stored preset context that is not a mapping is replaced by a fresh one', () => {
  const value = { selection: 'day', preset_contexts: { cosy: ['period', 'cosy'] } };
  assert.equal(recordValue(value, 'right', roomPlan), JSON.stringify({
    selection: 'cosy', preset_contexts: { cosy: ['period', 'cosy'], day: {} }, step_range: { min: -20, max: 20 },
    adjustment: { steps: 0, lower: -20, upper: 20, anchor: 'current', updated: stamp }, period: 'cosy', period_updated: stamp, selection_updated: stamp,
  }));
});

test('with no stored selection the room plan\'s period is the selection, and a null period raises', () => {
  const nullPeriod: ScriptHandlers = { ls_room_plan: () => ({ plan: { resolved: { targets: { 'room:studio': { period: null } } } } }) };
  assert.throws(() => recordValue({}, 'left', nullPeriod), /ls_remote_plan\.selection must be a string, got null/);
});

test('a saved selection that is not text is no choice: an arrow starts the cycle and saves no context under it', () => {
  // The captured resolver reads a selection that is not text as a selection
  // naming no effect, not as an absent one (`remote-saved-presets.test.ts`);
  // the remote plan reads it the same way: like a selection that is no
  // choice (captured `choices.index(selected) if selected in choices else
  // 0`), with no name to save its context under.
  // Break: the selection reads as absent, so the cycle starts at the room's
  // period ('cosy' -> 'Candle') and cosy's context is overwritten.
  const notText = JSON.parse(recordValue({ selection: 5 }, 'right', roomPlan));
  const noChoice = JSON.parse(recordValue({ selection: 'Unknown effect' }, 'right', roomPlan));
  assert.equal(notText.selection, 'cosy');
  assert.equal(noChoice.selection, 'cosy');
  assert.deepEqual(notText.preset_contexts, {});
  assert.deepEqual(noChoice.preset_contexts, { 'Unknown effect': {} });
});
