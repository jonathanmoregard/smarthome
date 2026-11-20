import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { context } from './gestures-context.ts';

/**
 * `ls_commit` reads of saved `sensor.ls_overrides` / `sensor.ls_effects_runtime`
 * attributes (round-4 sweeps). Captured expressions:
 *
 * - `old != (state_attr('sensor.ls_effects_runtime','handled_full') or none)`:
 *   Python `!=`, which compares containers by value.
 * - `previous.get('kind') in ['constant','scale']`: a list kind is in neither.
 * - affected rooms `[item.target for item in [previous, record] if
 *   item.get('scope')=='room']`, then `dict(pending, **{room: stamp})`, which
 *   raises on a non-text room; for the saved `previous` that is the lenient
 *   saved-value directive's case: a saved record whose room target is not text
 *   marks no room.
 */
function committed(attributes: JsonObject, data: JsonObject, runtime: JsonObject = {}): JsonObject {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', attributes);
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  ctx.put('sensor.ls_effects_runtime', '0', runtime);
  ctx.run('ls_commit', { data });
  return ctx.calls.find(c => c.service === 'variable.update_sensor')!.data.attributes as JsonObject;
}

test('a handled full render is compared by value: equal containers are handled, the old lights dropped', () => {
  const attributes = committed({ overrides: {}, full_version: { v: [1] }, full_lights: ['light.old'] },
    { op: 'set', records: [], lights: ['light.new'] }, { handled_full: { v: [1] } });
  assert.deepEqual(attributes.full_lights, ['light.new']);
});

test("a saved claim whose kind is a one-element list is neither constant nor scale: it is no effect's underlying", () => {
  const previous = { kind: ['constant'], level: 5 };
  const attributes = committed(
    { overrides: { 'channels:lamp': { kind: 'channels', scope: 'lamp', target: 'light.a', value: { channels: { brightness: previous } } } } },
    { op: 'set', records: [{ key: 'channels:lamp', kind: 'channels', scope: 'lamp', target: 'light.a',
      value: { channels: { brightness: { kind: 'effect', name: 'Candle' } } } }] });
  const claim = (((attributes.overrides as JsonObject)['channels:lamp'] as JsonObject).value as JsonObject).channels as JsonObject;
  assert.deepEqual(claim.brightness, { kind: 'effect', name: 'Candle' });
});

test('a saved record whose room target is not text marks no room pending, never a raise', () => {
  for (const target of [5, null, ['studio'], undefined]) {
    const saved: JsonObject = { kind: 'channels', scope: 'room' };
    if (target !== undefined) saved.target = target;
    const attributes = committed({ overrides: { 'channels:x': saved } },
      { op: 'set', via: 'remote', records: [{ key: 'channels:x', kind: 'channels', scope: 'room', target: 'studio', value: {} }] });
    assert.deepEqual(Object.keys(attributes.pending_rooms as JsonObject), ['studio'], JSON.stringify(target));
  }
});
