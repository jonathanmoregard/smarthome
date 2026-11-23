import type { BulbAppearance, BulbInfo, Effect, EffectName } from './types/effect.ts';
import type { LampLight } from './types/light.ts';

export type { BulbAppearance, BulbInfo, Effect, EffectName, Firmware } from './types/effect.ts';

/** What one bulb of a lamp shows: the lamp's effect where the bulb can run it, the normal light where it cannot. */
export function bulbAppearance(light: LampLight, bulb: BulbInfo): BulbAppearance {
  if (light.power === 'off') return { power: 'off' };
  const effect = light.effect.canRunOn(bulb) ? light.effect : normal;
  return effect.appearance(light, bulb);
}

/** Level and colour as given, no firmware effect; runs on every bulb. */
export const normal: Effect = {
  name: 'Normal',
  holdsWarmColour: false,
  ignoresRemoteSteps: false,
  canRunOn: () => true,
  appearance: light => ({ power: 'on', level: light.level, colour: light.colour, firmwareEffect: 'none' }),
};

/** Level and colour as given, with the firmware candle; runs on candle firmware only. */
export const candle: Effect = {
  name: 'Candle',
  holdsWarmColour: true,
  ignoresRemoteSteps: true,
  canRunOn: bulb => bulb.firmware === 'candle',
  appearance: light => ({ power: 'on', level: light.level, colour: light.colour, firmwareEffect: 'candle' }),
};

/** The effect a saved name stands for. The one place a name becomes an effect. */
export function effectNamed(name: EffectName): Effect {
  switch (name) {
    case 'Candle': return candle;
    case 'Normal': return normal;
  }
}
