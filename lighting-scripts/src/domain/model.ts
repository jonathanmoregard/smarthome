import type { Block } from './blocks.ts';
import type { Config } from './config.ts';
import type { EffectName } from './effect.ts';
import type { LampOverlay, ModeOverlay, Overlays } from './overlays.ts';
import type { LampId, RemoteId, SwitchId } from './types/ids.ts';
import type { Brightness, Colour, PercentRange, Power, SceneLight } from './types/light.ts';
import type { Ranged } from './types/range.ts';
import type { RemotePress, Step } from './types/remote.ts';
import type { RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/**
 * Everything the lighting state is derived from: the config, the overlays and
 * the saved settings people make from the dashboard and remotes (Elm's Model).
 */
export type Model = {
  config: Config;
  overlays: Overlays;
  modeOverlay: ModeOverlay;
  remotes: Record<RemoteId, RemoteModel>;
  switchRanges: Record<SwitchId, RangeRule>;
  rangeDefaults: RangeDefaults;
  lampProfiles: Record<LampId, Record<Block, LampProfile>>;
};

/** Which levels of its room a switch is on for: the bright or cosy default range, or its own. */
export type RangeRule = { kind: 'bright' } | { kind: 'cosy' } | { kind: 'custom'; range: PercentRange };

export type RangeDefaults = Record<'bright' | 'cosy', PercentRange>;

/** A lamp's saved light for a block: the room's, or its own (whose effect its light names). */
export type LampProfile = { follows: 'room' } | { follows: 'own'; light: SceneLight };

/** A remote's press state: a chord in progress, the power presses counted so far, and the preset button's position. */
export type RemoteModel = {
  chord: { active: false } | { active: true; step: Step };
  /** Whole, 0 and up. */
  powerPresses: Ranged<'PowerPresses'>;
  /** None pressed yet. */
  presetButton: PresetButton | undefined;
};

/** The preset buttons, warmest last: each stands for one colour temperature (today's `presets` table in gestures.ts). */
export type PresetButton = 'coolest' | 'cool' | 'neutral' | 'warm' | 'warmest';

/** Everything that can happen to the Model (Elm's Msg). */
export type Msg =
  | { kind: 'clock'; now: Instant }
  | { kind: 'configChanged'; config: Config }
  | { kind: 'overlayRequested'; request: OverlayRequest }
  | { kind: 'lampChangedByPerson'; lamps: readonly LampId[]; light: RequestedLight }
  | { kind: 'remotePressed'; remote: RemoteId; press: RemotePress }
  | { kind: 'switchButtonPressed'; switch: SwitchId; power: Power }
  | { kind: 'modeToggled'; on: boolean }
  | { kind: 'rangeSaved'; switch: SwitchId; rule: RangeRule }
  | { kind: 'lampProfileSaved'; lamp: LampId; block: Block; profile: LampProfile };

/** An overlay asked for from the dashboard. */
export type OverlayRequest =
  | { kind: 'hold block'; over: RoomOrHouse; block: Block }
  | { kind: 'clear all' }
  | { kind: 'dashboard control'; overlay: Omit<LampOverlay, 'since'> };

/** What a person's HA call set: a brightness, a colour, the candle, or back to the normal light. At least one part is present. */
export type RequestedLight = { brightness: Brightness | undefined; colour: Colour | undefined; effect: EffectName | undefined };
