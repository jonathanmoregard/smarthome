import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResolveArgs } from '../../src/parse/resolution.ts';
import { resolveEffects } from '../../src/domain/resolution.ts';
import type { JsonObject } from '../../src/runtime/context.ts';

/**
 * A target whose document names no area (absent, or `null` as the schedule
 * writes for a lamp in no room) is in no room. It must not be branded as a
 * room called `'undefined'` or `'null'`, which a stored record, a private-room
 * list or a power key spelled that way would then match.
 */

const channelRecord = (target: string): JsonObject => ({
  kind: 'channels', scope: 'room', target,
  value: { channels: { brightness: { kind: 'constant', value: 50, updated: 1 } } },
});

function resolveLamp(item: JsonObject, extra: JsonObject = {}) {
  return resolveEffects(parseResolveArgs({ base: { 'light.x': item }, ...extra }), new Set()).targets['light.x'];
}

test('a target with no area, or a null one, parses as in no room', () => {
  // Break: the parse brands `String(item.area)`, so absent reads as the room 'undefined' and null as 'null'.
  for (const item of [{}, { area: null }]) {
    assert.equal(parseResolveArgs({ base: { 'light.x': item } }).targets[0]?.item.area.kind, 'no room', JSON.stringify(item));
  }
  assert.deepEqual(parseResolveArgs({ base: { 'light.x': { area: 'kitchen' } } }).targets[0]?.item.area, { kind: 'room', room: 'kitchen' });
});

test('a room record whose target is the text of a missing area does not apply to a lamp in no room', () => {
  // Break: no area is the room 'undefined' (or 'null'), so a record saved for that text applies.
  for (const [item, text] of [[{}, 'undefined'], [{ area: null }, 'null']] as const) {
    const lamp = resolveLamp({ ...item, brightness: 110 }, { overrides: { r: channelRecord(text) } });
    assert.deepEqual(lamp?.brightness, { kind: 'constant', value: 110, updated: -1 }, text);
  }
});

test('a lamp in no room is never private and takes the default power, whatever keys spell a missing area', () => {
  // Break: no area is looked up as the room 'undefined'/'null' in the private list and the power map.
  for (const [item, text] of [[{}, 'undefined'], [{ area: null }, 'null']] as const) {
    const lamp = resolveLamp({ ...item, brightness: 110, period: 'day' },
      { sara: true, private: [text], power: { [text]: false } });
    assert.equal(lamp?.on, true, text);
    assert.equal(lamp?.color.kind, 'constant', text);
    assert.deepEqual(lamp?.color.kind === 'constant' ? lamp.color.policy : undefined, 'sara', text);
  }
});

test('a lamp in no room still echoes the area text the resolver has always written', () => {
  // Break: the output's `area` changes for a lamp in no room (a behaviour change, not this fix).
  assert.equal(resolveLamp({})?.area, 'undefined');
  assert.equal(resolveLamp({ area: null })?.area, 'null');
  assert.equal(resolveLamp({ area: 'kitchen' })?.area, 'kitchen');
});
