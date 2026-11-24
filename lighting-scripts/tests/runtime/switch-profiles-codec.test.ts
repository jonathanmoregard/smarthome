import assert from 'node:assert/strict';
import test from 'node:test';
import { FOLLOWS_ROOM_SWITCH, decodeSwitchProfile, encodeSwitchProfile } from '../../src/adapter/codecs/switch-profiles.ts';
import { decodeModel } from '../../src/adapter/codecs/model.ts';
import { toSwitchId } from '../../src/adapter/codecs/ids.ts';
import { syntheticCatalog, syntheticSource } from './fixtures/synthetic-house.ts';
import type { SwitchProfile } from '../../src/domain/profiles.ts';

/**
 * A plug's own on/off profile for a block: the same `input_text.ls_lamp_<object>_<block>`
 * store a lamp's profile is, read as today's `savedProfile` reads it: `own` by Jinja truthiness
 * (absent is false), `on` absent read as off, otherwise by Home Assistant's `| bool`, and a
 * value that filter rejects read as off. A store that is no mapping follows the room.
 */
const text = (fields: Record<string, unknown>) => JSON.stringify(fields);

test('a store that is not JSON or not a mapping follows the room', () => {
  // Break: garbage raises, or is read as the plug's own setting.
  for (const store of ['', 'unknown', 'unavailable', '{"own":', '[1,2]', '"own"', 'null', '7']) {
    assert.deepEqual(decodeSwitchProfile(store), FOLLOWS_ROOM_SWITCH, store);
  }
});

test('a store that does not own its setting follows the room, by Jinja truthiness, and keeps its own power', () => {
  // Review item 1. Break: a store that follows the room forgets its saved power, so owning it again resets it.
  for (const own of [false, 0, '', [], {}, null]) {
    assert.deepEqual(decodeSwitchProfile(text({ own, on: true })), { follows: 'room', power: 'on' }, JSON.stringify(own));
  }
  assert.deepEqual(decodeSwitchProfile(text({ on: true })), { follows: 'room', power: 'on' });
  assert.deepEqual(decodeSwitchProfile(text({ own: false })), FOLLOWS_ROOM_SWITCH);
});

test('an owned store with no on is off, today\'s savedProfile default (a lamp\'s absent on is on)', () => {
  // Break: the lamp rule (absent is on) is used for a plug.
  assert.deepEqual(decodeSwitchProfile(text({ own: true })), { follows: 'own', power: 'off' });
  assert.deepEqual(decodeSwitchProfile(text({ own: true, on: null })), { follows: 'own', power: 'off' });
});

test('an owned store\'s on is read by Home Assistant\'s bool filter, and a value it rejects is off', () => {
  // Break: on is read by JavaScript or Jinja truthiness ('off' and 'no' would be on), or a rejected value raises or is on.
  for (const on of [true, 'on', 'yes', 'True', 1, ' enable ']) assert.deepEqual(decodeSwitchProfile(text({ own: true, on })), { follows: 'own', power: 'on' }, JSON.stringify(on));
  for (const on of [false, 'off', 'no', 'False', 0, 'disable', 'maybe', [], {}]) assert.deepEqual(decodeSwitchProfile(text({ own: true, on })), { follows: 'own', power: 'off' }, JSON.stringify(on));
});

test('decodeModel reads a plug\'s profile for each block from its own store, and a plug with no store follows the room', () => {
  // Break: a plug reads another plug's store or another block's, or the store of a lamp named like it.
  const source = syntheticSource();
  source.states['input_text.ls_lamp_plug_a_cosy'] = { state: text({ own: true, on: true }), attributes: {} };
  source.states['input_text.ls_lamp_plug_a_night'] = { state: text({ own: true, on: false }), attributes: {} };
  const profiles = decodeModel(source, syntheticCatalog()).switchProfiles[toSwitchId('switch.plug_a')];
  assert.deepEqual(profiles, { day: FOLLOWS_ROOM_SWITCH, cosy: { follows: 'own', power: 'on' }, night: { follows: 'own', power: 'off' } });
});

test('an unchanged switch profile encodes back to the stored text exactly', () => {
  // Break: an unchanged plug's store is rewritten (reformatted, or its other fields dropped).
  for (const stored of ['{"own": true, "on": "yes", "b": 40}', 'unknown', '', '{"own": 0}']) {
    assert.equal(encodeSwitchProfile(decodeSwitchProfile(stored), stored), stored, stored);
  }
});

test('a changed switch profile sets only own and on over the stored fields, as ls_store does', () => {
  // Break: a save drops the store's other fields, or writes a field it did not change.
  const stored = text({ own: false, on: true, b: 40 });
  assert.deepEqual(JSON.parse(encodeSwitchProfile({ follows: 'own', power: 'on' }, stored)), { own: true, on: true, b: 40 });
  assert.deepEqual(JSON.parse(encodeSwitchProfile({ follows: 'room', power: 'off' }, stored)), { own: false, on: false, b: 40 });
});

test('a switch profile written over an empty store decodes back to itself', () => {
  // Break: the written fields do not read back as the profile (an own plug off read as following its room).
  const profiles: SwitchProfile[] = [
    { follows: 'own', power: 'on' }, { follows: 'own', power: 'off' }, { follows: 'room', power: 'on' }, { follows: 'room', power: 'off' },
  ];
  for (const profile of profiles) assert.deepEqual(decodeSwitchProfile(encodeSwitchProfile(profile, '')), profile, JSON.stringify(profile));
});
