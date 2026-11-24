/**
 * Switches: whether each switch is on, from a press on its own button (a
 * switch overlay), its range rule against its room's level, the plug's own
 * profile for the block, or the block's on/off setting. The range rules and
 * their bright and cosy defaults are saved from the dashboard.
 *
 * Moved from `switchPlan` in `src/legacy/domain/controller.ts` (a range rule
 * against the room's level) and the switch half of `scheduledBase` in
 * `src/legacy/domain/schedule.ts` (the block's on/off setting, sent only while
 * the stage is still). `isRangeDefault` is not moved: a `PercentRange` is in order inside
 * 0..100 by its type.
 */
import type { Config, Switch } from './config.ts';
import { ownSwitchSetting } from './profiles.ts';
import type { SwitchProfiles } from './profiles.ts';
import { blockPosition } from './schedule.ts';
import type { RoomId, SwitchId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Brightness, PercentRange, Power } from './types/light.ts';
import type { Block, RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/** Holds the switch over its range rule and its block until a reset removes it. New: no stored field today. */
export type SwitchOverlay = { power: Power; since: Instant };

/** A switch held on or off by a press on its own button: at most one each (decision 8). */
export type SwitchOverlays = Partial<Record<SwitchId, SwitchOverlay>>;

/** Which levels of its room a switch is on for: the bright or cosy default range, or its own. */
export type RangeRule = { kind: 'bright' } | { kind: 'cosy' } | { kind: 'custom'; range: PercentRange };

/** Each switch's range rule, saved from the dashboard. */
export type RangeRules = Record<SwitchId, RangeRule>;

/** The bright and cosy default ranges. Saved from the dashboard's range helpers at run time, so Model, not Config. */
export type RangeDefaults = Record<'bright' | 'cosy', PercentRange>;

/**
 * What a room's switches read: the room's stage, still in a block or moving (a
 * fade or the wake fade, during which today's switches are sent nothing), and
 * the room's own light, its block light with the room's overlays, whose level a
 * range rule reads.
 */
export type RoomLight = {
  stage: { moving: false; block: Block } | { moving: true };
  light: { power: 'off' } | { power: 'on'; brightness: Brightness };
};

/** A press on a switch's own button, switching it on or off. */
export type SwitchButtonPressed = { kind: 'switchButtonPressed'; switch: SwitchId; power: Power; at: Instant };

/**
 * A switch's range rule saved from the dashboard. `room` is the room the
 * config codec reads the switch in: a plug with no on/off label is a switch of
 * the house from its first range save on, in that room.
 */
export type RangeSaved = { kind: 'rangeSaved'; switch: SwitchId; rule: RangeRule; room: RoomId | undefined; at: Instant };

/** The bright and cosy default ranges saved (today's `range_defaults`, sent only when both are valid, which their type is). */
export type RangeDefaultsSaved = { kind: 'rangeDefaultsSaved'; defaults: RangeDefaults; at: Instant };

/**
 * A press on a plug's own button: an overlay on that switch, replacing any it
 * had (M1 plan, decision 8; owner, 2026-11-22). It holds the switch over its
 * range rule and its block until a reset releases it; today's scripts take
 * the press back at the next tick, a named behaviour change. A switch the
 * config does not hold is left alone.
 */
export function switchButtonPressed(overlays: SwitchOverlays, config: Config, press: SwitchButtonPressed): SwitchOverlays {
  if (config.switches[press.switch]?.kind !== 'lighting') return overlays;
  return { ...overlays, [press.switch]: { power: press.power, since: press.at } };
}

/**
 * A switch's range rule saved from the dashboard (today's `range_set`, after
 * `decideRangeSave`'s checks, which read Home Assistant's devices and stay at
 * the edge). A switch overlay on it stays. A plug the config does not hold yet
 * (no on/off label, no rule before) becomes one of the house's switches, in
 * the room the save names, as reading the config again would make it; until
 * then a room the config holds no schedule for follows the house's.
 */
export function rangeSaved(config: Config, rules: RangeRules, saved: RangeSaved): { config: Config; switchRanges: RangeRules } {
  const held = config.switches[saved.switch];
  if (held?.kind === 'plant light') return { config, switchRanges: rules };
  const switches = held === undefined
    ? { ...config.switches, [saved.switch]: { kind: 'lighting', room: saved.room, onOff: false } satisfies Switch } : config.switches;
  return { config: { ...config, switches }, switchRanges: { ...rules, [saved.switch]: saved.rule } };
}

/**
 * Whether each lighting switch is on; a plant light is not one (`plantPower`
 * in `./plant-lights.ts` gives it) and is skipped.
 *
 * A switch overlay that still applies wins over the range rule, the plug's own
 * on/off profile for the block and the block's on/off setting. Then a switch with a range rule is on while its room is on
 * and the room's level, as a percent of 255, is inside the range, both ends
 * included. An on/off-labelled switch with no rule, or in no room (a rule needs a room's level),
 * follows the plug's own profile for the block, else the block's on/off setting, once its room's stage is still; while the
 * stage moves (a fade or the wake fade) it is left out, as today a moving stage
 * sends a plug nothing. A switch nothing says anything about is left out too,
 * so it is left as it is: a range-only switch with no rule, or in no room, is never given the block's setting.
 *
 * The next-block reset, when its rule is on, releases a switch overlay set at
 * or before the room's last fade start. `rooms` are the room lights
 * `lightingState` works out, the house's for a switch in no room.
 */
export function switchPower(
  model: {
    config: Config; overlays: { switches: SwitchOverlays }; switchRanges: RangeRules; rangeDefaults: RangeDefaults; switchProfiles: SwitchProfiles;
  },
  rooms: Readonly<Record<RoomOrHouse, RoomLight>>, now: Instant,
): Record<SwitchId, Power> {
  const config = model.config;
  const power: Record<SwitchId, Power> = {};
  for (const [id, placed] of entriesOf(config.switches)) {
    if (placed.kind !== 'lighting') continue;
    // The switch's room is the config's, as decoded or saved; a room the config holds no schedule for follows the house's.
    const room = placed.room, scheduled = room !== undefined && config.rooms[room] !== undefined ? room : undefined;
    const light = rooms[scheduled === undefined ? 'house' : scheduled];
    if (light === undefined) continue;
    const held = model.overlays.switches[id];
    const lastFadeStart = blockPosition(config, scheduled, now).lastFadeStart;
    const released = held !== undefined && config.overlayReset.atNextBlock && lastFadeStart !== undefined && held.since <= lastFadeStart;
    const rule = model.switchRanges[id];
    if (held !== undefined && !released) power[id] = held.power;
    else if (rule !== undefined && room !== undefined) {
      const range = rule.kind === 'custom' ? rule.range : model.rangeDefaults[rule.kind];
      const share = light.light.power === 'on' ? light.light.brightness * 100 / 255 : undefined;
      power[id] = share !== undefined && range.low <= share && share <= range.high ? 'on' : 'off';
    } else if (placed.onOff && !light.stage.moving) {
      const own = ownSwitchSetting(model.switchProfiles[id]?.[light.stage.block]);
      const setting = own !== undefined ? own : switchesOn(config, scheduled, light.stage.block);
      if (setting !== undefined) power[id] = setting ? 'on' : 'off';
    }
  }
  return power;
}

/** A block's on/off setting for a room's switches: the room's own where it has one, the house's otherwise; undefined where no helper says. */
function switchesOn(config: Config, room: RoomId | undefined, block: Block): boolean | undefined {
  const own = room === undefined ? undefined : config.rooms[room]?.blocks[block].switchesOn;
  return own !== undefined && own.follows === 'own' ? own.own : config.house[block].switchesOn;
}
