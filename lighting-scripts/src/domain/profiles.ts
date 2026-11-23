/**
 * A lamp's and a plug's saved profile for each block, as a person saves them
 * from the dashboard. Moved from `planStore` in
 * `src/legacy/domain/state-store.ts`: a save sets the fields it names and
 * keeps the saved value of every field it leaves out, the own light included
 * while the lamp follows its room or shows off.
 *
 * Not moved: the effect's stored channel list (`effect_channels`), which the
 * Model does not hold; the codec writes it with the effect.
 */
import type { Block } from './blocks.ts';
import type { LampProfile, LampProfileChange, LitLight, Model, SwitchProfile, SwitchProfileChange } from './model.ts';
import type { LampId, SwitchId } from './types/ids.ts';

/** A lamp's profile for a block, saved. */
export function lampProfileSaved(model: Model, lamp: LampId, block: Block, change: LampProfileChange): Model {
  const saved = model.lampProfiles[lamp];
  if (saved === undefined) return model;
  return { ...model, lampProfiles: { ...model.lampProfiles, [lamp]: { ...saved, [block]: savedLampProfile(saved[block], change) } } };
}

export function savedLampProfile(saved: LampProfile, change: LampProfileChange): LampProfile {
  const follows = change.own === undefined ? saved.follows : change.own ? 'own' : 'room';
  const was = saved.own.power === 'on' ? saved.own.light : saved.own.remembered;
  const light: LitLight = {
    power: 'on',
    brightness: change.brightness !== undefined ? change.brightness : was.brightness,
    colour: change.colour !== undefined ? change.colour : was.colour,
    effect: change.effect !== undefined ? change.effect : was.effect,
  };
  const power = change.power !== undefined ? change.power : saved.own.power;
  return { follows, own: power === 'on' ? { power: 'on', light } : { power: 'off', remembered: light } };
}

/** A plug's own on/off for a block, saved. */
export function switchProfileSaved(model: Model, plug: SwitchId, block: Block, change: SwitchProfileChange): Model {
  const saved = model.switchProfiles[plug];
  if (saved === undefined) return model;
  return { ...model, switchProfiles: { ...model.switchProfiles, [plug]: { ...saved, [block]: savedSwitchProfile(saved[block], change) } } };
}

function savedSwitchProfile(saved: SwitchProfile, change: SwitchProfileChange): SwitchProfile {
  return {
    follows: change.own === undefined ? saved.follows : change.own ? 'own' : 'room',
    power: change.power !== undefined ? change.power : saved.power,
  };
}
