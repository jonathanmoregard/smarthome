/**
 * Whether each switch is on.
 *
 * Moved from `switchPlan` in `src/legacy/domain/controller.ts` (a range rule
 * against the room's level) and the switch half of `scheduledBase` in
 * `src/legacy/domain/schedule.ts` (the block's on/off setting, sent only while
 * the stage is still). `isRangeDefault` is not moved: a `PercentRange` is in order inside
 * 0..100 by its type.
 */
import type { Block } from './blocks.ts';
import type { Config } from './config.ts';
import type { RoomLight } from './lighting-state.ts';
import type { Model } from './model.ts';
import { blockPosition } from './schedule.ts';
import type { RoomId, SwitchId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Power } from './types/light.ts';
import type { RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/**
 * A switch overlay that still applies wins over the range rule and the block's
 * on/off setting. Then a switch with a range rule is on while its room is on
 * and the room's level, as a percent of 255, is inside the range, both ends
 * included. A switch with no rule, or in no room (a rule needs a room's level),
 * follows its block's on/off setting once its room's stage is still; while the
 * stage moves (a fade or the wake fade) it is left out, as today a moving stage
 * sends a plug nothing. A switch nothing says anything about is left out too,
 * so it is left as it is.
 *
 * The next-block reset, when its rule is on, releases a switch overlay set at
 * or before the room's last fade start. `rooms` are the room lights
 * `lightingState` works out, the house's for a switch in no room.
 */
export function switchPower(model: Model, rooms: Readonly<Record<RoomOrHouse, RoomLight>>, now: Instant): Record<SwitchId, Power> {
  const config = model.config;
  const power: Record<SwitchId, Power> = {};
  for (const [id, placed] of entriesOf(config.switches)) {
    const room = placed.room !== undefined && config.rooms[placed.room] !== undefined ? placed.room : undefined;
    const light = rooms[room === undefined ? 'house' : room];
    if (light === undefined) continue;
    const held = model.overlays.switches[id];
    const lastFadeStart = blockPosition(config, room, now).lastFadeStart;
    const released = held !== undefined && config.overlayReset.atNextBlock && lastFadeStart !== undefined && held.since <= lastFadeStart;
    const rule = model.switchRanges[id];
    if (held !== undefined && !released) power[id] = held.power;
    else if (rule !== undefined && room !== undefined) {
      const range = rule.kind === 'custom' ? rule.range : model.rangeDefaults[rule.kind];
      const share = light.light.power === 'on' ? light.light.brightness * 100 / 255 : undefined;
      power[id] = share !== undefined && range.low <= share && share <= range.high ? 'on' : 'off';
    } else if (!light.stage.moving) {
      const setting = switchesOn(config, room, light.stage.block);
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
