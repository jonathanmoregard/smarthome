/**
 * A lamp's and a plug's saved profile for each block, as a person saves them
 * from the dashboard. Moved from `planStore` in
 * `src/legacy/domain/state-store.ts`: a save sets the fields it names and
 * keeps the saved value of every field it leaves out.
 *
 * Not moved: the effect's stored channel list (`effect_channels`), which the
 * Model does not hold; the codec writes it with the effect.
 */
import type { Block } from './blocks.ts';
import type { LampProfile, LampProfileChange, Model, SwitchProfile, SwitchProfileChange } from './model.ts';
import type { LampId, SwitchId } from './types/ids.ts';
import type { Brightness, SceneLight } from './types/light.ts';
import { brightnessOrThrow } from './types/range.ts';

/**
 * A lamp's profile for a block, saved. A profile that follows its room holds
 * no light of its own, so owning one again with a field left out takes the
 * value a store with that field missing reads as: on, {@link FULL}, no
 * colour, the normal light (today the store keeps the light it had).
 */
export function lampProfileSaved(model: Model, lamp: LampId, block: Block, change: LampProfileChange): Model {
  const saved = model.lampProfiles[lamp];
  if (saved === undefined) return model;
  return { ...model, lampProfiles: { ...model.lampProfiles, [lamp]: { ...saved, [block]: savedLampProfile(saved[block], change) } } };
}

/** A lit store with no brightness: today's `pr.get('b', 255)`. */
const FULL: Brightness = brightnessOrThrow(255);

function savedLampProfile(saved: LampProfile, change: LampProfileChange): LampProfile {
  const own = change.own !== undefined ? change.own : saved.follows === 'own';
  if (!own) return { follows: 'room' };
  const light: SceneLight | undefined = saved.follows === 'own' ? saved.light : undefined;
  const on = change.power !== undefined ? change.power === 'on' : light === undefined || light.power === 'on';
  if (!on) return { follows: 'own', light: { power: 'off' } };
  const lit = light !== undefined && light.power === 'on' ? light : undefined;
  return {
    follows: 'own',
    light: {
      power: 'on',
      brightness: change.brightness !== undefined ? change.brightness : lit === undefined ? FULL : lit.brightness,
      colour: change.colour !== undefined ? change.colour : lit?.colour,
      effect: change.effect !== undefined ? change.effect : lit === undefined ? 'Normal' : lit.effect,
    },
  };
}

/**
 * A plug's own on/off for a block, saved. One that follows its room holds no
 * power of its own, so owning one again with the power left out is off, as a
 * store with no `on` reads for a plug.
 */
export function switchProfileSaved(model: Model, plug: SwitchId, block: Block, change: SwitchProfileChange): Model {
  const saved = model.switchProfiles[plug];
  if (saved === undefined) return model;
  return { ...model, switchProfiles: { ...model.switchProfiles, [plug]: { ...saved, [block]: savedSwitchProfile(saved[block], change) } } };
}

function savedSwitchProfile(saved: SwitchProfile, change: SwitchProfileChange): SwitchProfile {
  const own = change.own !== undefined ? change.own : saved.follows === 'own';
  if (!own) return { follows: 'room' };
  const power = change.power !== undefined ? change.power : saved.follows === 'own' ? saved.power : 'off';
  return { follows: 'own', power };
}
