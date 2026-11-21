import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOverlayKey } from '../../src/parse/overlay-key.ts';
import { overlayKeyText } from '../../src/domain/types/overlay.ts';

test('each saved key shape reads as the overlay it names', () => {
  // Break: mis-ordered prefixes would read `channels:native:...` as a remote's input.
  assert.deepEqual(parseOverlayKey('mode:sara'), { kind: 'sara mode' });
  assert.deepEqual(parseOverlayKey('block:studio'), { kind: 'block', scope: 'studio' });
  assert.deepEqual(parseOverlayKey('channels:remote_ieee'), { kind: 'remote input', source: 'remote_ieee' });
  assert.deepEqual(parseOverlayKey('channels:native:room:studio'), { kind: 'native control', base: 'room:studio' });
  assert.deepEqual(parseOverlayKey('channels:ui:light.ls_x:studio'), { kind: 'dashboard control', control: 'light.ls_x:studio' });
});

test('a key of no known shape is kept as saved, never dropped', () => {
  // Break: rejecting it would make one unknown saved key fail every read of the store.
  for (const key of ['light:light.lamp', 'mode:other', 'sara', 'block', 'channels']) {
    assert.deepEqual(parseOverlayKey(key), { kind: 'saved', key });
  }
});

test('the empty key reads as its own case', () => {
  // Break: the empty key is a saved key of no shape, so the searches that start from it build one by hand.
  assert.deepEqual(parseOverlayKey(''), { kind: 'empty' });
});

test("writing a key back gives today's exact saved text", () => {
  // Break: any reformatting would orphan the saved overlay under its old key.
  for (const key of ['mode:sara', 'block:studio', 'block:house', 'block:', 'channels:x', 'channels:', 'channels:native:light.a',
    'channels:native:', 'channels:ui:light.a', 'channels:ui:light.a:light.b', 'light:light.lamp', 'mode:sara:x', '']) {
    assert.equal(overlayKeyText(parseOverlayKey(key)), key);
  }
});
