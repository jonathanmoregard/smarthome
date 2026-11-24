/**
 * Block overlays: a block held over a room or the house from the dashboard's
 * block selector, over the schedule's block, until an overlay reset removes
 * it. The remote's day and cosy presets hold a block too; the newer of the two
 * wins (`heldBlock`, in `./remote.ts`).
 */
import type { Config } from './config.ts';
import { blockPosition } from './schedule.ts';
import type { RoomId } from './types/ids.ts';
import type { Block, RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/** `since` is when the overlay was last set (stored `when`): what the next-block and after-age resets measure. */
export type BlockOverlay = { block: Block; since: Instant };

/** A block held over a room or the house: at most one each. */
export type BlockOverlays = Partial<Record<RoomOrHouse, BlockOverlay>>;

/** The dashboard's block selector: a block held over a room or the house. */
export type BlockHeld = { kind: 'hold block'; over: RoomOrHouse; block: Block };

/**
 * A block held over a room or the house, moved from `planOverrideBlock` and
 * `houseRooms` in `src/legacy/domain/state-store.ts`. Over the house it is
 * also held over each room a lamp or an on/off switch is in, the private rooms
 * left out. Each target already scheduled to the block has its hold cleared
 * instead.
 */
export function holdBlock(overlays: BlockOverlays, config: Config, held: BlockHeld, now: Instant): BlockOverlays {
  const targets: RoomOrHouse[] = held.over === 'house' ? ['house', ...houseRooms(config)] : [held.over];
  const blocks = { ...overlays };
  for (const target of targets) {
    if (blockPosition(config, target === 'house' ? undefined : target, now).current === held.block) delete blocks[target];
    else blocks[target] = { block: held.block, since: now };
  }
  return blocks;
}
/**
 * The rooms a hold over the house reaches: each room a lamp or an on/off
 * switch is in, once, leaving out the private ones and the ones the config does not hold.
 */
function houseRooms(config: Config): RoomId[] {
  const placed = [
    ...Object.values(config.lamps).map(lamp => lamp.room),
    ...Object.values(config.switches).flatMap(placedSwitch => placedSwitch.kind === 'lighting' && placedSwitch.onOff ? [placedSwitch.room] : []),
  ];
  const rooms = placed.flatMap(room => room !== undefined && config.rooms[room] !== undefined && !config.rooms[room].private ? [room] : []);
  return [...new Set(rooms)];
}
