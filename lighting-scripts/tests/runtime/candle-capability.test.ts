import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import { readRuntimeCatalog } from '../../src/main.ts';

/**
 * Candle runs on the bulb's own firmware, so whether a bulb can run it is a
 * fact declared in the catalog (`bulbs.<entity>.candle`); it cannot be derived
 * from the model.
 */

test('the catalog reads each bulb\'s declared candle firmware; absent is not flashed', () => {
  const catalog = parseCatalog({ members: { 'light.a': ['light.a_1'] }, bulbs: { 'light.a_1': { candle: true }, 'light.b_1': {} } });
  assert.deepEqual(catalog.bulbs, { 'light.a_1': { candle: true }, 'light.b_1': { candle: false } });
  assert.deepEqual(parseCatalog({}).bulbs, {});
});

test('a malformed candle flag rejects the catalog', () => {
  assert.throws(() => parseCatalog({ bulbs: { 'light.a_1': { candle: 'yes' } } }), /catalog\.bulbs\.light\.a_1\.candle must be true or false/);
  assert.throws(() => parseCatalog({ bulbs: { 'light.a_1': true } }), /catalog\.bulbs\.light\.a_1 must be an object/);
  assert.throws(() => parseCatalog({ bulbs: [] }), /catalog\.bulbs must be an object/);
});

test('a runtime catalog with a malformed candle flag is refused when it is loaded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lighting-candle-'));
  const path = join(directory, 'catalog.json');
  await writeFile(path, JSON.stringify({ groups: {}, effects: {}, members: {}, bulbs: { 'light.a_1': { candle: 1 } } }));
  await assert.rejects(readRuntimeCatalog(path), /candle must be true or false/);
});
