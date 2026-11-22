import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKS } from '../../src/domain/blocks.ts';
import type { Block } from '../../src/domain/blocks.ts';
import type { Config } from '../../src/domain/config.ts';
import { DEFAULT_FADE, DEFAULT_OVERLAY_AGE, DEFAULT_WAKE_FADE, bulbTopics, decodeConfig } from '../../src/adapter/codecs/config.ts';
import type { ConfigSource } from '../../src/adapter/codecs/config.ts';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import type { JsonObject } from '../../src/runtime/context.ts';
import type { EntityState } from '../../src/runtime/context.ts';
import { ParseError } from '../../src/runtime/parse.ts';
import { toBulbId, toInstant, toLampId, toMinutes, toRemoteId, toRoomId, toSwitchId, toTimeOfDay } from '../../src/parse/ids.ts';
import { parseRooms } from '../../src/parse/rooms.ts';

/**
 * The config codec reads the helpers the dashboard edits and the registry's
 * rooms into `Config`. Wire shapes follow the existing helper tests: an
 * `input_datetime` state is `HH:MM:SS`, an `input_number` state is text, a
 * block light is `light.ls_<scope>_<block>` and its saved profile is the
 * `input_text.ls_<scope>_<block>` JSON. Ids are synthetic.
 */
const catalogDocument = {
  members: { 'light.lamp_a': ['light.bulb_a1', 'light.bulb_a2'], 'light.lamp_b': ['light.bulb_b1'] },
  topics: { 'light.bulb_a1': 'zigbee2mqtt/a1', 'light.bulb_a2': 'zigbee2mqtt/a2', 'light.bulb_b1': 'zigbee2mqtt/b1' },
  bulbs: { 'light.bulb_a1': { candle: true } },
  remotes: { 'room-a': { device_id: 'device-remote-a', source: 'source-a' }, 'room-b': { device_id: 'device-remote-b', source: 'source-b' } },
};

function state(value: string, attributes: JsonObject = {}): EntityState { return { state: value, attributes }; }

/** A house with every helper set: the house's three blocks and one room, `room-a`, with lamps and a switch. */
function source(changes: Record<string, EntityState | undefined> = {}, extra: Partial<ConfigSource> = {}): ConfigSource {
  const states: Record<string, EntityState> = {};
  for (const [block, start, weekend, brightness, kelvin] of [['day', '07:00:00', '09:00:00', 220, 4000], ['cosy', '18:00:00', '18:00:00', 120, 2700], ['night', '22:30:00', '23:30:00', 10, 2000]] as const) {
    states[`input_datetime.ls_house_${block}_start`] = state(start);
    states[`input_datetime.ls_house_${block}_weekend`] = state(weekend);
    states[`input_number.ls_house_${block}_fade`] = state('30');
    states[`input_boolean.ls_house_${block}_on_off`] = state(block === 'night' ? 'off' : 'on');
    states[`light.ls_house_${block}`] = state('on', { brightness, color_mode: 'color_temp', color_temp_kelvin: kelvin });
    states[`input_text.ls_house_${block}`] = state(JSON.stringify({ on: true }));
  }
  for (const [entity, value] of Object.entries(changes)) {
    if (value === undefined) delete states[entity]; else states[entity] = value;
  }
  return {
    states,
    rooms: parseRooms({ 'light.lamp_a': 'room-a', 'light.lamp_b': 'room-b', 'switch.plug_a': 'room-a', 'device-remote-a': 'room-a' }),
    labels: { on_off: ['switch.plug_a'] },
    timezone: 'Europe/Berlin',
    ...extra,
  };
}

const catalog = () => parseCatalog(catalogDocument);
const decode = (changes: Record<string, EntityState | undefined> = {}, extra: Partial<ConfigSource> = {}): Config =>
  decodeConfig(source(changes, extra), catalog());
