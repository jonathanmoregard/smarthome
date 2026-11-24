import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeModel } from '../../src/adapter/codecs/model.ts';
import type { EntityState } from '../../src/adapter/ha-client.ts';
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

test("an open power burst keeps what its room's lamps and range switches report, not another room's", () => {
  // Review item 1: the toggle a burst ends in goes against what the room reports, so a burst read back keeps it.
  // Break: the burst reads every room's lamps, skips the range switches, or keeps a fixed value.
  const burst = (on: readonly string[]) => {
    const source = syntheticSource();
    const states: Record<string, EntityState> = { ...source.states, 'input_number.ls_room-a_remote_power_count': { state: '1.0', attributes: {} },
      'input_text.ls_room-a_remote_power_token': { state: '2026-09-21T14:13:20.000000Z', attributes: {} } };
    for (const entity of on) states[entity] = { state: 'on', attributes: {} };
    const remote = Object.values(decodeModel({ ...source, states }, syntheticCatalog()).remotes)[0];
    return remote === undefined || remote.power.presses === 0 ? undefined : remote.power.anyOn;
  };
  assert.deepEqual([burst([]), burst(['light.lamp_b1']), burst(['light.lamp_a2']), burst(['switch.plug_a'])], [false, false, true, true]);
});
