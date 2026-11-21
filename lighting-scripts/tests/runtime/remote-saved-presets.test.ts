import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { resolveEffects } from '../../src/domain/resolution.ts';
import { parseResolveArgs } from '../../src/parse/resolution.ts';

/**
 * A remote's saved input record names presets as text: its `period`, an
 * input's `anchor` and its `selection`. The captured resolver tests them with
 * Jinja `in ['day','cosy']` / `not in ['day','cosy',none]`, which compares the
 * whole saved value; a value that is not text is never a preset there.
 */

const anchors = { day: { brightness: 220, color: { kelvin: 4000 } }, cosy: { brightness: 110, color: { kelvin: 2200 } } };
const item = { area: 'living', period: 'night', brightness: 3, color: { kelvin: 2200 }, ...anchors, is_room: true };
const adjustment = { steps: 0, lower: -20, upper: 20, last: 'up', updated: 1 };

function resolve(value: JsonObject): JsonValue {
  const args: JsonObject = { base: { 'room:living': item }, catalog: { effects: {} }, overrides: { remote: {
    kind: 'input', scope: 'room', target: 'living', when: '2026-10-26T23:35:00+01:00', value } } };
  return resolveEffects(parseResolveArgs(args), new Set());
}

test('a saved anchor that is a one-item list is not the preset it prints as', () => {
  // Break: the anchor is tested as `String(anchor)`, so ['day'] reads as 'day'
  // and the input is anchored on the room's period.
  assert.notDeepEqual(resolve({ period: 'cosy', adjustment: { ...adjustment, anchor: 'day' } }),
    resolve({ period: 'cosy', adjustment: { ...adjustment, anchor: 'elsewhere' } }));
  assert.deepEqual(resolve({ period: 'cosy', adjustment: { ...adjustment, anchor: ['day'] } }),
    resolve({ period: 'cosy', adjustment: { ...adjustment, anchor: 'elsewhere' } }));
});

test('a saved period that is a one-item list is not the preset it prints as', () => {
  // Break: the period is tested as `String(period)`, so ['cosy'] reads as
  // 'cosy' and replaces the input's own 'day' anchor.
  assert.notDeepEqual(resolve({ period: 'cosy', adjustment: { ...adjustment, anchor: 'day' } }),
    resolve({ period: 'elsewhere', adjustment: { ...adjustment, anchor: 'day' } }));
  assert.deepEqual(resolve({ period: ['cosy'], adjustment: { ...adjustment, anchor: 'day' } }),
    resolve({ period: 'elsewhere', adjustment: { ...adjustment, anchor: 'day' } }));
});
