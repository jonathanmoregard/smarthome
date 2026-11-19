import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { stateStoreHandlers } from '../../src/domain/state-store.ts';
import { resolveEffects } from '../../src/domain/resolution.ts';
import { parseResolveArgs } from '../../src/parse/resolution.ts';
import { planGradients } from '../../src/parse/gradient.ts';
import { context } from './gestures-context.ts';

/**
 * Defaults the captured scripts apply only to an ABSENT key: `dict.get(key,
 * default)`, and a script field's `default:` (Home Assistant fills it only for
 * a field the caller left out). An explicit null is a value there, so it must
 * not fall back here either.
 */

function createdAfterSet(stored: JsonObject): JsonValue | undefined {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', { overrides: { k: { kind: 'light', ...stored } } });
  ctx.run('ls_commit', { data: { via: 'app', records: [{ key: 'k', kind: 'light', target: 'light.a', value: 1 }] } });
  const update = ctx.calls.find(call => call.service === 'variable.update_sensor');
  const overrides = (update?.data.attributes as JsonObject).overrides as Record<string, JsonObject>;
  return overrides.k!.created;
}

test('ls_commit keeps an explicit null created', () => {
  // Captured: `created=old.get('created',old.get('when',now().isoformat()))`.
  assert.equal(createdAfterSet({ created: null, when: 'w0' }), null);
});

test('ls_commit takes an explicit null when over now when created is absent', () => {
  assert.equal(createdAfterSet({ when: null }), null);
});

test('ls_commit falls back to when, then now, only for absent keys', () => {
  assert.equal(createdAfterSet({ created: 'c0', when: 'w0' }), 'c0');
  assert.equal(createdAfterSet({ when: 'w0' }), 'w0');
  assert.equal(createdAfterSet({}), '2026-10-26T12:00:00+01:00');
});

const anchors = { day: { brightness: 220, color: { kelvin: 4000 } }, cosy: { brightness: 110, color: { kelvin: 2200 } } };

test('effects_gradient_plan raises on an explicit null warm_end where the signature lists it', () => {
  // Field `warm_end` has `default: [255,126,0]`, filled only when absent; the
  // signature's `warm_end|list` then raises on None.
  assert.throws(() => planGradients({ base: { lamp: anchors }, warm_end: null }), TypeError);
  assert.deepEqual(planGradients({ base: {}, warm_end: null }), { gradients: {} });
  assert.deepEqual(planGradients({ base: { lamp: anchors } }), planGradients({ base: { lamp: anchors }, warm_end: [255, 126, 0] }));
});

test('effects_resolve raises on an explicit null warm_end where a scaled target lists it', () => {
  const item = { area: 'living', period: 'night', brightness: 3, color: { kelvin: 2200 }, ...anchors };
  const args: JsonObject = { base: { 'room:living': { ...item, is_room: true } }, catalog: { effects: {} }, overrides: { remote: {
    kind: 'input', scope: 'room', target: 'living', when: '2026-10-26T23:35:00+01:00',
    value: { adjustment: { steps: 1, lower: -20, upper: 20, last: 'up', anchor: 'current', updated: 1 } } } } };
  assert.throws(() => resolveEffects(parseResolveArgs({ ...args, warm_end: null })), TypeError);
  assert.deepEqual(resolveEffects(parseResolveArgs(args)), resolveEffects(parseResolveArgs({ ...args, warm_end: [255, 126, 0] })));
});
