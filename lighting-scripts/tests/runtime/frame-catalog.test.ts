import { test } from 'node:test';
import assert from 'node:assert/strict';
import { context } from './gestures-context.ts';
import { transportHandlers } from '../../src/domain/transport.ts';

/**
 * `renderer` is required at exactly one boundary: `effects_frame_plan`, the
 * only path that drives a renderer as a script name.
 *
 * {@link parseCatalog} deliberately does not require it. An earlier revision
 * did, which promoted this mid-frame error into a load-time one for every
 * catalog reader and broke `ls_apply` on a document whose `effects.Breathe`
 * carries no renderer. These two tests are a pair: the one in
 * `catalog.test.ts` pins that the general parse accepts such a document, and
 * this one pins that the frame plan still refuses to render it. Deleting
 * either one lets the regression back in unnoticed.
 */

function framePlan(catalogEffects: Record<string, unknown>): () => unknown {
  // The plan hands its rows to the group planner; stub it so this test fails
  // only on the renderer boundary it is about.
  const ctx = context({ ...transportHandlers, effects_group_plan: () => ({ commands: [] }) });
  return () => ctx.run('effects_frame_plan', {
    catalog: { effects: catalogEffects, members: {}, topics: {}, multicast: [] },
    targets: {},
    timestamp: 0,
  });
}

test('the frame plan still refuses an effect without a renderer', () => {
  assert.throws(framePlan({ Breathe: {} }), /renderer must be a string/);
  assert.throws(framePlan({ Breathe: { renderer: 7 } }), /renderer must be a string/);
});

test('the frame plan accepts an effect whose renderer is a script name', () => {
  assert.doesNotThrow(framePlan({ Breathe: { renderer: 'effect_breathe_frame' } }));
});
