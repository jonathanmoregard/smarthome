import assert from 'node:assert/strict';
import test from 'node:test';
import { FOLLOWS_ROOM, decodeLampProfile, encodeLampProfile } from '../../src/adapter/codecs/lamp-profiles.ts';
import type { EffectName } from '../../src/domain/effect.ts';
import type { LampProfile } from '../../src/domain/model.ts';
import type { Colour } from '../../src/domain/types/light.ts';
import { toBrightness, toColourChannel, toKelvin } from '../../src/parse/ids.ts';

/**
 * A lamp's saved profile for a block: the `input_text.ls_lamp_<lamp>_<block>`
 * JSON `ls_store` writes (`on`, `own`, `b`, `m` with `k` or `h`/`s`, `effect`,
 * `effect_channels`), read as `ls_base` reads it: `own` by Jinja truthiness,
 * `on` absent read as on, `b` absent read as 255, the effect `Normal light`
 * unless the store says otherwise.
 */
const text = (fields: Record<string, unknown>) => JSON.stringify(fields);
const lit = (brightness: number, colour: Colour | undefined, effect: EffectName = 'Normal'): LampProfile =>
  ({ follows: 'own', light: { power: 'on', brightness: toBrightness(brightness), colour, effect } });

test('a profile store that is not JSON or not a mapping follows the room', () => {
  // Break: a garbage store raises, or is read as the lamp's own light.
  for (const store of ['', 'unknown', 'unavailable', '{"own":', '[1,2]', '"own"', 'null', '7']) {
    assert.deepEqual(decodeLampProfile(store), FOLLOWS_ROOM, store);
    assert.equal(encodeLampProfile(decodeLampProfile(store), store), store, store);
  }
});

test('a profile that does not own its light follows the room, by Jinja truthiness', () => {
  for (const own of [false, 0, '', [], {}, null]) assert.deepEqual(decodeLampProfile(text({ own, b: 90 })), FOLLOWS_ROOM, JSON.stringify(own));
  assert.deepEqual(decodeLampProfile(text({ b: 90 })), FOLLOWS_ROOM);
  assert.equal(decodeLampProfile(text({ own: 'yes', b: 90 })).follows, 'own');
});

test('an off profile has no brightness and no colour', () => {
  // Review Focus 2. Break: an off profile keeps its saved level or colour.
  assert.deepEqual(decodeLampProfile(text({ own: true, on: false, b: 100, m: 'ct', k: 3000, effect: 'Candle' })), { follows: 'own', light: { power: 'off' } });
});

test('a lit profile with no colour has none', () => {
  // Review Focus 2. Break: a colour is invented (white) for a profile that saves none.
  assert.deepEqual(decodeLampProfile(text({ own: true, on: true, b: 120 })), lit(120, undefined));
});

test('a saved Breathe is Normal', () => {
  // Review Focus 1. Break: a removed effect is kept, or read as the candle.
  for (const effect of ['Breathe', 'Colour loop', 'Normal light', 7]) {
    const profile = decodeLampProfile(text({ own: true, b: 120, effect }));
    assert.equal(profile.follows === 'own' && profile.light.power === 'on' ? profile.light.effect : 'none', 'Normal', JSON.stringify(effect));
  }
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 80, effect: 'Candle' })), lit(80, undefined, 'Candle'));
});

test('the saved colour: kelvin in colour-temperature mode, hue and saturation as rgb', () => {
  // Break: the mode is ignored, or hue and saturation are read the wrong way round.
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 200, m: 'ct', k: 2700 })), lit(200, { kind: 'kelvin', kelvin: toKelvin(2700) }));
  const rgb = (red: number, green: number, blue: number) => ({ kind: 'rgb', rgb: { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) } }) as const;
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 200, m: 'hs', h: 120, s: 100 })), lit(200, rgb(0, 255, 0)));
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 200, m: 'hs', h: 30, s: 50 })), lit(200, rgb(255, 191, 128)));
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 200, m: 'ct', k: 'warm' })), lit(200, undefined));
});

test('a brightness the store does not hold is full; one it cannot read is zero, as `| int` reads it', () => {
  assert.deepEqual(decodeLampProfile(text({ own: true })), lit(255, undefined));
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 'bright' })), lit(0, undefined));
  assert.deepEqual(decodeLampProfile(text({ own: true, b: 999 })), lit(255, undefined));
});

test('an unchanged profile encodes back to the stored text exactly', () => {
  // Break: the encoder re-serialises a store it decoded unchanged (key order, spacing, extra fields).
  for (const store of [
    '{"on": true, "own": true, "b": 120, "m": "ct", "k": 2700, "effect": "Normal light", "effect_channels": []}',
    text({ own: true, on: false, b: 3 }),
    text({ own: false, b: 90, note: 'kept' }),
  ]) assert.equal(encodeLampProfile(decodeLampProfile(store), store), store);
});

test('a changed profile writes only the fields it changed, as ls_store does', () => {
  // Break: the change drops a field it did not touch, or keeps an effect's channels after the effect changed.
  const found = text({ on: true, own: true, b: 120, m: 'ct', k: 2700, effect: 'Normal light', effect_channels: [], note: 'kept' });
  assert.deepEqual(JSON.parse(encodeLampProfile(lit(120, { kind: 'kelvin', kelvin: toKelvin(2700) }, 'Candle'), found)),
    { on: true, own: true, b: 120, m: 'ct', k: 2700, effect: 'Candle', effect_channels: ['brightness', 'color'], note: 'kept' });
  assert.deepEqual(JSON.parse(encodeLampProfile(lit(60, { kind: 'kelvin', kelvin: toKelvin(2700) }), found)),
    { on: true, own: true, b: 60, m: 'ct', k: 2700, effect: 'Normal light', effect_channels: [], note: 'kept' });
  assert.deepEqual(JSON.parse(encodeLampProfile(FOLLOWS_ROOM, found)),
    { on: true, own: false, b: 120, m: 'ct', k: 2700, effect: 'Normal light', effect_channels: [], note: 'kept' });
});

test('a profile written over an empty store decodes back to itself', () => {
  // Break: a field is written under a key the decoder does not read.
  const profiles: LampProfile[] = [
    lit(100, undefined, 'Candle'),
    lit(200, { kind: 'kelvin', kelvin: toKelvin(3000) }),
    lit(200, { kind: 'rgb', rgb: { red: toColourChannel(255), green: toColourChannel(0), blue: toColourChannel(0) } }),
    { follows: 'own', light: { power: 'off' } },
  ];
  for (const profile of profiles) assert.deepEqual(decodeLampProfile(encodeLampProfile(profile, '')), profile, JSON.stringify(profile));
});
