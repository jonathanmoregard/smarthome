/**
 * The synthetic house: a small, invented house as a `Model`, the one every
 * later test of the redesign builds on. Its names are made up; nothing here
 * comes from a real house.
 *
 * Two rooms, `room-b` private; `room-a` has its own timing and light for the
 * cosy block, a light that runs the candle, while its day block follows the
 * house's plain colour. Three lamps, `lamp-a1` with a candle bulb and a stock bulb. One
 * switch with a custom range. A remote in `room-a` and one in no room.
 *
 * Overlays: night held over `room-a`; `remote-a` brighter by three and moved
 * from day onto the candle, so it holds the day block and remembers day, with
 * a chord in progress; on `lamp-a1` a dashboard control's candle with the
 * schedule's colour, then a person's newer fixed brightness and colour, which
 * leave the candle running at them; a dashboard control's Normal over
 * `room-a`, whose cosy block runs the candle; `room-b` switched off; the mode
 * overlay active.
 */
import type { Block } from '../../../src/domain/blocks.ts';
import type { BlockSchedule, Config, Room, RoomBlock } from '../../../src/domain/config.ts';
import type { LampProfile, Model } from '../../../src/domain/model.ts';
import type { RemoteAdjustment } from '../../../src/domain/overlays.ts';
import type { RoomId } from '../../../src/domain/types/ids.ts';
import type { EffectName } from '../../../src/domain/effect.ts';
import type { Colour, SceneLight } from '../../../src/domain/types/light.ts';
import {
  toBrightness, toBulbId, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toMinutes, toPercentRange,
  toRemoteId, toRemoteSource, toRoomId, toStep, toStepCount, toSwitchId, toTimeOfDay, toTimezone,
} from '../../../src/parse/ids.ts';

/** A fixed moment the house's times count from. */
const T0 = 1_790_000_000;
const at = (minutesAfter: number) => toInstant(T0 + minutesAfter * 60);

const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const lampA1 = toLampId('lamp-a1'), lampA2 = toLampId('lamp-a2'), lampB1 = toLampId('lamp-b1');
const plugA = toSwitchId('plug-a');
const remoteA = toRemoteId('remote-a'), remoteB = toRemoteId('remote-b');
const sourceA = toRemoteSource('remote-a'), sourceB = toRemoteSource('remote-b');

const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const lit = (brightness: number, colour: Colour | undefined, effect: EffectName = 'Normal'): SceneLight =>
  ({ power: 'on', brightness: toBrightness(brightness), colour, effect });

const house: Record<Block, BlockSchedule> = {
  day: { weekdayStart: toTimeOfDay(7, 0), weekendStart: toTimeOfDay(9, 0), fade: toMinutes(20), light: lit(220, kelvin(4000)), switchesOn: true },
  cosy: { weekdayStart: toTimeOfDay(18, 0), weekendStart: toTimeOfDay(18, 0), fade: toMinutes(30), light: lit(120, kelvin(2700)), switchesOn: true },
  /** No weekend start: on weekends night never starts. */
  night: { weekdayStart: toTimeOfDay(22, 30), weekendStart: undefined, fade: toMinutes(30), light: { power: 'off' }, switchesOn: false },
};

const followsHouse: RoomBlock = { timing: { follows: 'house' }, light: { follows: 'house' }, switchesOn: { follows: 'house' } };

const rooms: Record<RoomId, Room> = {
  [roomA]: {
    blocks: {
      day: followsHouse,
      cosy: {
        timing: { follows: 'own', own: { weekdayStart: toTimeOfDay(17, 30), weekendStart: toTimeOfDay(19, 0), fade: toMinutes(45) } },
        light: { follows: 'own', own: lit(90, { kind: 'rgb', rgb: { red: toColourChannel(255), green: toColourChannel(150), blue: toColourChannel(60) } }, 'Candle') },
        switchesOn: { follows: 'house' },
      },
      night: followsHouse,
    },
    wakeLight: undefined,
    private: false,
  },
  [roomB]: {
    blocks: { day: followsHouse, cosy: followsHouse, night: followsHouse },
    wakeLight: { at: at(6 * 60), fade: toMinutes(30) },
    private: true,
  },
};

