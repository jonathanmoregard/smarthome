import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResolveArgs } from '../../src/parse/resolution.ts';
import { resolveEffects } from '../../src/legacy/domain/resolution.ts';
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

test('a lamp in no room writes its area as null, as the scripts do', () => {
  // Review round 3, item 1: the captured resolver writes `area=item.area`,
  // null for a lamp in no room. The port wrote the text 'undefined' or
  // 'null', which a room named 'null' would also write.
  // Break: a lamp in no room writes a text sentinel as its area.
  assert.equal(resolveLamp({})?.area, null);
  assert.equal(resolveLamp({ area: null })?.area, null);
  assert.equal(resolveLamp({ area: 'kitchen' })?.area, 'kitchen');
  assert.equal(resolveLamp({ area: 'null' })?.area, 'null');
});

/*
 * Review round 2, item 1. A target document reaches the resolver from the
 * schedule (whose area is a RoomId or null) and from the room cache, which is
 * saved data and carries its targets verbatim. A saved area that is not text
 * names no room, so it takes the lenient no-room reading the parser already
 * gives an absent or null area (saved data: the named default), read as the
 * schedule's explicit null.
 */

test('a saved area that is not text parses as in no room, as the schedule null does', () => {
  // Break: the parse brands `String(item.area)`, so `{}` is the room '[object Object]' and `5` the room '5'.
  for (const area of [{}, 5, true, ['kitchen']]) {
    assert.deepEqual(parseResolveArgs({ base: { 'light.x': { area } } }).targets[0]?.item.area,
      { kind: 'no room' }, JSON.stringify(area));
  }
});

test('a room record whose target is the text of a non-text area does not apply to that lamp', () => {
  // Break: the area `5` is the room '5', so a room record saved for '5' applies to the lamp.
  for (const [area, text] of [[5, '5'], [{}, '[object Object]']] as const) {
    const lamp = resolveLamp({ area, brightness: 110 }, { overrides: { r: channelRecord(text) } });
    assert.deepEqual(lamp?.brightness, { kind: 'constant', value: 110, updated: -1 }, text);
    assert.equal(lamp?.area, null, text);
  }
});