const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const house = (config: Config, block: Block) => config.house[block];
const roomBlock = (config: Config, block: Block) => config.rooms[roomA]!.blocks[block];

test('the house schedule reads each block start, weekend start, fade and on/off', () => {
  // Break: a block reads another block's helper, or the weekend start reads the weekday one.
  const config = decode();
  assert.deepEqual(house(config, 'cosy').weekdayStart, toTimeOfDay(18, 0));
  assert.deepEqual(house(config, 'day').weekendStart, toTimeOfDay(9, 0));
  assert.equal(house(config, 'night').fade, toMinutes(30));
  assert.deepEqual(BLOCKS.map(block => house(config, block).switchesOn), [true, true, false]);
});

for (const text of ['24:00:00', '12:60:00', 'garbage', '', 'unknown', 'unavailable']) {
  test(`a start of ${JSON.stringify(text)} is no start`, () => {
    // Break: the hour or minute bound is dropped, or an unreadable helper yields a made-up time.
    assert.equal(decode({ 'input_datetime.ls_house_day_start': state(text) }).house.day.weekdayStart, undefined);
  });
}

test('a missing start helper is no start', () => {
  assert.equal(decode({ 'input_datetime.ls_house_day_weekend': undefined }).house.day.weekendStart, undefined);
});

for (const text of ['garbage', '', 'unknown', 'inf', '-5']) {
  test(`an unreadable fade ${JSON.stringify(text)} is twenty minutes`, () => {
    // Break: the fade fallback changes, or an unreadable fade raises.
    assert.equal(DEFAULT_FADE, toMinutes(20));
    assert.equal(decode({ 'input_number.ls_house_day_fade': state(text) }).house.day.fade, DEFAULT_FADE);
  });
}

test('a room without its own timing follows the house, and with it reads its own helpers', () => {
  // Break: the own-timing flag is not read, or any state but `on` counts as on.
  const timing = { 'input_datetime.ls_room-a_cosy_start': state('17:30:00'), 'input_datetime.ls_room-a_cosy_weekend': state('19:00:00'), 'input_number.ls_room-a_cosy_fade': state('45') };
  assert.deepEqual(roomBlock(decode(timing), 'cosy').timing, { follows: 'house' });
  for (const flag of ['off', 'unknown', 'true']) {
    assert.deepEqual(roomBlock(decode({ ...timing, 'input_boolean.ls_room-a_cosy_own_timing': state(flag) }), 'cosy').timing, { follows: 'house' });
  }
  assert.deepEqual(roomBlock(decode({ ...timing, 'input_boolean.ls_room-a_cosy_own_timing': state('on') }), 'cosy').timing,
    { follows: 'own', own: { weekdayStart: toTimeOfDay(17, 30), weekendStart: toTimeOfDay(19, 0), fade: toMinutes(45) } });
});

test('a room without its own light follows the house, and with it reads its own block light', () => {
  const own = { 'input_boolean.ls_room-a_cosy_own_light': state('on'), 'light.ls_room-a_cosy': state('on', { brightness: 80, color_mode: 'color_temp', color_temp_kelvin: 2200 }) };
  assert.deepEqual(roomBlock(decode(), 'cosy').light, { follows: 'house' });
  const light = roomBlock(decode(own), 'cosy').light;
  assert.equal(light.follows, 'own');
  assert.deepEqual(light.follows === 'own' ? light.own : undefined, { power: 'on', brightness: 80, colour: { kind: 'kelvin', kelvin: 2200 }, effect: 'Normal' });
});

test('an off block light has no colour', () => {
  // Break: an off block light reads a stale brightness or colour from its attributes.
  const config = decode({ 'light.ls_house_cosy': state('off', { brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 2700 }) });
  assert.deepEqual(house(config, 'cosy').light, { power: 'off' });
});

