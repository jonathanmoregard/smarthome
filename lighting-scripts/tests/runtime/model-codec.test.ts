import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeModel } from '../../src/adapter/codecs/model.ts';
import { syntheticCatalog, syntheticHouse, syntheticSource } from './fixtures/synthetic-house.ts';

/**
 * The whole Model read from Home Assistant: the config, the overrides sensor,
 * the remote helpers and the lamp profile stores, each through its codec.
 */
test('the synthetic house decodes from its wire form', () => {
  // Break: any codec reads a stored field into the wrong part of the Model, or decodeModel wires a codec to the
  // wrong store (a remote to another room's helpers, a lamp to another lamp's profile).
  assert.deepEqual(decodeModel(syntheticSource(), syntheticCatalog()), syntheticHouse());
});

test('a remote in no room is idle, whatever another room\'s helpers hold', () => {
  // Break: a roomless remote reads the helpers of a room it is not in.
  const model = decodeModel(syntheticSource(), syntheticCatalog());
  assert.deepEqual(Object.values(model.remotes).map(remote => remote.chord.active), [true, false]);
});
