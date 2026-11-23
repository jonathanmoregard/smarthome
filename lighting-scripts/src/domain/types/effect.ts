/** What an effect is, and what a bulb shows under one: the types, with no rule; the effects are in `../effect.ts`. */
import type { BulbId } from './ids.ts';
import type { Colour, Level, OnLight } from './light.ts';

export type EffectName = 'Candle' | 'Normal';

/** What a bulb's firmware can do. Read from the catalog's per-bulb `candle` flag for now. */
export type Firmware = 'candle' | 'stock';
export type BulbInfo = { readonly bulb: BulbId; readonly firmware: Firmware };

/** What one bulb shows: its level and colour, and the effect its firmware runs. No colour: the bulb keeps its own. */
export type BulbAppearance = { power: 'off' } | { power: 'on'; level: Level; colour: Colour | undefined; firmwareEffect: 'none' | 'candle' };

export interface Effect {
  readonly name: EffectName;
  /** The effect brings its own colour, the subject's warm end, unless a colour part set after it says otherwise. */
  readonly holdsWarmColour: boolean;
  /** A remote step does nothing while the effect runs (today's catalog: the candle's `remote_adjustment` is `ignore`). */
  readonly ignoresRemoteSteps: boolean;
  canRunOn(bulb: BulbInfo): boolean;
  appearance(light: OnLight, bulb: BulbInfo): BulbAppearance;
}
