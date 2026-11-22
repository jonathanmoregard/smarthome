import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOverlayKey } from '../../src/parse/overlay-key.ts';
import { parseRemotePlanArgs } from '../../src/parse/remote-input.ts';
import { overlayKeyText } from '../../src/adapter/codecs/overlay-key.ts';

/**
 * `overlayKeyText` is the exact inverse of `parseOverlayKey` both ways: a key
 * any constructor can build writes text that reads back as that same key. A
 * remote's source is the one payload built from outside text, so a source
 * spelling another channel key's prefix is refused where it is read.
 */

test('a remote source spelling a dashboard or native control key is refused at the edge', () => {
  // Break: the source is taken as any text, so `channels:ui:x` is written for a remote and read back as a dashboard control.
  for (const source of ['ui:light.ls_x', 'native:room:studio']) {
    assert.throws(() => parseRemotePlanArgs({ source, area: 'studio', command: 'up' }), /A remote source must not begin/, source);
  }
  assert.equal(parseRemotePlanArgs({ source: 'remote_ieee', area: 'studio', command: 'up' }).source, 'remote_ieee');
});

test('every key the parser builds writes text that reads back as the same key', () => {
  // Break: a payload admits text that another kind's prefix claims, so key -> text -> key changes kind.
  for (const text of ['mode:sara', 'block:studio', 'channels:remote_ieee', 'channels:', 'channels:native:room:studio',
    'channels:ui:light.ls_x:studio', 'light:light.lamp', 'mode:other', '']) {
    const key = parseOverlayKey(text);
    assert.deepEqual(parseOverlayKey(overlayKeyText(key)), key, text);
  }
});