test('a lit block light with no colour has none', () => {
  // Break: a missing colour is replaced by white or a default temperature.
  const config = decode({ 'light.ls_house_cosy': state('on', { brightness: 120 }) });
  assert.deepEqual(house(config, 'cosy').light, { power: 'on', brightness: 120, colour: undefined, effect: 'Normal' });
  const twoChannels = decode({ 'light.ls_house_cosy': state('on', { brightness: 120, color_mode: 'rgb', rgb_color: [255, 150] }) });
  assert.deepEqual(house(twoChannels, 'cosy').light, { power: 'on', brightness: 120, colour: undefined, effect: 'Normal' });
});

test('an rgb block light reads its three channels', () => {
  const config = decode({ 'light.ls_house_cosy': state('on', { brightness: 120, color_mode: 'rgb', rgb_color: [255, 150, 60] }) });
  assert.deepEqual(house(config, 'cosy').light, {
    power: 'on', brightness: 120, colour: { kind: 'rgb', rgb: { red: 255, green: 150, blue: 60 } }, effect: 'Normal',
  });
});

test('a block light that is missing or unreadable is no light', () => {
  // Break: a missing or unavailable light is read as off, or an unreadable level raises.
  assert.equal(decode({ 'light.ls_house_cosy': undefined }).house.cosy.light, undefined);
  assert.equal(decode({ 'light.ls_house_cosy': state('unavailable') }).house.cosy.light, undefined);
  assert.equal(decode({ 'light.ls_house_cosy': state('on', { brightness: 'bright' }) }).house.cosy.light, undefined);
  assert.equal(decode({ 'light.ls_house_cosy': state('on', { brightness: 300 }) }).house.cosy.light, undefined);
});

test('a block light names the effect its saved profile stores: the candle, and anything else is normal', () => {
  // Break: the effect is read from the wrong block's profile, or any non-Candle name is kept.
  const effectOf = (config: Config, block: Block) => {
    const light = house(config, block).light;
    assert.equal(light?.power, 'on');
    return light?.power === 'on' ? light.effect : undefined;
  };
  const candleCosy = decode({ 'input_text.ls_house_cosy': state(JSON.stringify({ effect: 'Candle' })) });
  assert.equal(effectOf(candleCosy, 'cosy'), 'Candle');
  assert.equal(effectOf(candleCosy, 'day'), 'Normal');
  for (const stored of [JSON.stringify({ effect: 'Normal light' }), JSON.stringify({ effect: 'Breathe' }), JSON.stringify({}), 'not json', 'unknown']) {
    assert.equal(effectOf(decode({ 'input_text.ls_house_cosy': state(stored) }), 'cosy'), 'Normal');
  }
});

test('a room block light names the effect of its own room profile', () => {
  const own = { 'input_boolean.ls_room-a_cosy_own_light': state('on'), 'light.ls_room-a_cosy': state('on', { brightness: 80 }),
    'input_text.ls_room-a_cosy': state(JSON.stringify({ effect: 'Candle' })) };
  const light = roomBlock(decode(own), 'cosy').light;
  assert.deepEqual(light.follows === 'own' ? light.own : undefined, { power: 'on', brightness: 80, colour: undefined, effect: 'Candle' });
});

test('the switches in a block follow the house, or the room when it has its own light', () => {
  const own = { 'input_boolean.ls_room-a_day_own_light': state('on'), 'input_boolean.ls_room-a_day_on_off': state('off') };
  assert.deepEqual(roomBlock(decode(), 'day').switchesOn, { follows: 'house' });
  assert.deepEqual(roomBlock(decode(own), 'day').switchesOn, { follows: 'own', own: false });
});