const config: Config = {
  timezone: toTimezone('UTC'),
  house,
  rooms,
  lamps: {
    [lampA1]: { room: roomA, bulbs: [{ bulb: toBulbId('bulb-a1'), firmware: 'candle' }, { bulb: toBulbId('bulb-a2'), firmware: 'stock' }] },
    [lampA2]: { room: roomA, bulbs: [{ bulb: toBulbId('bulb-a3'), firmware: 'stock' }] },
    [lampB1]: { room: roomB, bulbs: [{ bulb: toBulbId('bulb-b1'), firmware: 'stock' }] },
  },
  switches: { [plugA]: { room: roomA } },
  remotes: { [remoteA]: { room: roomA, source: sourceA }, [remoteB]: { room: undefined, source: sourceB } },
  overlayReset: { atNextBlock: true, atSetTime: undefined, afterAge: toMinutes(180) },
  warmEnd: { red: toColourChannel(255), green: toColourChannel(126), blue: toColourChannel(0) },
};

/** Three brighter presses from the full range: both bounds moved up by three, the upper one held at the top. */
const threeBrighter: RemoteAdjustment = {
  steps: toStepCount(3), lower: toStep(-17), upper: toStep(20), from: 'current', at: at(50), lastPress: 'up', everBrighter: true,
};

const followsRoom: Record<Block, LampProfile> = { day: { follows: 'room' }, cosy: { follows: 'room' }, night: { follows: 'room' } };

export function syntheticHouse(): Model {
  const daySince = at(40);
  return {
    config,
    overlays: {
      blocks: { [roomA]: { block: 'night', since: at(10) } },
      remotes: [{
        source: sourceA,
        room: roomA,
        since: at(55),
        stepRange: { min: toStep(-20), max: toStep(20) },
        adjustment: threeBrighter,
        preset: { choice: 'candle', since: at(55), adjustment: threeBrighter, block: { block: 'day', since: daySince } },
        remembered: { day: { choice: 'day', since: daySince } },
      }],
      lamps: [
        {
          over: { kind: 'lamp', lamp: lampA1 },
          from: { kind: 'dashboard', control: toDashboardControlId('control-a') },
          since: at(30),
          brightness: undefined,
          colour: { kind: 'schedule', at: at(30) },
          effect: { kind: 'candle', at: at(30) },
        },
        {
          over: { kind: 'lamp', lamp: lampA1 },
          from: { kind: 'person' },
          since: at(35),
          brightness: { kind: 'fixed', brightness: toBrightness(90), at: at(35) },
          colour: { kind: 'fixed', colour: kelvin(3000), at: at(35) },
          effect: undefined,
        },
        {
          over: { kind: 'room', room: roomA },
          from: { kind: 'dashboard', control: toDashboardControlId('control-b') },
          since: at(45),
          brightness: undefined,
          colour: undefined,
          effect: { kind: 'normal', at: at(45) },
        },
      ],
      roomPower: { [roomB]: 'off' },
      switches: {},
    },
    modeOverlay: { active: true, since: at(60) },
    remotes: {
      [remoteA]: { chord: { active: true, progress: 'power power left', until: at(61) }, power: { presses: 0 }, presetButton: 'warm' },
      [remoteB]: { chord: { active: false }, power: { presses: 0 }, presetButton: undefined },
    },
    switchRanges: { [plugA]: { kind: 'custom', range: toPercentRange(20, 60) } },
    rangeDefaults: { bright: toPercentRange(90, 100), cosy: toPercentRange(30, 60) },
    lampProfiles: {
      [lampA1]: { ...followsRoom, cosy: { follows: 'own', light: lit(100, undefined, 'Candle') } },
      [lampA2]: followsRoom,
      [lampB1]: followsRoom,
    },
  };
}
