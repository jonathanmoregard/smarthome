/**
 * The synthetic house: a small, invented house as a `Model`, the one every
 * later test of the redesign builds on. Its names are made up; nothing here
 * comes from a real house.
 *
 * Two rooms, `room-b` private; `room-a` has its own timing and light for the
 * cosy block, a light that runs the candle, while its day block follows the
 * house's plain colour. Three lamps, `light.lamp_a1` with a candle bulb and a stock bulb. One
 * switch, `switch.plug_a`, with a custom range. A remote in `room-a` and one in no room.
 *
 * Overlays: night held over `room-a`; `remote-a` brighter by three and moved
 * from day onto the candle, so it holds the day block and remembers day, with
 * a chord in progress; on `light.lamp_a1` a dashboard control's candle with the
 * schedule's colour, then a person's newer fixed brightness and colour, which
 * leave the candle running at them; a dashboard control's Normal over
 * `room-a` (both parts handed back to the schedule), whose cosy block runs the candle; `room-b` switched off; the mode
 * overlay active.
 */
import type { Block } from '../../../src/domain/blocks.ts';
import type { BlockSchedule, Config, Room, RoomBlock } from '../../../src/domain/config.ts';
import type { LampProfile, LitLight, Model } from '../../../src/domain/model.ts';
import type { RemoteAdjustment } from '../../../src/domain/overlays.ts';
import type { RoomId } from '../../../src/domain/types/ids.ts';
import type { EffectName } from '../../../src/domain/effect.ts';
import type { Colour } from '../../../src/domain/types/light.ts';
import {
  toBrightness, toBulbId, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toMinutes, toPercentRange,
  toRemoteId, toRemoteSource, toRoomId, toStep, toStepCount, toSwitchId, toTimeOfDay, toTimezone,
} from '../../../src/adapter/codecs/ids.ts';
import type { ConfigSource } from '../../../src/adapter/codecs/config.ts';
import { parseCatalog } from '../../../src/adapter/codecs/catalog.ts';
import type { Catalog } from '../../../src/adapter/codecs/catalog.ts';
import type { EntityState, JsonObject } from '../../../src/adapter/ha-client.ts';
import { parseRooms } from '../../../src/adapter/codecs/rooms.ts';

/** A fixed moment the house's times count from. */
const T0 = 1_790_000_000;
const at = (minutesAfter: number) => toInstant(T0 + minutesAfter * 60);

const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2'), lampB1 = toLampId('light.lamp_b1');
const plugA = toSwitchId('switch.plug_a');
const remoteA = toRemoteId('remote-a'), remoteB = toRemoteId('remote-b');
const sourceA = toRemoteSource('remote-a'), sourceB = toRemoteSource('remote-b');

const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const lit = (brightness: number, colour: Colour | undefined, effect: EffectName = 'Normal'): LitLight =>
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
  switches: { [plugA]: { room: roomA, onOff: true } },
  remotes: { [remoteA]: { room: roomA }, [remoteB]: { room: undefined } },
  overlayReset: { atNextBlock: true, atSetTime: undefined, afterAge: toMinutes(180) },
  controls: {},
  warmEnd: { red: toColourChannel(255), green: toColourChannel(126), blue: toColourChannel(0) },
};

/** Three brighter presses from the full range: both bounds moved up by three, the upper one held at the top. */
const threeBrighter: RemoteAdjustment = {
  steps: toStepCount(3), lower: toStep(-17), upper: toStep(20), from: 'current', at: at(50), lastPress: 'up', everBrighter: true,
};

/** A lamp with no stores: it follows its room, and owns the light a store with no fields reads as. */
const roomLight: LampProfile = { follows: 'room', own: { power: 'on', light: lit(255, undefined) } };
const followsRoom: Record<Block, LampProfile> = { day: roomLight, cosy: roomLight, night: roomLight };

