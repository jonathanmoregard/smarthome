import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import type { JsonValue } from '../../src/runtime/context.ts';
import { nativeHandlers } from '../../src/handlers/native-controls.ts';

/**
 * A dashboard control on a schedule profile light (`light.ls_*`) becomes one
 * `light.turn_on` with the value checked, then converted: brightness is
 * `value | int` after a 0..255 check, temperature `1000000 / value` rounded
 * half to even after a 100..1000 mired check. A value outside its check is an
 * error and no command.
 */
const catalog = { groups: {}, members: {}, effects: {} };
function control(attribute: string, value: JsonValue): { valid: boolean; data: JsonValue | undefined; errors: JsonValue } {
  const snapshot = { now: '2026-10-26T12:00:00+01:00', members: [], areas: {},
    state: { 'input_text.ls_house_day': { state: '{}', attributes: {} } } };
  const { result } = execute({ script: 'effects_set', snapshot, args: { source: 'light.ls_house_day', attribute, value, dry_run: true } },
    { ...nativeHandlers, effects_catalog: () => catalog });
  const r = result as { valid: boolean; errors: JsonValue; commands: { data: JsonValue }[] };
  return { valid: r.valid, data: r.commands[0]?.data, errors: r.errors };
}

test('a profile light brightness control sends the whole brightness it checked', () => {
  assert.deepEqual(control('brightness', 0).data, { brightness: 0 });
  assert.deepEqual(control('brightness', 255).data, { brightness: 255 });
  assert.deepEqual(control('brightness', 127.9).data, { brightness: 127 });
  assert.deepEqual(control('brightness', '200.5').data, { brightness: 200 });
  assert.deepEqual(control('brightness', true).data, { brightness: 1 });
  for (const bad of [256, 255.5, -0.5, 'dim', null]) {
    assert.deepEqual(control('brightness', bad), { valid: false, data: undefined, errors: ['Brightness must be 0–255.'] });
  }
});

test('a profile light temperature control sends the mireds it checked, in kelvin', () => {
  assert.deepEqual(control('temperature', 100).data, { color_temp_kelvin: 10000 });
  assert.deepEqual(control('temperature', 1000).data, { color_temp_kelvin: 1000 });
  assert.deepEqual(control('temperature', 333).data, { color_temp_kelvin: 3003 });
  assert.deepEqual(control('temperature', '400').data, { color_temp_kelvin: 2500 });
  for (const bad of [99, 1000.5, 'warm', null]) {
    assert.deepEqual(control('temperature', bad), { valid: false, data: undefined, errors: ['Temperature must be 100–1000 mireds.'] });
  }
});
