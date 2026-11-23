import assert from 'node:assert/strict';
import test from 'node:test';
import type { Block } from '../../src/domain/blocks.ts';
import type { BlockSchedule, Config, Room, RoomBlock } from '../../src/domain/config.ts';
import type { EffectName } from '../../src/domain/effect.ts';
import { blockLight, blockPosition, sceneBetween, scheduledStage, wakeStage } from '../../src/domain/schedule.ts';
import type { RoomId } from '../../src/domain/types/ids.ts';
import type { Colour, SceneLight } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import {
  toBrightness, toColourChannel, toInstant, toKelvin, toMinutes, toProgress, toRoomId, toTimeOfDay, toTimezone,
} from '../../src/adapter/codecs/ids.ts';

/**
 * The schedule on the new types: where a room is in its blocks, the wake
 * light, and the light part way through a fade. Moved from
 * `src/legacy/domain/schedule.ts` (`scheduleDetails`, `initialStage`,
 * `wakeStage`, `interpolate`, `scopeFor`); the flow cases of
 * `off-on-fade.test.ts` and `off-lamp-schedule.test.ts` are carried here.
 *
 * An invented house, in UTC unless a test says otherwise: day 07:00 on
 * weekdays and 09:00 at the weekend, cosy 18:00 and 19:00 at the weekend,
 * night 23:00; every fade 20 minutes. 2026-11-23 is a Monday.
 */

const t = (iso: string): Instant => toInstant(Date.parse(iso) / 1000);
const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const lit = (brightness: number, colour: Colour | undefined, effect: EffectName = 'Normal'): SceneLight =>
  ({ power: 'on', brightness: toBrightness(brightness), colour, effect });
const OFF: SceneLight = { power: 'off' };

const DAY = lit(240, kelvin(4500)), COSY = lit(90, kelvin(2500));

function houseBlock(weekday: [number, number] | undefined, weekend: [number, number] | undefined, light: SceneLight): BlockSchedule {
  return {
    weekdayStart: weekday === undefined ? undefined : toTimeOfDay(...weekday),
    weekendStart: weekend === undefined ? undefined : toTimeOfDay(...weekend),
    fade: toMinutes(20), light, switchesOn: undefined,
  };
}

const followsHouse: RoomBlock = { timing: { follows: 'house' }, light: { follows: 'house' }, switchesOn: { follows: 'house' } };
const plainRoom: Room = { blocks: { day: followsHouse, cosy: followsHouse, night: followsHouse }, wakeLight: undefined, private: false };
const roomA = toRoomId('room-a');

function config(change: (house: Record<Block, BlockSchedule>) => void = () => {}, rooms: Record<RoomId, Room> = {}, zone = 'UTC'): Config {
  const house: Record<Block, BlockSchedule> = {
    day: houseBlock([7, 0], [9, 0], DAY),
    cosy: houseBlock([18, 0], [19, 0], COSY),
    night: houseBlock([23, 0], [23, 0], OFF),
  };
  change(house);
  return {
    timezone: toTimezone(zone), house, rooms, lamps: {}, switches: {}, remotes: {}, controls: {},
    overlayReset: { atNextBlock: false, atSetTime: undefined, afterAge: undefined },
    warmEnd: { red: toColourChannel(255), green: toColourChannel(126), blue: toColourChannel(0) },
  };
}

/** What a lamp following the schedule shows: the wake light where it applies, else the block or the fade between two. */
function scheduledLight(house: Config, room: RoomId | undefined, now: Instant): SceneLight | undefined {
  const position = blockPosition(house, room, now);
  const placed = room === undefined ? undefined : house.rooms[room];
  const wake = placed === undefined ? undefined : wakeStage(placed, position, now, house.timezone);
  const stage = wake === undefined ? scheduledStage(position) : wake;
  if (stage.from.kind !== 'block' || stage.into.kind !== 'block') throw new Error('the schedule alone never fades out of a held light');
  const from = blockLight(house, room, stage.from.block), into = blockLight(house, room, stage.into.block);
  if (from === undefined || into === undefined) return undefined;
  return stage.moving ? sceneBetween(from, into, stage.progress) : into;
}

