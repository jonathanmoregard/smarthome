import type { Block } from './blocks.ts';
import type { DashboardControlId, LampId, RemoteSource, RoomId, SwitchId } from './types/ids.ts';
import type { Brightness, Colour, Power } from './types/light.ts';
import type { Step, StepCount } from './types/remote.ts';
import type { RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

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
  source: RemoteSource;
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

export type LampOverlay = {
  over: { kind: 'lamp'; lamp: LampId } | { kind: 'room'; room: RoomId };
  /** A person's HA change (one per lamp or room), or a dashboard control (one per control). */
  from: { kind: 'person' } | { kind: 'dashboard'; control: DashboardControlId };
  since: Instant;
  /** Undefined: this overlay leaves brightness alone. */
  brightness: BrightnessOverlay | undefined;
  /** Undefined: this overlay leaves colour alone. */
  colour: ColourOverlay | undefined;
};

/** `at` is when this part was last set (the stored per-channel `updated`): the newest part wins per lamp. */
export type BrightnessOverlay =
  | { kind: 'fixed'; brightness: Brightness; at: Instant }
  /** The candle. `runsAt` is the brightness it runs at (stored `intensity`, else the fixed value kept underneath). */
  | { kind: 'candle'; runsAt: Brightness | undefined; at: Instant }
  /** Back to the schedule's brightness, over any older overlay. */
  | { kind: 'schedule'; at: Instant };

export type ColourOverlay =
  | { kind: 'fixed'; colour: Colour; at: Instant }
  /** The candle's warm colour. */
  | { kind: 'candle'; at: Instant }
  /** Back to the schedule's colour, over any older overlay. */
  | { kind: 'schedule'; at: Instant };

/** The mode overlay: one colour on every lamp outside private rooms and outside the night block. */
export type ModeOverlay = { active: false } | { active: true; since: Instant };
