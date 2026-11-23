import assert from 'node:assert/strict';
import test from 'node:test';
import { bulbAppearance, candle, effectNamed, normal } from '../../src/domain/effect.ts';
import type { BulbInfo } from '../../src/domain/effect.ts';
import type { LampLight, OnLight } from '../../src/domain/types/light.ts';
import { toBulbId, toColourChannel, toKelvin, toLevel, toSeconds } from '../../src/parse/ids.ts';

const stockBulb: BulbInfo = { bulb: toBulbId('bulb-a1'), firmware: 'stock' };
const candleBulb: BulbInfo = { bulb: toBulbId('bulb-a2'), firmware: 'candle' };
const level = toLevel(120);
const warm = { kind: 'kelvin', kelvin: toKelvin(2500) } as const;
const orange = { kind: 'rgb', rgb: { red: toColourChannel(255), green: toColourChannel(110), blue: toColourChannel(4.5) } } as const;
const transition = { kind: 'scheduled fade', over: toSeconds(30) } as const;
const lit = (effect: OnLight['effect']): OnLight => ({ power: 'on', level, colour: warm, effect, transition });

test('normal shows the light as given', () => {
  for (const bulb of [stockBulb, candleBulb]) {
    assert.deepEqual(normal.appearance(lit(normal), bulb), { power: 'on', level, colour: warm, firmwareEffect: 'none' });
  }
  assert.deepEqual(normal.appearance({ ...lit(normal), colour: orange }, stockBulb),
    { power: 'on', level, colour: orange, firmwareEffect: 'none' });
  assert.equal(normal.canRunOn(stockBulb), true);
  assert.equal(normal.canRunOn(candleBulb), true);
});

test('candle shows the light as given with the firmware candle', () => {
  assert.deepEqual(candle.appearance(lit(candle), candleBulb), { power: 'on', level, colour: warm, firmwareEffect: 'candle' });
  assert.equal(candle.canRunOn(candleBulb), true);
  assert.equal(candle.canRunOn(stockBulb), false);
});

test('a candle lamp shows its normal light on a stock bulb', () => {
  const lamp: LampLight = lit(candle);
  assert.deepEqual(bulbAppearance(lamp, candleBulb), { power: 'on', level, colour: warm, firmwareEffect: 'candle' });
  assert.deepEqual(bulbAppearance(lamp, stockBulb), { power: 'on', level, colour: warm, firmwareEffect: 'none' });
});

test('a normal lamp shows the same on every bulb', () => {
  const lamp: LampLight = lit(normal);
  assert.deepEqual(bulbAppearance(lamp, candleBulb), bulbAppearance(lamp, stockBulb));
});

test('a lamp the schedule names no colour for leaves each bulb its own', () => {
  // Break: a colour is invented for the bulb (white, the warm end) where the lamp has none.
  const lamp: LampLight = { ...lit(candle), colour: undefined };
  assert.deepEqual(bulbAppearance(lamp, candleBulb), { power: 'on', level, colour: undefined, firmwareEffect: 'candle' });
  assert.deepEqual(bulbAppearance(lamp, stockBulb), { power: 'on', level, colour: undefined, firmwareEffect: 'none' });
});

test('an off lamp is off on every bulb', () => {
  const lamp: LampLight = { power: 'off', transition: { kind: 'manual' } };
  assert.deepEqual(bulbAppearance(lamp, candleBulb), { power: 'off' });
  assert.deepEqual(bulbAppearance(lamp, stockBulb), { power: 'off' });
});

test('effectNamed gives each name its effect', () => {
  assert.equal(effectNamed('Candle'), candle);
  assert.equal(effectNamed('Normal'), normal);
  assert.equal(candle.name, 'Candle');
  assert.equal(normal.name, 'Normal');
});
