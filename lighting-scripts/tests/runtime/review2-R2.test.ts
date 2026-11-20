import assert from 'node:assert/strict';
import test from 'node:test';
import { context, setCatalog } from './gestures-context.ts';
import { uiHandlers } from '../../src/handlers/ui-state.ts';

// Review 2, R2: a saved `effect_channels` that is null or a non-string list
// (ls_store keeps a stored list as stored, and treats a non-list as absent) is
// a saved value: effects_ui_sync reads it leniently and never raises. The
// oracle reads it as `profile.get('effect_channels', ['brightness','color'])`
// under Jinja truthiness: a falsy value shows 'Normal Light', a truthy one the
// saved effect.
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

for (const [channels, shown] of [
  ['null', 'Normal Light'], ['[]', 'Normal Light'], ['false', 'Normal Light'], ['0', 'Normal Light'], ['""', 'Normal Light'], ['{}', 'Normal Light'],
  ['[1]', 'Candle'], ['[null]', 'Candle'], ['["brightness"]', 'Candle'], ['"color"', 'Candle'], ['{"a":1}', 'Candle'], ['3', 'Candle'],
] as const) {
  test(`review2 R2: saved effect_channels ${channels} does not abort effects_ui_sync and shows ${shown}`, () => {
    assert.equal(effectShown(`{"effect":"Candle","effect_channels":${channels}}`), shown);
  });
}

test('review2 R2: an absent effect_channels still shows the saved effect', () => {
  assert.equal(effectShown('{"effect":"Candle"}'), 'Candle');
});
