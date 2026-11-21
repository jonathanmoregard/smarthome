import assert from 'node:assert/strict';
import test from 'node:test';
import { context, setCatalog } from './gestures-context.ts';
import { uiHandlers } from '../../src/handlers/ui-state.ts';

// A saved profile's `effect` is a saved value (user directive 2026-11-19:
// "typed with parser that is flexible and has default"), so effects_ui_sync
// reads it leniently and never raises. A string is the saved effect; anything
// else (null, a number, a boolean, a list, a mapping) takes the named default
// 'Normal light', which the mirror shows as 'Normal Light' -- the value the
// captured mirror renders for `profile.get('effect','Normal light')` when the
// profile names no effect.
function load() {
  const ctx = context({ ...uiHandlers, effects_catalog: c => c.rawCatalog() });
  const topics = Object.fromEntries(['availability', 'power', 'effect', 'brightness', 'temperature', 'rgb'].map(k => [k, `test/${k}`]));
  setCatalog(ctx, { ui_rows: [{ source: 'light.group', proxy: 'light.ep_test', members: ['light.group'], store: 'input_text.profile', topics }] });
  ctx.put('light.group', 'on');
  return ctx;
}
function effectShown(saved: string): string | undefined {
  const ctx = load();
  ctx.put('input_text.profile', saved);
  const result = ctx.run('effects_ui_sync', { dry_run: true, force: true }) as { messages: { topic: string; payload: string }[] };
  return result.messages.find(message => message.topic === 'test/effect')?.payload;
}

for (const effect of ['null', '0', '5', 'true', 'false', '[]', '["Candle"]', '{}', '{"a":1}']) {
  test(`effects_ui_sync: a saved non-string effect ${effect} with truthy channels shows Normal Light`, () => {
    assert.equal(effectShown(`{"effect":${effect},"effect_channels":["brightness","color"]}`), 'Normal Light');
  });
}

test('effects_ui_sync: a saved string effect is still shown as saved', () => {
  assert.equal(effectShown('{"effect":"Candle","effect_channels":["brightness","color"]}'), 'Candle');
  assert.equal(effectShown('{"effect":"Normal light"}'), 'Normal Light');
});
