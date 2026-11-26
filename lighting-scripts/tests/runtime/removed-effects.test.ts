import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { JsonObject } from '../../src/adapter/ha-client.ts';

/**
 * Breathe and Colour loop are gone (spec 1.1.1). The lamps run Candle and
 * their normal light; a saved profile that still names one of the removed
 * effects shows the normal light instead of failing (the codec tests).
 */

const catalogDocument: JsonObject = {
  effects: { Candle: { channels: ['brightness', 'color'] }, Breathe: { channels: ['brightness'] }, 'Colour loop': { channels: ['color'] },
    'Normal light': { channels: [] } },
  members: { 'light.lamp': ['light.bulb', 'light.second', 'light.off'] },
  topics: { 'light.bulb': 'z2m/bulb/set', 'light.second': 'z2m/second/set', 'light.off': 'z2m/off/set' }, multicast: [],
};
test('the catalog parse drops Breathe and Colour loop, from the effects and from the UI choices', () => {
  const parsed = parseCatalog({ ...catalogDocument, ui_choices: ['Candle', 'Breathe', 'Colour loop', 'Normal light'] });
  assert.deepEqual(Object.keys(parsed.effects), ['Candle', 'Normal light']);
  assert.deepEqual(parsed.ui_choices, ['Candle', 'Normal light']);
});
