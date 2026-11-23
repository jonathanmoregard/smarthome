import type { BulbInfo } from './effect.ts';
import type { DashboardControlId, LampId, LampOrRoom, RemoteId, RoomId, SwitchId } from './types/ids.ts';
import type { RGB, SceneLight } from './types/light.ts';
import type { Minutes } from './types/range.ts';
import type { Instant, TimeOfDay, Timezone } from './types/time.ts';
import type { Block } from './types/schedule.ts';

/**
 * The config: what the house is and how its schedule runs, as the helpers and
 * the catalog say. People change it from the dashboard; the lighting reads it
 * and never writes it.
 */
export type Config = {
  timezone: Timezone;
  house: Schedule;
  rooms: Record<RoomId, Room>;
  lamps: Record<LampId, Lamp>;
  switches: Record<SwitchId, Switch>;
  remotes: Record<RemoteId, Remote>;
  overlayReset: OverlayReset;
  /** The dashboard's live controls, in the catalog's order, each over the room whose every lamp it holds, else a lamp. */
  controls: Record<DashboardControlId, LampOrRoom>;
  /** The warm end of the cosy-day blend, and the colour a candle holds. */
  warmEnd: RGB;
};

/** The house's schedule: each block's timing and light. */
export type Schedule = Record<Block, BlockSchedule>;

/** A start is absent when its helper holds no time: the block then never starts on those days. */
export type BlockSchedule = {
  weekdayStart: TimeOfDay | undefined;
  weekendStart: TimeOfDay | undefined;
  fade: Minutes;
  light: SceneLight | undefined;
  /** Whether switches are on in this block; undefined when no helper says, which leaves a switch as it is. */
  switchesOn: boolean | undefined;
};

/** A room follows the house for a block's timing or light unless it has its own. */
export type OwnOrHouse<T> = { follows: 'house' } | { follows: 'own'; own: T };

export type BlockTiming = Pick<BlockSchedule, 'weekdayStart' | 'weekendStart' | 'fade'>;

export type RoomBlock = { timing: OwnOrHouse<BlockTiming>; light: OwnOrHouse<SceneLight | undefined>; switchesOn: OwnOrHouse<boolean | undefined> };

/** A private room is left out of house-wide overlays and the mode overlay. */
export type Room = { blocks: Record<Block, RoomBlock>; wakeLight: WakeLight | undefined; private: boolean };

/** The morning wake light: from `at`, the night block's light fades to day over `fade`. */
export type WakeLight = { at: Instant; fade: Minutes };

/** A lamp in no room follows the house. */
export type Lamp = { room: RoomId | undefined; bulbs: readonly BulbInfo[] };

/**
 * A switch is a light or switch labelled on/off, or one with a saved range rule. Only an on/off-labelled one
 * (`onOff`) follows its block's on/off setting; a range-only switch follows its range rule or is left as it is.
 */
export type Switch = { room: RoomId | undefined; onOff: boolean };

/** No room: the remote does nothing. */
export type Remote = { room: RoomId | undefined };

/** The three rules that end overlays; each is on or off. */
export type OverlayReset = {
  /** An overlay set before the lamp's last fade start no longer applies. */
  atNextBlock: boolean;
  /** Every overlay is removed at this time each day; off when undefined. */
  atSetTime: TimeOfDay | undefined;
  /** An overlay older than this is removed; off when undefined. */
  afterAge: Minutes | undefined;
};
