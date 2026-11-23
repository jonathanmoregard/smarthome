import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRangeDefaults } from '../../src/adapter/codecs/range-defaults.ts';
import type { EntityState } from '../../src/adapter/ha-client.ts';

/**
 * The range defaults codec (Amendment 7.2): the house's bright and cosy
 * ranges from the dashboard's four `input_number.ls_range_<profile>_<end>`
 * helpers, read as today's `switch_lamps_validate_house_defaults` reads them.
 */

const state = (value: string): EntityState => ({ state: value, attributes: {} });

function helpers(changes: Record<string, EntityState | undefined> = {}): Record<string, EntityState> {
  const states: Record<string, EntityState> = {
    'input_number.ls_range_bright_min': state('60.0'),
    'input_number.ls_range_bright_max': state('100.0'),
    'input_number.ls_range_cosy_min': state('5.0'),
    'input_number.ls_range_cosy_max': state('40.0'),
  };
  for (const [entity, value] of Object.entries(changes)) {
    if (value === undefined) delete states[entity]; else states[entity] = value;
  }
  return states;
}

test('both ranges read from their helpers', () => {
  // Break: the ends are swapped, a profile reads the other's helpers, or the text is not read as a number.
  assert.deepEqual(decodeRangeDefaults(helpers()), { bright: { low: 60, high: 100 }, cosy: { low: 5, high: 40 } });
});

test('a range missing a helper, or holding no number, gives no defaults', () => {
  // Break: a missing end reads as 0 or 100, or one good range is saved alone.
  assert.equal(decodeRangeDefaults(helpers({ 'input_number.ls_range_cosy_max': undefined })), undefined);
  assert.equal(decodeRangeDefaults(helpers({ 'input_number.ls_range_bright_min': state('unknown') })), undefined);
  assert.equal(decodeRangeDefaults(helpers({ 'input_number.ls_range_bright_min': state('120') })), undefined);
});

test('a range whose low end is above its high end gives no defaults', () => {
  assert.equal(decodeRangeDefaults(helpers({ 'input_number.ls_range_cosy_min': state('50') })), undefined);
});

test("an empty helper reads as 0, as JavaScript's Number reads it today", () => {
  // Kept as today's adapter read it: `Number('')` is 0. Break: the codec changes what an empty helper means.
  assert.deepEqual(decodeRangeDefaults(helpers({ 'input_number.ls_range_cosy_min': state('') })),
    { bright: { low: 60, high: 100 }, cosy: { low: 0, high: 40 } });
});