test('a block starts at its weekday time on a weekday and its weekend time at the weekend', () => {
  // Break: the weekend start is read on weekdays, or the wrong days count as the weekend.
  const house = config();
  assert.deepEqual(pick(blockPosition(house, undefined, t('2026-11-23T08:00:00Z'))), { current: 'day', since: t('2026-11-23T07:00:00Z') });
  // Saturday morning: day waits for 09:00; night has held since Friday's 23:00.
  const saturday = blockPosition(house, undefined, t('2026-11-21T08:00:00Z'));
  assert.deepEqual(pick(saturday), { current: 'night', since: t('2026-11-20T23:00:00Z') });
  assert.equal(saturday.nextStart, t('2026-11-21T09:00:00Z'));
  // Cosy and night take the weekend time on the evenings before a weekend day: Friday and Saturday, not Sunday.
  assert.deepEqual(pick(blockPosition(house, undefined, t('2026-11-20T18:30:00Z'))), { current: 'day', since: t('2026-11-20T07:00:00Z') });
  assert.deepEqual(pick(blockPosition(house, undefined, t('2026-11-22T18:30:00Z'))), { current: 'cosy', since: t('2026-11-22T18:00:00Z') });
});

test('the fade begins its minutes before the start', () => {
  // Break: the fade is measured from the start instead of before it, or uses the current block's fade.
  const house = config(blocks => { blocks.day.fade = toMinutes(20); });
  const inFade = blockPosition(house, undefined, t('2026-11-23T06:50:00Z'));
  assert.equal(inFade.current, 'night');
  assert.deepEqual(inFade.fade, { into: 'day', progress: toProgress(0.5) });
  assert.equal(inFade.lastFadeStart, t('2026-11-23T06:40:00Z'));
  const before = blockPosition(house, undefined, t('2026-11-23T06:39:00Z'));
  assert.equal(before.fade, undefined);
  assert.equal(before.nextFadeStart, t('2026-11-23T06:40:00Z'));
  assert.equal(before.nextStart, t('2026-11-23T07:00:00Z'));
});

test('a block with no start never starts', () => {
  // Break: an absent start is read as midnight, or as the other day kind's time.
  const house = config(blocks => { blocks.night.weekendStart = undefined; });
  // Friday night is a weekend evening, so night has no start: cosy holds until Saturday's day.
  const friday = blockPosition(house, undefined, t('2026-11-20T23:30:00Z'));
  assert.deepEqual(pick(friday), { current: 'cosy', since: t('2026-11-20T19:00:00Z') });
  assert.equal(friday.nextStart, t('2026-11-21T09:00:00Z'));
  // Sunday evening is a weekday evening: night starts.
  assert.equal(blockPosition(house, undefined, t('2026-11-22T23:30:00Z')).current, 'night');
});

test('a night that starts after midnight belongs to the evening before', () => {
  // Break: a start before noon is put on the evening's own date, or its weekend is read from the morning's day.
  const house = config(blocks => { blocks.night.weekdayStart = toTimeOfDay(0, 30); blocks.night.weekendStart = toTimeOfDay(1, 30); });
  // Friday 01:00 is Thursday evening's, a weekday evening: night started at 00:30.
  assert.deepEqual(pick(blockPosition(house, undefined, t('2026-11-20T01:00:00Z'))), { current: 'night', since: t('2026-11-20T00:30:00Z') });
  // Sunday 01:00 is Saturday evening's, a weekend evening: its 01:30 has not come.
  assert.deepEqual(pick(blockPosition(house, undefined, t('2026-11-22T01:00:00Z'))), { current: 'cosy', since: t('2026-11-21T19:00:00Z') });
});