test('a helper that is unavailable is its default', () => {
  // Break: an unavailable helper raises, or reads as a value.
  const unavailable = (entity: string) => ({ [entity]: state('unavailable') });
  const config = decode({
    ...unavailable('input_number.ls_house_day_fade'),
    ...unavailable('input_boolean.ls_house_day_on_off'),
    ...unavailable('input_boolean.ls_ovr_next_block_on'),
    ...unavailable('input_boolean.ls_ovr_after_on'),
    ...unavailable('input_boolean.ls_ovr_at_on'),
    ...unavailable('input_datetime.ls_house_day_start'),
    'input_datetime.ls_room-a_wake': state('unavailable', { timestamp: 1_790_000_000 }),
  });
  assert.equal(config.house.day.fade, DEFAULT_FADE);
  assert.equal(config.house.day.switchesOn, false);
  assert.equal(config.house.day.weekdayStart, undefined);
  assert.deepEqual(config.overlayReset, { atNextBlock: false, atSetTime: undefined, afterAge: undefined });
  assert.equal(config.rooms[roomA]!.wakeLight, undefined);
});

test('a room reads its wake light from the helper timestamp and fade, and a missing fade is the default', () => {
  const wake = { 'input_datetime.ls_room-a_wake': state('06:30:00', { timestamp: 1_790_000_000 }) };
  assert.equal(DEFAULT_WAKE_FADE, toMinutes(37.5));
  assert.deepEqual(decode(wake).rooms[roomA]!.wakeLight, { at: toInstant(1_790_000_000), fade: DEFAULT_WAKE_FADE });
  assert.deepEqual(decode({ ...wake, 'input_number.ls_room-a_wake_fade': state('15') }).rooms[roomA]!.wakeLight, { at: toInstant(1_790_000_000), fade: toMinutes(15) });
  assert.equal(decode({ 'input_datetime.ls_room-a_wake': state('06:30:00', { timestamp: 'soon' }) }).rooms[roomA]!.wakeLight, undefined);
  assert.equal(decode().rooms[roomA]!.wakeLight, undefined);
});

test('a remote with no room has none', () => {
  // Break: a remote whose device the registry places in no room gets a made-up room.
  const config = decode();
  assert.equal(config.remotes[toRemoteId('device-remote-a')]!.room, roomA);
  assert.equal(config.remotes[toRemoteId('device-remote-b')]!.room, undefined);
  assert.equal(config.remotes[toRemoteId('device-remote-b')]!.source, 'source-b');
});

test('a lamp reads its room and its bulbs with their firmware, and a lamp in no area has no room', () => {
  const config = decode({}, { rooms: parseRooms({ 'light.lamp_a': 'room-a', 'light.lamp_b': '' }) });
  const lamp = config.lamps[toLampId('light.lamp_a')]!;
  assert.equal(lamp.room, roomA);
  assert.deepEqual(lamp.bulbs, [{ bulb: toBulbId('light.bulb_a1'), firmware: 'candle' }, { bulb: toBulbId('light.bulb_a2'), firmware: 'stock' }]);
  assert.equal(config.lamps[toLampId('light.lamp_b')]!.room, undefined);
});

test('the rooms are those of the lamps, switches and remotes, and the switches are the on/off label', () => {
  const config = decode();
  assert.deepEqual(Object.keys(config.rooms).sort(), [roomA, roomB]);
  assert.deepEqual(Object.keys(config.switches), ['switch.plug_a']);
  assert.equal(config.switches[toSwitchId('switch.plug_a')]!.room, roomA);
});

test('a room is private when the private-rooms label names it', () => {
  // Break: every room is private, or none, or the label is read by position.
  const config = decode({}, { labels: { on_off: ['switch.plug_a'], private_room: ['room-b'] } });
  assert.equal(config.rooms[roomA]!.private, false);
  assert.equal(config.rooms[roomB]!.private, true);
  assert.equal(decode().rooms[roomB]!.private, false);
});

test('the timezone is the source\'s, and today\'s default zone when absent', () => {
  assert.equal(decode().timezone, 'Europe/Berlin');
  assert.equal(decode({}, { timezone: undefined }).timezone, 'Europe/Stockholm');
});