export function syntheticHouse(): Model {
  const daySince = at(40);
  return {
    config,
    overlays: {
      blocks: { [roomA]: { block: 'night', since: at(10) } },
      remotes: [{
        remote: remoteA,
        room: roomA,
        since: at(55),
        stepRange: { min: toStep(-20), max: toStep(20) },
        adjustment: threeBrighter,
        preset: { choice: 'candle', since: at(55), adjustment: threeBrighter, block: { block: 'day', since: daySince } },
        remembered: { day: { choice: 'day', since: daySince } },
      }],
      lamps: [
        {
          kind: 'parts',
          over: { kind: 'lamp', lamp: lampA1 },
          from: { kind: 'dashboard', control: toDashboardControlId('control-a') },
          since: at(30),
          brightness: undefined,
          colour: { kind: 'schedule', at: at(30) },
          effect: { kind: 'candle', at: at(30) },
        },
        {
          kind: 'parts',
          over: { kind: 'lamp', lamp: lampA1 },
          from: { kind: 'person' },
          since: at(35),
          brightness: { kind: 'fixed', brightness: toBrightness(90), at: at(35) },
          colour: { kind: 'fixed', colour: kelvin(3000), at: at(35) },
          effect: undefined,
        },
        {
          kind: 'parts',
          over: { kind: 'room', room: roomA },
          from: { kind: 'dashboard', control: toDashboardControlId('control-b') },
          since: at(45),
          brightness: { kind: 'schedule', at: at(45) },
          colour: { kind: 'schedule', at: at(45) },
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
    switchProfiles: { [plugA]: { day: { follows: 'room', power: 'off' }, cosy: { follows: 'room', power: 'off' }, night: { follows: 'room', power: 'off' } } },
    lampProfiles: {
      [lampA1]: { ...followsRoom, cosy: { follows: 'own', own: { power: 'on', light: lit(100, undefined, 'Candle') } } },
      [lampA2]: followsRoom,
      [lampB1]: followsRoom,
    },
  };
}

/*
 * The same house as Home Assistant stores it: the helpers, the registry's
 * rooms and labels, the catalog, the overrides sensor, the remote helpers and
 * the lamp profile stores, each in the shape today's writers leave it. The
 * Model codecs decode this into `syntheticHouse()`.
 */

/** An instant as today's writers stamp `when`: ISO text. */
const iso = (minutesAfter: number) => new Date(at(minutesAfter) * 1000).toISOString();
const helper = (state: string, attributes: JsonObject = {}): EntityState => ({ state, attributes });

/** The catalog: the three lamps and their bulbs, the candle bulb flagged, and the two remotes. */
export function syntheticCatalog(): Catalog {
  return parseCatalog({
    members: { [lampA1]: ['bulb-a1', 'bulb-a2'], [lampA2]: ['bulb-a3'], [lampB1]: ['bulb-b1'] },
    bulbs: { 'bulb-a1': { candle: true } },
    remotes: { [roomA]: { device_id: remoteA, source: sourceA }, unplaced: { device_id: remoteB, source: sourceB } },
  });
}

/** The stored overlays: each one the shape `ls_commit` leaves after today's writer of its kind. */
const storedOverrides: JsonObject = {
  [`block:${roomA}`]: { kind: 'block', target: roomA, value: 'night', when: iso(10), created: iso(10), who: null, via: 'app' },
  [`channels:${sourceA}`]: {
    kind: 'input', key: `channels:${sourceA}`, source: sourceA, scope: 'room', target: roomA,
    value: {
      step_range: { min: -20, max: 20 },
      selection: 'Candle',
      adjustment: { steps: 3, lower: -17, upper: 20, anchor: 'current', updated: at(50), last: 'up', has_up: true },
      preset_contexts: { day: { period: 'day', period_updated: at(40), selection_updated: at(40) } },
      period: 'day', period_updated: at(40), selection_updated: at(55),
      selection_input: { steps: 3, lower: -17, upper: 20, anchor: 'current', updated: at(50), last: 'up', has_up: true },
      selection_instance: `${sourceA}:Candle`,
      remote_valid_until: at(600), remote_timing_revision: 0,
    },
    when: iso(55), created: iso(41), who: null, via: 'remote',
  },
  'channels:ui:control-a': {
    kind: 'channels', key: 'channels:ui:control-a', source: 'ui:control-a', scope: 'lamp', target: lampA1,
    value: {
      channels: {
        brightness: { kind: 'effect', effect: 'Candle', instance: 'ui:control-a:Candle', updated: at(30) },
        color: { kind: 'effect', effect: 'Candle', instance: 'ui:control-a:Candle', updated: at(30),
          underlying: { kind: 'constant', updated: at(30) } },
      },
      selection: 'Candle',
    },
    when: iso(30), created: iso(30), who: null, via: 'effects-house',
  },
  [`channels:native:${lampA1}`]: {
    kind: 'channels', key: `channels:native:${lampA1}`, source: `native:${lampA1}`, scope: 'lamp', target: lampA1,
    value: { channels: {
      brightness: { kind: 'constant', value: 90, updated: at(35) },
      color: { kind: 'constant', value: { kelvin: 3000 }, updated: at(35) },
    } },
    when: iso(35), created: iso(35), who: null, via: 'app',
  },
  'channels:ui:control-b': {
    kind: 'channels', key: 'channels:ui:control-b', source: 'ui:control-b', scope: 'room', target: roomA,
    value: {
      channels: { brightness: { kind: 'constant', updated: at(45) }, color: { kind: 'constant', updated: at(45) } },
      selection: 'Normal light',
    },
    when: iso(45), created: iso(45), who: null, via: 'effects-house',
  },
  'mode:sara': { kind: 'mode', target: 'sara', value: 'on', when: iso(60), created: iso(60), who: null, via: 'remote' },
};

/** The house's helpers, registry and labels, the overrides sensor and the remote and lamp stores. */
export function syntheticSource(): ConfigSource {
  const states: Record<string, EntityState> = {
    'input_datetime.ls_house_day_start': helper('07:00:00'),
    'input_datetime.ls_house_day_weekend': helper('09:00:00'),
    'input_number.ls_house_day_fade': helper('20'),
    'light.ls_house_day': helper('on', { brightness: 220, color_mode: 'color_temp', color_temp_kelvin: 4000 }),
    'input_boolean.ls_house_day_on_off': helper('on'),
    'input_datetime.ls_house_cosy_start': helper('18:00:00'),
    'input_datetime.ls_house_cosy_weekend': helper('18:00:00'),
    'input_number.ls_house_cosy_fade': helper('30'),
    'light.ls_house_cosy': helper('on', { brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 2700 }),
    'input_boolean.ls_house_cosy_on_off': helper('on'),
    'input_datetime.ls_house_night_start': helper('22:30:00'),
    'input_datetime.ls_house_night_weekend': helper('unknown'),
    'input_number.ls_house_night_fade': helper('30'),
    'light.ls_house_night': helper('off'),
    'input_boolean.ls_house_night_on_off': helper('off'),
    [`input_boolean.ls_${roomA}_cosy_own_timing`]: helper('on'),
    [`input_datetime.ls_${roomA}_cosy_start`]: helper('17:30:00'),
    [`input_datetime.ls_${roomA}_cosy_weekend`]: helper('19:00:00'),
    [`input_number.ls_${roomA}_cosy_fade`]: helper('45'),
    [`input_boolean.ls_${roomA}_cosy_own_light`]: helper('on'),
    [`light.ls_${roomA}_cosy`]: helper('on', { brightness: 90, color_mode: 'rgb', rgb_color: [255, 150, 60] }),
    [`input_text.ls_${roomA}_cosy`]: helper(JSON.stringify({ on: true, effect: 'Candle' })),
    [`input_datetime.ls_${roomB}_wake`]: helper('06:00:00', { timestamp: at(6 * 60) }),
    [`input_number.ls_${roomB}_wake_fade`]: helper('30'),
    'input_boolean.ls_ovr_next_block_on': helper('on'),
    'input_boolean.ls_ovr_at_on': helper('off'),
    'input_boolean.ls_ovr_after_on': helper('on'),
    'input_number.ls_ovr_after_min': helper('180'),
    'sensor.ls_overrides': helper('2026-09-21T14:13:20+00:00', {
      overrides: storedOverrides,
      power: { [roomB]: false },
      switch_ranges: { [plugA]: { profile: 'custom', min: 20, max: 60 } },
      range_defaults: { bright: [90, 100], cosy: [30, 60] },
    }),
    [`input_number.ls_${roomA}_remote_chord_step`]: helper('2.0'),
    [`timer.ls_${roomA}_remote_chord`]: helper('active', { duration: '0:00:03', finishes_at: iso(61) }),
    [`input_number.ls_${roomA}_remote_power_count`]: helper('0.0'),
    [`input_text.ls_${roomA}_remote_power_token`]: helper(''),
    [`input_number.ls_${roomA}_remote_preset`]: helper('3.0'),
    'input_text.ls_lamp_lamp_a1_cosy': helper(JSON.stringify({ on: true, own: true, b: 100, effect: 'Candle', effect_channels: ['brightness', 'color'] })),
  };
  return {
    states,
    rooms: parseRooms({ [lampA1]: roomA, [lampA2]: roomA, [lampB1]: roomB, [plugA]: roomA, [remoteA]: roomA }),
    labels: { on_off: [plugA], private_room: [roomB] },
    timezone: 'UTC',
  };
}