test('with no start in reach the default block holds, since no start', () => {
  // Break: an invented start (the epoch) for a block that never started.
  const house = config(blocks => { for (const block of ['day', 'cosy', 'night'] as const) { blocks[block].weekdayStart = undefined; blocks[block].weekendStart = undefined; } });
  const position = blockPosition(house, undefined, t('2026-11-23T12:00:00Z'));
  assert.deepEqual(position, {
    current: 'night', currentSince: undefined, fade: undefined, lastFadeStart: undefined, nextFadeStart: undefined, nextStart: undefined,
    justStarted: false,
  });
});

test('a block has just started for 90 seconds after its start', () => {
  // Break: the 90 s window moves.
  const house = config();
  assert.equal(blockPosition(house, undefined, t('2026-11-23T07:01:29Z')).justStarted, true);
  assert.equal(blockPosition(house, undefined, t('2026-11-23T07:01:30Z')).justStarted, false);
});

test('a room without its own timing follows the house', () => {
  // Break: a room's position is read from the room even where its timing follows the house.
  const ownCosy: Room = { ...plainRoom, blocks: { ...plainRoom.blocks, cosy: {
    ...followsHouse, timing: { follows: 'own', own: { weekdayStart: toTimeOfDay(17, 30), weekendStart: toTimeOfDay(17, 30), fade: toMinutes(10) } },
  } } };
  const roomB = toRoomId('room-b');
  const house = config(() => {}, { [roomA]: plainRoom, [roomB]: ownCosy });
  for (const iso of ['2026-11-23T06:50:00Z', '2026-11-23T17:45:00Z', '2026-11-21T08:00:00Z']) {
    assert.deepEqual(blockPosition(house, roomA, t(iso)), blockPosition(house, undefined, t(iso)), iso);
  }
  // A room with its own cosy timing is in cosy while the house is still fading towards it.
  assert.deepEqual(pick(blockPosition(house, roomB, t('2026-11-23T17:45:00Z'))), { current: 'cosy', since: t('2026-11-23T17:30:00Z') });
  const housePosition = blockPosition(house, undefined, t('2026-11-23T17:45:00Z'));
  assert.equal(housePosition.current, 'day');
  assert.equal(housePosition.fade?.into, 'cosy');
});

test('a lamp in no room follows the house', () => {
  // Break: a lamp with no room (or a room the config does not hold) gets no schedule, or a room's.
  const ownLight: Room = { ...plainRoom, blocks: { ...plainRoom.blocks, cosy: { ...followsHouse, light: { follows: 'own', own: lit(50, kelvin(2000), 'Candle') } } } };
  const house = config(() => {}, { [roomA]: ownLight });
  const now = t('2026-11-23T20:00:00Z');
  assert.deepEqual(blockPosition(house, toRoomId('room-x'), now), blockPosition(house, undefined, now));
  assert.deepEqual(blockLight(house, undefined, 'cosy'), COSY);
  assert.deepEqual(blockLight(house, toRoomId('room-x'), 'cosy'), COSY);
  assert.deepEqual(blockLight(house, roomA, 'cosy'), lit(50, kelvin(2000), 'Candle'));
  assert.deepEqual(blockLight(house, roomA, 'day'), DAY);
});

test('a lamp shows its block light, and an off or colourless block light as it is', () => {
  // Carried from off-lamp-schedule.test.ts: nothing is invented, no white, no 255.
  const house = config(blocks => { blocks.cosy.light = lit(90, undefined); });
  assert.deepEqual(scheduledLight(house, undefined, t('2026-11-23T20:00:00Z')), lit(90, undefined));
  assert.deepEqual(scheduledLight(house, undefined, t('2026-11-24T01:00:00Z')), OFF);
  assert.equal(scheduledLight(config(blocks => { blocks.day.light = undefined; }), undefined, t('2026-11-23T12:00:00Z')), undefined);
});