test('the warm end is the helper\'s three numbers, and 255, 126, 0 otherwise', () => {
  // Break: a malformed warm end raises, or its default changes.
  const warm = (rgb: JsonObject[string] | undefined) =>
    decode({ 'light.candle_test_rgb_warm_end': state('on', rgb === undefined ? {} : { rgb_color: rgb }) }).warmEnd;
  assert.deepEqual(warm([200, 100, 50]), { red: 200, green: 100, blue: 50 });
  for (const bad of [undefined, [200, 100], 'warm', null, [200, 100, 300], [200, 'a', 5]]) {
    assert.deepEqual(warm(bad), { red: 255, green: 126, blue: 0 });
  }
  assert.deepEqual(decode().warmEnd, { red: 255, green: 126, blue: 0 });
});

test('each overlay reset rule reads its own helper', () => {
  // Break: two rules share a helper, the set time reads the age's switch, or the time helper is ignored.
  const reset = (changes: Record<string, EntityState>) => decode(changes).overlayReset;
  assert.deepEqual(reset({}), { atNextBlock: false, atSetTime: undefined, afterAge: undefined });
  assert.deepEqual(reset({ 'input_boolean.ls_ovr_next_block_on': state('on') }), { atNextBlock: true, atSetTime: undefined, afterAge: undefined });
  assert.deepEqual(reset({ 'input_boolean.ls_ovr_at_on': state('on'), 'input_datetime.ls_ovr_at': state('04:15:00') }),
    { atNextBlock: false, atSetTime: toTimeOfDay(4, 15), afterAge: undefined });
  assert.deepEqual(reset({ 'input_boolean.ls_ovr_after_on': state('on'), 'input_number.ls_ovr_after_min': state('45') }),
    { atNextBlock: false, atSetTime: undefined, afterAge: toMinutes(45) });
  // The time and the age are read only while their own switch is on.
  assert.deepEqual(reset({ 'input_datetime.ls_ovr_at': state('04:15:00'), 'input_number.ls_ovr_after_min': state('45') }),
    { atNextBlock: false, atSetTime: undefined, afterAge: undefined });
});

test('the after-age rule on with an unreadable limit is the default age', () => {
  assert.equal(DEFAULT_OVERLAY_AGE, toMinutes(180));
  for (const limit of ['garbage', 'unknown', '-1']) {
    assert.equal(decode({ 'input_boolean.ls_ovr_after_on': state('on'), 'input_number.ls_ovr_after_min': state(limit) }).overlayReset.afterAge, DEFAULT_OVERLAY_AGE);
  }
  assert.equal(decode({ 'input_boolean.ls_ovr_after_on': state('on') }).overlayReset.afterAge, DEFAULT_OVERLAY_AGE);
});

test('the set-time rule on with an unreadable time is off', () => {
  assert.equal(decode({ 'input_boolean.ls_ovr_at_on': state('on'), 'input_datetime.ls_ovr_at': state('25:00:00') }).overlayReset.atSetTime, undefined);
});

test('a bulb in two lamps is refused', () => {
  // Break: the catalog accepts shared membership, so two lamps would send one bulb two lights.
  assert.throws(() => parseCatalog({ members: { 'light.lamp_a': ['light.bulb_a1'], 'light.lamp_b': ['light.bulb_a1'] } }), ParseError);
});

test('bulbTopics lists every bulb with a topic', () => {
  // Break: a bulb is dropped, or given another bulb's topic.
  assert.deepEqual(bulbTopics(catalog()), {
    'light.bulb_a1': 'zigbee2mqtt/a1', 'light.bulb_a2': 'zigbee2mqtt/a2', 'light.bulb_b1': 'zigbee2mqtt/b1',
  });
  const partial = parseCatalog({ members: { 'light.lamp_a': ['light.bulb_a1', 'light.bulb_a2'] }, topics: { 'light.bulb_a2': 'zigbee2mqtt/a2' } });
  assert.deepEqual(bulbTopics(partial), { 'light.bulb_a2': 'zigbee2mqtt/a2' });
});
