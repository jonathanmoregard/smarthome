import type { BulbId } from './types/ids.ts';
import type { Colour, LampLight, Level, OnLight } from './types/light.ts';

export type EffectName = 'Candle' | 'Normal';

/** What a bulb's firmware can do. Read from the catalog's per-bulb `candle` flag for now. */
export type Firmware = 'candle' | 'stock';
export type BulbInfo = { readonly bulb: BulbId; readonly firmware: Firmware };

/** What one bulb shows: its level and colour, and the effect its firmware runs. No colour: the bulb keeps its own. */
export type BulbAppearance = { power: 'off' } | { power: 'on'; level: Level; colour: Colour | undefined; firmwareEffect: 'none' | 'candle' };

export interface Effect {
  readonly name: EffectName;
  canRunOn(bulb: BulbInfo): boolean;
  appearance(light: OnLight, bulb: BulbInfo): BulbAppearance;
}

/** What one bulb of a lamp shows: the lamp's effect where the bulb can run it, the normal light where it cannot. */
export function bulbAppearance(light: LampLight, bulb: BulbInfo): BulbAppearance {
  if (light.power === 'off') return { power: 'off' };
  const effect = light.effect.canRunOn(bulb) ? light.effect : normal;
  return effect.appearance(light, bulb);
}

/** Level and colour as given, no firmware effect; runs on every bulb. */
export const normal: Effect = {
  name: 'Normal',
  canRunOn: () => true,
  appearance: light => ({ power: 'on', level: light.level, colour: light.colour, firmwareEffect: 'none' }),
};

/** Level and colour as given, with the firmware candle; runs on candle firmware only. */
export const candle: Effect = {
  name: 'Candle',
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
