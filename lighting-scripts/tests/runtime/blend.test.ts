import assert from 'node:assert/strict';
import test from 'node:test';
import { blend, mixColour } from '../../src/domain/blend.ts';
import type { EffectName } from '../../src/domain/effect.ts';
import type { Colour, RGB, SceneLight } from '../../src/domain/types/light.ts';
import { blendPositionOrThrow } from '../../src/domain/types/range.ts';
import { toBrightness, toColourChannel, toKelvin, toProgress } from '../../src/parse/ids.ts';

/**
 * The cosy-day blend on the new types: 0 at cosy, 1 at day, beyond both
 * within -2..2. Moved from `src/legacy/domain/scale.ts` (`blend`,
 * `scaleValue`) with `compileGradient` and `sampleGradient` folded in, which
 * computed the same curve. The flow cases of `off-lamp-blend.test.ts` are
 * carried here; the level is now whole, rounded half to even as the sent
 * level always was.
 */

const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const rgb = (red: number, green: number, blue: number): RGB =>
  ({ red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) });
const lit = (brightness: number, colour: Colour | undefined, effect: EffectName = 'Normal'): SceneLight =>
  ({ power: 'on', brightness: toBrightness(brightness), colour, effect });
const OFF: SceneLight = { power: 'off' };
const WARM_END = rgb(255, 126, 0);
const at = (position: number) => blendPositionOrThrow(position);

const DAY = lit(200, kelvin(4000)), COSY = lit(80, kelvin(2200));

test('a blend with an off end takes its colour from the lit end', () => {
  // Carried from off-lamp-blend.test.ts (2026-11-20): off at the off end and past it, up from 1 in the lit end's colour.
  assert.deepEqual(blend(DAY, OFF, at(0), WARM_END), OFF);
  assert.deepEqual(blend(DAY, OFF, at(-0.5), WARM_END), OFF);
  assert.deepEqual(blend(DAY, OFF, at(0.125), WARM_END), lit(26, kelvin(4000)));
  assert.deepEqual(blend(DAY, OFF, at(0.5), WARM_END), lit(100, kelvin(4000)));
  assert.deepEqual(blend(DAY, OFF, at(1), WARM_END), DAY);
  // Past the lit day end the above-day rule applies unchanged.
  assert.deepEqual(blend(DAY, OFF, at(1.5), WARM_END), lit(228, kelvin(5250)));
  // The mirror image: off at the day end and past it.
  assert.deepEqual(blend(OFF, COSY, at(1), WARM_END), OFF);
  assert.deepEqual(blend(OFF, COSY, at(1.5), WARM_END), OFF);
  assert.deepEqual(blend(OFF, COSY, at(0.875), WARM_END), lit(11, kelvin(2200)));
  assert.deepEqual(blend(OFF, COSY, at(0.5), WARM_END), lit(40, kelvin(2200)));
  assert.deepEqual(blend(OFF, COSY, at(0), WARM_END), COSY);
  // Below the lit cosy end the below-cosy rule applies, the off day end reading as level 1.
  assert.deepEqual(blend(OFF, COSY, at(-0.5), WARM_END), lit(79, kelvin(2075)));
});

test('a blend of two off ends is nothing', () => {
  // Break: two off ends give an off light, so the remote would switch the lamp instead of skipping it.
  assert.equal(blend(OFF, OFF, at(0.5), WARM_END), undefined);
});

test('a lit end with no colour gives no blend', () => {
  // Carried from off-lamp-blend.test.ts: a colourless end is no anchor, never a white one.
  assert.equal(blend(lit(200, undefined), COSY, at(0.5), WARM_END), undefined);
  assert.equal(blend(lit(200, undefined), OFF, at(0.5), WARM_END), undefined);
  assert.equal(blend(OFF, lit(80, undefined), at(0.5), WARM_END), undefined);
});

test('two lit ends blend as the scale and the gradient always have', () => {
  // Break: a changed branch of the curve, or JavaScript's rounding replacing Python's.
  assert.deepEqual(blend(DAY, COSY, at(0.5), WARM_END), lit(140, kelvin(3100)));
  assert.deepEqual(blend(lit(220, kelvin(4000)), lit(110, kelvin(2200)), at(0.5), WARM_END), lit(165, kelvin(3100)));
  assert.deepEqual(blend(DAY, COSY, at(0), WARM_END), COSY);
  assert.deepEqual(blend(DAY, COSY, at(1), WARM_END), DAY);
  // Below cosy: down to the floor of 76.5 and warmer towards 1950 K.
  assert.deepEqual(blend(DAY, COSY, at(-0.5), WARM_END), lit(76, kelvin(2075)));
  // Above day: brighter towards 255 and cooler towards 6500 K.
  assert.deepEqual(blend(DAY, COSY, at(1.5), WARM_END), lit(228, kelvin(5250)));
  // RGB ends mix channel by channel, halves to even; past -1 the colour runs from the crossover to the warm end.
  const day = lit(220, { kind: 'rgb', rgb: rgb(10, 21, 30) }), cosy = lit(20, { kind: 'rgb', rgb: rgb(1, 2, 3) });
  assert.deepEqual(blend(day, cosy, at(0.5), WARM_END), lit(120, { kind: 'rgb', rgb: rgb(6, 12, 16) }));
  assert.deepEqual(blend(day, cosy, at(-2), WARM_END), lit(20, { kind: 'rgb', rgb: WARM_END }));
  assert.deepEqual(blend(day, cosy, at(-2), rgb(200, 0, 0)), lit(20, { kind: 'rgb', rgb: rgb(200, 0, 0) }));
});

test('the blend runs the effect of the end it is nearer', () => {
  // Break: a candle cosy end puts the candle on the lamp at day, or a lit end's effect is lost beside an off end.
  const candleCosy = lit(80, kelvin(2200), 'Candle');
  assert.equal(effectOf(blend(DAY, candleCosy, at(0.25), WARM_END)), 'Candle');
  assert.equal(effectOf(blend(DAY, candleCosy, at(0.75), WARM_END)), 'Normal');
  assert.equal(effectOf(blend(OFF, candleCosy, at(0.75), WARM_END)), 'Candle');
});

test('two colour temperatures mix in kelvin, anything else in RGB', () => {
  // Break: a kelvin and an RGB end are mixed as numbers of different kinds.
  assert.deepEqual(mixColour(kelvin(2000), kelvin(3000), toProgress(0.25)), kelvin(2250));
  assert.deepEqual(mixColour(kelvin(6600), { kind: 'rgb', rgb: rgb(255, 255, 255) }, toProgress(0)), kelvin(6600));
  assert.deepEqual(mixColour(kelvin(6600), { kind: 'rgb', rgb: rgb(255, 255, 255) }, toProgress(0.5)), { kind: 'rgb', rgb: rgb(255, 255, 255) });
  assert.deepEqual(mixColour({ kind: 'rgb', rgb: rgb(0, 0, 0) }, kelvin(1000), toProgress(0.5)), { kind: 'rgb', rgb: rgb(128, 34, 0) });
});

function effectOf(light: SceneLight | undefined): EffectName | undefined {
  return light === undefined || light.power === 'off' ? undefined : light.effect;
}
