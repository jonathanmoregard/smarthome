import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityState, JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { renderAck, renderOpening } from '../../src/legacy/domain/dispatch-render.ts';
import { dispatchPlanOrder } from '../../src/parse/dispatch-render.ts';
import { runtimePlanOrder } from '../../src/parse/transport.ts';
import { house } from './house-view.ts';

/**
 * Saved runtime/override attributes read by ls_render, ls_dispatch and
 * effects_assign.
 * - `full_version and full_version != handled_full` (ls_render): Jinja
 *   truthiness, then the stored values compared; and the ack's handled_full is
 *   captured `full_version if full else state_attr(runtime,'handled_full')`.
 * - `plan_order or 0` (ls_dispatch, effects_assign): a value Python cannot
 *   compare with a number takes the captured default 0 (lenient saved-value
 *   directive) instead of raising; a boolean is the number Python says it is.
 */
const REVISION = '2026-10-26T11:00:00+00:00';
const runtime = 'sensor.ls_effects_runtime';
const overrides = (attributes: JsonObject): EntityState => ({ state: '0', attributes, last_updated: REVISION });

test('a Jinja-falsy full_version is no full render, and nothing raises', () => {
  for (const full_version of ['', 0, false, [], {}, null] as JsonValue[]) {
    const view = house({ 'sensor.ls_overrides': overrides({ full_version }), [runtime]: ['g', { handled_full: 'v1' }] });
    assert.equal(renderOpening(view), undefined, JSON.stringify(full_version));
  }
});

test('a truthy full_version of any type renders in full when it differs from handled_full', () => {
  for (const full_version of [3, 'v2', ['v'], true] as JsonValue[]) {
    const view = house({ 'sensor.ls_overrides': overrides({ full_version }), [runtime]: ['g', { handled_full: 'v1' }] });
    assert.equal(renderOpening(view)?.full, true, JSON.stringify(full_version));
  }
  const same = house({ 'sensor.ls_overrides': overrides({ full_version: ['v'] }), [runtime]: ['g', { handled_full: ['v'] }] });
  assert.equal(renderOpening(same), undefined);
});

test("the ack keeps the stored handled_full when the render was not full, whatever full_version holds", () => {
  const view = house({ 'sensor.ls_overrides': overrides({ full_version: '', pending_rooms: { a: 2 } }),
    [runtime]: ['g', { handled_rooms: { a: 1 }, handled_full: 'v1' }] });
  const opening = renderOpening(view)!;
  assert.equal(opening.full, false);
  const ack = renderAck(view, opening, 1, { completed: true, published_at: [] });
  assert.equal((ack as { data: { attributes: JsonObject } }).data.attributes.handled_full, 'v1');
});

test('a saved runtime plan_order Python cannot compare is the captured default 0; a boolean is 0 or 1', () => {
  const view = (plan_order: JsonValue) => house({ [runtime]: ['0', { plan_order }] });
  for (const value of ['x', [1], { a: 1 }, '5'] as JsonValue[]) {
    assert.equal(dispatchPlanOrder(view(value)), 0, `ls_dispatch ${JSON.stringify(value)}`);
    assert.equal(runtimePlanOrder(view(value)), 0, `effects_assign ${JSON.stringify(value)}`);
  }
  assert.equal(dispatchPlanOrder(view(true)), 1);
  assert.equal(runtimePlanOrder(view(true)), 1);
  assert.equal(dispatchPlanOrder(view(7.5)), 7.5);
});
