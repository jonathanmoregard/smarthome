import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';

/**
 * `effects_gradient_plan`'s `warm_end` is parsed at the edge into an RGB
 * triple, read where the signature lists it. A present value that is not a
 * triple of finite numbers raises a ParseError naming the field, instead of
 * flowing into the signature and curve as whatever it was.
 */
const anchors = { day: { brightness: 220, color: { kelvin: 4000 } }, cosy: { brightness: 110, color: { kelvin: 2200 } } };
const plan = (args: JsonObject) => execute({ script: 'effects_gradient_plan', args,
  snapshot: { now: '2026-10-26T12:00:00Z', state: {}, areas: {}, members: [] } }, handlers).result;

for (const warmEnd of [[255, 126, 0, 9], [255, 126], 'abc', 5] as JsonValue[]) {
  test(`a warm_end of ${JSON.stringify(warmEnd)} is not an RGB triple and raises where the signature reads it`, () => {
    assert.throws(() => plan({ base: { lamp: anchors }, warm_end: warmEnd }), {
      name: 'ParseError',
      message: `effects_gradient_plan.warm_end must be [r, g, b] with finite numbers, got ${JSON.stringify(warmEnd)}`,
    });
    assert.deepEqual(plan({ base: {}, warm_end: warmEnd }), { gradients: {} }, 'nothing compiles, so nothing reads it');
  });
}

test('an RGB warm_end is the signature tail and the curve tail end', () => {
  const result = plan({ base: { lamp: anchors }, warm_end: [250, 120, 3] }) as { gradients: Record<string, { signature: JsonValue[]; curve: { colors: { tail: { right: JsonValue } } } }> };
  assert.deepEqual(result.gradients.lamp!.signature.at(-1), [250, 120, 3]);
  assert.deepEqual(result.gradients.lamp!.curve.colors.tail.right, { rgb: [250, 120, 3] });
});
