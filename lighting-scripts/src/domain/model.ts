import type { Block } from './blocks.ts';
import type { Config } from './config.ts';
import type { EffectName } from './effect.ts';
import type { BrightnessPart, ColourPart, EffectPart, ModeOverlay, Overlays } from './overlays.ts';
import type { DashboardControlId, LampId, RemoteId, RoomId, SwitchId } from './types/ids.ts';
import type { Brightness, Colour, PercentRange, Power, SceneLight } from './types/light.ts';
import type { LampOrRoom } from './types/lighting-state.ts';
import type { RemoteCommand } from './types/remote.ts';
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
  /** Saved from the dashboard's range helpers at run time, so Model, not Config. */
  rangeDefaults: RangeDefaults;
  lampProfiles: Record<LampId, Record<Block, LampProfile>>;
  switchProfiles: Record<SwitchId, Record<Block, SwitchProfile>>;
};

/** Which levels of its room a switch is on for: the bright or cosy default range, or its own. */
export type RangeRule = { kind: 'bright' } | { kind: 'cosy' } | { kind: 'custom'; range: PercentRange };

export type RangeDefaults = Record<'bright' | 'cosy', PercentRange>;

/**
 * A lamp's saved light for a block: whether it shows its room's light or its
 * own, and the own light it keeps either way (today's store keeps every field
 * under `own: false`, so owning the light again takes back what was saved).
 */
export type LampProfile = { follows: 'room' | 'own'; own: OwnLight };

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

/**
 * A remote's gesture state, which `update` owns (the gesture reducer moves
 * into the domain): a chord in progress, the burst of power presses counted so
 * far, and the preset button's position. Each window that can close is a
 * deadline, so a `clock` message closes it.
 */
export type RemoteModel = {
  /** The chord that toggles the mode overlay: power, power, left, right, left, right. */
  chord: { active: false } | { active: true; progress: ChordProgress; until: Instant };
  /**
   * A burst of power presses: one is the power toggle, three the reset, when
   * the burst's window closes. `anyOn` is what the room reported at the
   * burst's last press, which the toggle reads when the window closes.
   */
  power: { presses: 0 } | { presses: 1 | 2 | 3; until: Instant; anyOn: boolean };
  /** None pressed yet, or since the last power press. */
  presetButton: PresetButton | undefined;
};

/** The chord's presses so far (today's `chord_step` -1, 1, 2, 3, 4). */
export type ChordProgress = 'power' | 'power power' | 'power power left' | 'power power left right' | 'power power left right left';

/** The preset buttons, warmest last: each stands for one colour temperature (today's `presets` table in gestures.ts). */
export type PresetButton = 'coolest' | 'cool' | 'neutral' | 'warm' | 'warmest';

/** A button pressed on a remote, before the gestures turn it into a command. */
export type RemoteButton =
  | { kind: 'arrow'; direction: 'left' | 'right' | 'up' | 'down' }
  /** Ends a chord in progress. */
  | { kind: 'cancel' }
  | { kind: 'power' }
  /** A preset button; undefined when the press named a temperature not in the table, which only ends a chord. */
  | { kind: 'preset'; button: PresetButton | undefined };

/**
 * Everything that can happen to the Model (Elm's Msg). `at` is when the input
 * arrived: what every overlay it sets is stamped with. The clock's `now` is
 * the instant it reads.
 */
export type Msg =
  | { kind: 'clock'; now: Instant }
  /** The config and the saved profiles read again from the helpers: they replace the Model's; the overlays and the remotes stay. */
  | { kind: 'configChanged'; config: Config; lampProfiles: Model['lampProfiles']; switchProfiles: Model['switchProfiles']; at: Instant }
  | { kind: 'overlayRequested'; request: OverlayRequest; at: Instant }
  /**
   * A person's HA call: every lamp it reaches, and the rooms it named whole (an
   * area, or a group holding every lamp of the room: today's `roomScopes`).
   */
  | { kind: 'lampChangedByPerson'; lamps: readonly LampId[]; rooms: readonly RoomId[]; light: RequestedLight; at: Instant }
  /**
   * A command a remote's gestures (or another caller) send for its room.
   * `anyOn` is whether anything the room's power toggle switches (its lamps,
   * and its switches with a range rule) reports on at the press: what Home
   * Assistant says, read by the adapter, which the toggle goes against when the
   * room has no saved power (today's `targets.some(id => view.get(id) === 'on')`).
   */
  | { kind: 'remotePressed'; remote: RemoteId; command: RemoteCommand; anyOn: boolean; at: Instant }
  /** A raw button press; `at` starts the chord and power-burst windows. `anyOn` as for `remotePressed`. */
  | { kind: 'remoteButtonPressed'; remote: RemoteId; button: RemoteButton; anyOn: boolean; at: Instant }
  | { kind: 'switchButtonPressed'; switch: SwitchId; power: Power; at: Instant }
  | { kind: 'modeToggled'; on: boolean; at: Instant }
  /**
   * A switch's range rule saved from the dashboard. `room` is the room Home
   * Assistant has the switch in: a plug with no on/off label is a switch of the
   * house from its first range save on, in that room.
   */
  | { kind: 'rangeSaved'; switch: SwitchId; rule: RangeRule; room: RoomId | undefined; at: Instant }
  | { kind: 'rangeDefaultsSaved'; defaults: RangeDefaults; at: Instant }
  | { kind: 'lampProfileSaved'; lamp: LampId; block: Block; change: LampProfileChange; at: Instant }
  | { kind: 'switchProfileSaved'; switch: SwitchId; block: Block; change: SwitchProfileChange; at: Instant };

/** An overlay asked for from the dashboard. */
export type OverlayRequest =
  | { kind: 'hold block'; over: RoomOrHouse; block: Block }
  | { kind: 'clear all' }
  /** A control's parts, or its off, on a lamp or room; `update` stamps them and makes the overlay the control's. */
  | { kind: 'dashboard control'; control: DashboardControlId; over: LampOrRoom; light: ControlLight }
  /** A room control's power: switches the room off or on. */
  | { kind: 'room power'; room: RoomId; power: Power };

/**
 * What a dashboard control sets: the lamp or room off (a hold, as a person's
 * off is), or on with the parts it names. Switched on with no part, it ends
 * the off holds there and switches the room on, as a person's plain switch-on does.
 */
export type ControlLight =
  | { power: 'off' }
  | { power: 'on'; brightness: BrightnessPart | undefined; colour: ColourPart | undefined; effect: EffectPart | undefined };

/**
 * What a person's HA call set: off, or on with a brightness, a colour, the
 * candle or the normal light. Switched on with none of them (a plain
 * `turn_on`), it ends the off holds there and switches the room on.
 */
export type RequestedLight =
  | { power: 'off' }
  | { power: 'on'; brightness: Brightness | undefined; colour: Colour | undefined; effect: RequestedEffect | undefined };

/** The effect a person's call can choose: the candle, or the normal light. */
export type RequestedEffect = Extract<EffectPart, { kind: 'candle' } | { kind: 'normal' }>;

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