test('the wake light fades night into day from the wake time', () => {
  // Break: the wake fade starts late, runs at the wrong speed, or fades the wrong way.
  const waking: Room = { ...plainRoom, wakeLight: { at: t('2026-11-23T06:00:00Z'), fade: toMinutes(30) } };
  const house = config(() => {}, { [roomA]: waking });
  const stage = (iso: string) => wakeStage(waking, blockPosition(house, roomA, t(iso)), t(iso), house.timezone);
  const fade = (progress: number) => ({ from: { kind: 'block', block: 'night' }, into: { kind: 'block', block: 'day' }, progress, moving: true });
  assert.equal(stage('2026-11-23T05:59:00Z'), undefined);
  assert.deepEqual(stage('2026-11-23T06:00:00Z'), fade(0));
  assert.deepEqual(stage('2026-11-23T06:15:00Z'), fade(0.5));
  // Carried from off-on-fade.test.ts: from an off night the lamp comes on at level 1 in the day colour and ramps like a sunrise.
  assert.deepEqual(scheduledLight(house, roomA, t('2026-11-23T06:00:00Z')), lit(1, kelvin(4500)));
  assert.deepEqual(scheduledLight(house, roomA, t('2026-11-23T06:15:00Z')), lit(120, kelvin(4500)));
});

test('after the wake fade the room holds day until the day block', () => {
  // Break: the completed wake drops back to night, or still holds once the day block runs.
  const waking: Room = { ...plainRoom, wakeLight: { at: t('2026-11-23T06:00:00Z'), fade: toMinutes(30) } };
  const house = config(() => {}, { [roomA]: waking });
  const stage = (iso: string) => wakeStage(waking, blockPosition(house, roomA, t(iso)), t(iso), house.timezone);
  const held = { from: { kind: 'block', block: 'day' }, into: { kind: 'block', block: 'day' }, progress: 0, moving: false };
  assert.deepEqual(stage('2026-11-23T06:35:00Z'), held);
  // Still held while the house fades into day (06:40 to 07:00).
  assert.deepEqual(stage('2026-11-23T06:50:00Z'), held);
  assert.equal(stage('2026-11-23T07:05:00Z'), undefined);
  assert.deepEqual(scheduledLight(house, roomA, t('2026-11-23T06:35:00Z')), DAY);
});

test('a wake time outside the night block does nothing', () => {
  // Break: a wake set during the day, or before the night started, lights the room.
  const wakingAt = (iso: string): Room => ({ ...plainRoom, wakeLight: { at: t(iso), fade: toMinutes(30) } });
  const stage = (room: Room, iso: string) => {
    const house = config(() => {}, { [roomA]: room });
    return wakeStage(room, blockPosition(house, roomA, t(iso)), t(iso), house.timezone);
  };
  assert.equal(stage(wakingAt('2026-11-23T12:00:00Z'), '2026-11-23T12:10:00Z'), undefined);
  // Yesterday's wake: tonight's night started after it.
  assert.equal(stage(wakingAt('2026-11-22T06:00:00Z'), '2026-11-23T01:00:00Z'), undefined);
  // A wake at 03:00 fades, but once done holds nothing: the hold is for wakes from 04:00 to 10:59.
  assert.equal(stage(wakingAt('2026-11-23T03:00:00Z'), '2026-11-23T03:10:00Z')?.moving, true);
  assert.equal(stage(wakingAt('2026-11-23T03:00:00Z'), '2026-11-23T03:40:00Z'), undefined);
});

