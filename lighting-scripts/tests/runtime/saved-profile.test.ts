import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../src/runtime/context.ts';
import { savedProfile } from '../../src/parse/schedule.ts';
import { house } from './house-view.ts';

// ls_base reads a saved lamp profile's ownership as the captured
// `lp.get('own', false)` (and `(... | from_json(default={})).get('own', false)`),
// used as a condition: Jinja truthiness, absent read as false. A plug's power
// is `lj.get('on', false) | bool`: Home Assistant's bool filter, absent read as
// false; a value the filter rejects is off (lenient saved-value directive,
// 2026-11-19), where the captured filter raises.
const entity = 'input_text.ls_lamp_plug_day';
const profile = (fields: Record<string, JsonValue>) => savedProfile(house({ [entity]: JSON.stringify(fields) }), entity);

test('a saved profile owns its light by Jinja truthiness, absent read as false', () => {
  assert.equal(profile({}).own, false);
  for (const value of [true, 1, 'yes', 'false', [0], { a: 1 }] as JsonValue[]) assert.equal(profile({ own: value }).own, true, JSON.stringify(value));
  for (const value of [false, 0, '', [], {}, null] as JsonValue[]) assert.equal(profile({ own: value }).own, false, JSON.stringify(value));
});

test("a saved plug's power reads through Home Assistant's bool filter, absent read as false", () => {
  assert.equal(profile({}).on, false);
  for (const value of [true, 1, 'on', 'TRUE', ' yes ', '1', 'enable'] as JsonValue[]) {
    assert.equal(profile({ on: value }).on, true, JSON.stringify(value));
  }
  for (const value of [false, 0, 'off', 'no', '0', 'disable'] as JsonValue[]) {
    assert.equal(profile({ on: value }).on, false, JSON.stringify(value));
  }
});

test("a saved plug's power the bool filter rejects is off, never a raise", () => {
  for (const value of [null, 'maybe', [], {}] as JsonValue[]) {
    assert.equal(profile({ on: value }).on, false, JSON.stringify(value));
  }
});
