import type { Block } from './blocks.ts';
import type { Config } from './config.ts';
import type { EffectName } from './effect.ts';
import type { DashboardControlId, LampId, RemoteId, RoomId, SwitchId } from './types/ids.ts';
import type { Brightness, BrightnessStep, Colour, PercentRange, Power, SceneLight } from './types/light.ts';
import type { LampOrRoom } from './types/lighting-state.ts';
import type { RemoteCommand, Step, StepCount } from './types/remote.ts';
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

/**
 * The overlays: what people, remotes and the dashboard hold over the schedule,
 * until an overlay reset removes them. Every field is one today's overlay flow
 * reads; the comments name the stored field it comes from.
 */
export type Overlays = {
  /** A block held over a room or the house: at most one each. */
  blocks: Partial<Record<RoomOrHouse, BlockOverlay>>;
  /** Each remote's input for its room. Only the newest one per room applies. */
  remotes: readonly RemoteOverlay[];
  /** A light or the candle set on a lamp or a room by a person or from the dashboard. */
  lamps: readonly LampOverlay[];
  /** A room switched off or on. A room not listed is on. */
  roomPower: Partial<Record<RoomId, Power>>;
  /** A switch held on or off by a press on its own button: at most one each (decision 8). */
  switches: Partial<Record<SwitchId, SwitchOverlay>>;
};

/** Holds the switch over its range rule and its block until a reset removes it. New: no stored field today. */
export type SwitchOverlay = { power: Power; since: Instant };

/** `since` is when the overlay was last set (stored `when`): what the next-block and after-age resets measure. */
export type BlockOverlay = { block: Block; since: Instant };

export type RemoteOverlay = {
  /** The key: one overlay per remote. */
  remote: RemoteId;
  /** Stored `target`. */
  room: RoomId;
  /** Stored `when`. */
  since: Instant;
  /** Stored `step_range`; default -20..20. */
  stepRange: StepRange;
  /** Brighter and dimmer; none before the first such press. */
  adjustment: RemoteAdjustment | undefined;
  /** What the left and right arrows chose. */
  preset: RemotePreset;
  /** What each preset held when the remote last left it (stored `preset_contexts`), restored on return. */
  remembered: Partial<Record<PresetChoice, RememberedPreset>>;
};

/** `min` not above `max`. */
export type StepRange = { readonly min: Step; readonly max: Step };

export type RemoteAdjustment = {
  /** Net presses; positive is brighter. */
  steps: StepCount;
  /** How far the presses may still go each way. */
  lower: Step;
  upper: Step;
  /** Where on the blend step zero sits (stored `anchor`). */
  from: 'day' | 'cosy' | 'current';
  /** Stored `updated`: orders it against other overlays. */
  at: Instant;
  lastPress: 'up' | 'down' | undefined;
  /** Stored `has_up`: the dim-below-cosy rule reads it. */
  everBrighter: boolean;
};

export type PresetChoice = 'day' | 'cosy' | 'candle';

export type RemotePreset =
  | { choice: 'none' }
  /** Day or cosy: holds that block for the room, like a block overlay (stored `period`, `period_updated`). */
  | { choice: 'day' | 'cosy'; since: Instant }
  /**
   * The candle on the room's lamps; `adjustment` is the brightness input it
   * started from (stored `selection_input`), `since` is stored `selection_updated`.
   * `block` is the day or cosy block the remote held when it moved onto the
   * candle, which it keeps holding (stored `period`, `period_updated`); none
   * when it came from no preset.
   */
  | { choice: 'candle'; since: Instant; adjustment: RemoteAdjustment | undefined; block: HeldBlock | undefined };

/** A block a remote preset holds for the room, and since when (stored `period`, `period_updated`). */
export type HeldBlock = { block: 'day' | 'cosy'; since: Instant };

export type RememberedPreset = Exclude<RemotePreset, { choice: 'none' }>;

/**
 * A lamp or a room held by a person or from the dashboard: part by part, or
 * switched off.
 *
 * Part by part, each part is undefined when this overlay leaves it alone. The
 * effect is a part of its own: a newer level or colour hold on a candle lamp
 * keeps the candle running at the new level or colour, and only a newer effect
 * part ends it.
 *
 * Off (owner, 2026-11-23: a person's off in HA is a hold) holds the lamp or
 * room off from `since` until a newer part or remote step, from anyone, or an
 * overlay reset. It has no level, colour or effect, and never switches the room's power.
 */
export type LampOverlay =
  | {
    kind: 'parts';
    over: LampOrRoom;
    from: LampOverlayFrom;
    since: Instant;
    brightness: BrightnessOverlay | undefined;
    colour: ColourOverlay | undefined;
    effect: EffectOverlay | undefined;
  }
  | { kind: 'off'; over: LampOrRoom; from: LampOverlayFrom; since: Instant };

/** A person's HA change (one per lamp or room), or a dashboard control (one per control). */
export type LampOverlayFrom = { kind: 'person' } | { kind: 'dashboard'; control: DashboardControlId };

/** `at` is when this part was last set (the stored per-channel `updated`): the newest part of each kind wins per lamp. */
export type BrightnessOverlay = BrightnessPart & { at: Instant };

export type ColourOverlay = ColourPart & { at: Instant };

export type EffectOverlay = EffectPart & { at: Instant };

/** A brightness: fixed, or back to the schedule's over any older overlay. */
export type BrightnessPart = { kind: 'fixed'; brightness: Brightness } | { kind: 'schedule' };

/** A colour: fixed, or back to the schedule's over any older overlay. */
export type ColourPart = { kind: 'fixed'; colour: Colour } | { kind: 'schedule' };

/**
 * The candle, at whatever level and colour the other parts give; the normal
 * light, over a block's candle too; or back to the effect the schedule's light names.
 */
export type EffectPart = { kind: 'candle' } | { kind: 'normal' } | { kind: 'schedule' };

/** The mode overlay: one colour on every lamp outside private rooms and outside the night block. */
export type ModeOverlay = { active: false } | { active: true; since: Instant };

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
  | { power: 'on'; brightness: RequestedBrightness | undefined; colour: Colour | undefined; effect: RequestedEffect | undefined };

/**
 * A person's brightness: a fixed level, or a step that moves each lamp the
 * call reaches from the level that lamp shows (off counts as 0).
 */
export type RequestedBrightness = { kind: 'fixed'; brightness: Brightness } | { kind: 'step'; by: BrightnessStep };

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