test('a fade from an off block ramps up in the lit end\'s colour', () => {
  // Carried from off-on-fade.test.ts (2026-11-20, gradual in both directions). Level at p: max(1, round(1 + 239 p)).
  assert.deepEqual(sceneBetween(OFF, DAY, toProgress(0.05)), lit(13, kelvin(4500)));
  assert.deepEqual(sceneBetween(OFF, DAY, toProgress(0.5)), lit(120, kelvin(4500)));
  assert.deepEqual(sceneBetween(OFF, DAY, toProgress(0.95)), lit(228, kelvin(4500)));
  // The same through the schedule: night (off) fades into day from 06:40.
  assert.deepEqual(scheduledLight(config(), undefined, t('2026-11-23T06:41:00Z')), lit(13, kelvin(4500)));
  assert.deepEqual(scheduledLight(config(), undefined, t('2026-11-23T07:30:00Z')), DAY);
});

test('a fade into an off block dims towards 1 and stays lit until the block starts', () => {
  // Carried from off-on-fade.test.ts.
  assert.deepEqual(sceneBetween(COSY, OFF, toProgress(0.5)), lit(45, kelvin(2500)));
  assert.deepEqual(sceneBetween(COSY, OFF, toProgress(1 - 1 / 1200)), lit(1, kelvin(2500)));
  assert.deepEqual(scheduledLight(config(), undefined, t('2026-11-23T22:50:00Z')), lit(45, kelvin(2500)));
  assert.deepEqual(sceneBetween(OFF, OFF, toProgress(0.5)), OFF);
});

test('a fade between two lit blocks mixes level and colour; a missing colour takes the one there is', () => {
  // Break: the mix runs the wrong way, or a colourless end invents one.
  assert.deepEqual(sceneBetween(DAY, COSY, toProgress(0.5)), lit(165, kelvin(3500)));
  assert.deepEqual(sceneBetween(lit(90, undefined), lit(240, undefined), toProgress(0.5)), lit(165, undefined));
  assert.deepEqual(sceneBetween(lit(90, undefined), DAY, toProgress(0.5)), lit(165, kelvin(4500)));
  assert.deepEqual(sceneBetween(DAY, lit(90, undefined), toProgress(0.5)), lit(165, kelvin(4500)));
});

test('a fade keeps the effect of the block it leaves', () => {
  // Amendment 4: the lamp keeps the current block's effect through the fade and switches at the block start.
  assert.deepEqual(sceneBetween(lit(90, kelvin(2200), 'Candle'), DAY, toProgress(0.9)), lit(225, kelvin(4270), 'Candle'));
  // Out of an off block there is no effect to keep: the lit end's.
  assert.deepEqual(sceneBetween(OFF, lit(90, kelvin(2200), 'Candle'), toProgress(0.5)), lit(46, kelvin(2200), 'Candle'));
});

test('spring and autumn clock changes keep block starts at local time', () => {
  // Break: starts computed with a fixed offset drift by an hour across the change.
  const house = config(() => {}, {}, 'Europe/Stockholm');
  const since = (iso: string) => blockPosition(house, undefined, t(iso)).currentSince;
  // Spring: 2026-03-29, 02:00 CET becomes 03:00 CEST.
  assert.equal(since('2026-03-28T10:00:00+01:00'), t('2026-03-28T09:00:00+01:00'));
  assert.equal(since('2026-03-29T10:00:00+02:00'), t('2026-03-29T09:00:00+02:00'));
  assert.equal(blockPosition(house, undefined, t('2026-03-28T23:30:00+01:00')).nextStart, t('2026-03-29T09:00:00+02:00'));
  // Autumn: 2026-10-25, 03:00 CEST becomes 02:00 CET.
  assert.equal(since('2026-10-24T10:00:00+02:00'), t('2026-10-24T09:00:00+02:00'));
  assert.equal(since('2026-10-25T10:00:00+01:00'), t('2026-10-25T09:00:00+01:00'));
  assert.equal(blockPosition(house, undefined, t('2026-10-24T23:30:00+02:00')).nextStart, t('2026-10-25T09:00:00+01:00'));
});

function pick(position: ReturnType<typeof blockPosition>): { current: Block; since: Instant | undefined } {
  return { current: position.current, since: position.currentSince };
}
