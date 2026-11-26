/**
 * A lamp's and a plug's saved profile for each block, as a person saves them
 * from the dashboard, and what a profile makes a lamp or a plug show in a
 * block. Moved from `planStore` in `src/legacy/domain/state-store.ts`: a save
 * sets the fields it names and keeps the saved value of every field it leaves
 * out, the own light included while the lamp follows its room or shows off.
 *
 * Not moved: the effect's stored channel list (`effect_channels`), which the
 * Model does not hold; the codec writes it with the effect.
 */
import type { EffectName } from './effect.ts';
import type { LampId, SwitchId } from './types/ids.ts';
import type { Brightness, Colour, Power, SceneLight } from './types/light.ts';
import type { Block } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/**
 * A lamp's saved light for a block: whether it shows its room's light or its
 * own, and the own light it keeps either way (today's store keeps every field
 * under `own: false`, so owning the light again takes back what was saved).
 */
export type LampProfile = { follows: 'room' | 'own'; own: OwnLight };

/**
 * A lamp's light in a block: its own where its profile for the block says so
 * (off shows no light), else its room's light for the block (`roomLight`).
 */
export function lampLightIn(profile: LampProfile | undefined, roomLight: SceneLight | undefined): SceneLight | undefined {
  if (profile === undefined || profile.follows === 'room') return roomLight;
  return profile.own.power === 'on' ? profile.own.light : { power: 'off' };
}

/** Every lamp's saved profile, for each block. */
export type LampProfiles = Record<LampId, Record<Block, LampProfile>>;

/**
 * A profile's own light: lit, or off remembering the lit light a switch-on
 * takes back (today's store keeps `b`, the colour and the effect under `on:
 * false`). Off shows no level or colour; the remembered light is not shown.
 */
export type OwnLight = { power: 'on'; light: LitLight } | { power: 'off'; remembered: LitLight };

export type LitLight = Extract<SceneLight, { power: 'on' }>;

/**
 * A plug's saved on/off for a block: whether it follows its room's block
 * setting or its own power (on/off only, never a light), which it keeps
 * while it follows its room, as the store keeps `on`.
 */
export type SwitchProfile = { follows: 'room' | 'own'; power: Power };

/** A plug's own on/off for a block, where its profile says it shows its own; undefined where it follows its room. */
export function ownSwitchSetting(profile: SwitchProfile | undefined): boolean | undefined {
  return profile !== undefined && profile.follows === 'own' ? profile.power === 'on' : undefined;
}

/** Every plug's saved on/off, for each block. */
export type SwitchProfiles = Record<SwitchId, Record<Block, SwitchProfile>>;

/**
 * A save from a lamp's profile for one block, as today's `ls_store` takes it:
 * each field the save names, undefined where it leaves the saved one as it is.
 */
export type LampProfileChange = {
  own: boolean | undefined;
  power: Power | undefined;
  brightness: Brightness | undefined;
  colour: Colour | undefined;
  effect: EffectName | undefined;
};

/** A save of a plug's own on/off for one block; undefined leaves the saved field as it is. */
export type SwitchProfileChange = { own: boolean | undefined; power: Power | undefined };

/** A lamp's profile for one block, saved from the dashboard. */
export type LampProfileSaved = { kind: 'lampProfileSaved'; lamp: LampId; block: Block; change: LampProfileChange; at: Instant };

/** A plug's own on/off for one block, saved from the dashboard. */
export type SwitchProfileSaved = { kind: 'switchProfileSaved'; switch: SwitchId; block: Block; change: SwitchProfileChange; at: Instant };

/** A lamp's profile for a block, saved. */
export function lampProfileSaved(profiles: LampProfiles, saved: LampProfileSaved): LampProfiles {
  const kept = profiles[saved.lamp];
  if (kept === undefined) return profiles;
  return { ...profiles, [saved.lamp]: { ...kept, [saved.block]: savedLampProfile(kept[saved.block], saved.change) } };
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
export function switchProfileSaved(profiles: SwitchProfiles, saved: SwitchProfileSaved): SwitchProfiles {
  const kept = profiles[saved.switch];
  if (kept === undefined) return profiles;
  return { ...profiles, [saved.switch]: { ...kept, [saved.block]: savedSwitchProfile(kept[saved.block], saved.change) } };
}

function savedSwitchProfile(saved: SwitchProfile, change: SwitchProfileChange): SwitchProfile {
  return {
    follows: change.own === undefined ? saved.follows : change.own ? 'own' : 'room',
    power: change.power !== undefined ? change.power : saved.power,
  };
}
