import assert from 'node:assert/strict';
import test from 'node:test';
import { configSource, decodeModel } from '../../src/adapter/codecs/model.ts';
import { haInput, messages } from '../../src/adapter/codecs/inputs.ts';
import type { Msg } from '../../src/domain/model.ts';
import type { Colour } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toBrightness, toColourChannel, toInstant, toKelvin, toLampId, toRoomId } from '../../src/adapter/codecs/ids.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { EntityState, JsonObject } from '../../src/adapter/ha-client.ts';
import type { HouseView } from '../../src/adapter/codecs/house.ts';
import { ParseError } from '../../src/adapter/codecs/parse.ts';
import { CATALOG, houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';

/**
 * A person's light call as the lamp-change detector reads it (today's
 * `effects_native_plan`): every colour key Home Assistant's light.turn_on takes
 * (`nativeColor`), and every way a call names its lamps (`planNativeControls`'
 * targets). The synthetic house at noon on Monday 2026-09-21 (UTC).
 */

const NOW_TEXT = '2026-09-21T12:00:00Z';
const NOW: Instant = toInstant(Date.parse(NOW_TEXT) / 1000);
const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2'), lampB1 = toLampId('light.lamp_b1');
const roomA = toRoomId('room-a');
const DETECTOR = 'automation.lighting_schedule_lamp_change_detector';

type Change = (house: HouseView, states: Record<string, EntityState>) => HouseView;

function house(change: Change = view => view): HouseView {
  const states = syntheticStates();
  writeBack(world(), states);
  return change(houseView(states, NOW_TEXT), states);
}

function read(serviceData: JsonObject, view: HouseView = house()): Msg[] {
  const input = haInput(DETECTOR, { trigger: { event: { data: { domain: 'light', service: 'turn_on', service_data: serviceData },
    context: { id: 'ctx-1', user_id: 'person-1' } } } });
  assert.ok(input !== undefined);
  return messages(input, decodeModel(configSource(view), view.catalog), NOW, view);
}

/** The colour a call on `light.lamp_a1` asks for. */
function colourOf(extra: JsonObject): Colour | undefined {
  const [msg] = read({ entity_id: lampA1, ...extra });
  assert.ok(msg !== undefined && msg.kind === 'lampChangedByPerson' && msg.light.power === 'on');
  return msg.light.colour;
}

/** The lamps and the rooms named whole a call reaches. */
function reach(serviceData: JsonObject, view: HouseView = house()): { lamps: string[]; rooms: string[] } {
  const [msg] = read({ ...serviceData, brightness: 80 }, view);
  if (msg === undefined) return { lamps: [], rooms: [] };
  assert.ok(msg.kind === 'lampChangedByPerson');
  return { lamps: [...msg.lamps], rooms: [...msg.rooms] };
}

const rgb = (red: number, green: number, blue: number): Colour =>
  ({ kind: 'rgb', rgb: { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) } });
const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });

// The colour keys, each alone.

test('color_temp_kelvin, kelvin and color_temp (mireds) are a colour temperature', () => {
  // Break: a temperature key is not read, so the lamp's change gets no colour hold.
  assert.deepEqual(colourOf({ color_temp_kelvin: 3000 }), kelvin(3000));
  assert.deepEqual(colourOf({ kelvin: 2700 }), kelvin(2700));
  assert.deepEqual(colourOf({ color_temp: 250 }), kelvin(4000));
});

test('rgb_color is itself', () => {
  assert.deepEqual(colourOf({ rgb_color: [10, 20, 30] }), rgb(10, 20, 30));
});

test('hs_color is the colour wheel: hue and saturation to rgb at full value', () => {
  // Break: a colour-wheel pick in the app gets no hold, and the next tick takes the lamp back.
  assert.deepEqual(colourOf({ hs_color: [30, 100] }), rgb(255, 128, 0));
  assert.deepEqual(colourOf({ hs_color: [-120, 50] }), rgb(128, 128, 255));
  assert.deepEqual(colourOf({ hs_color: [0, 0] }), rgb(255, 255, 255));
});

test('xy_color is CIE xy to rgb, scaled to its peak; a y of zero or less is black', () => {
  assert.deepEqual(colourOf({ xy_color: [0.3127, 0.329] }), rgb(245, 254, 255));
  assert.deepEqual(colourOf({ xy_color: [0.4, 0] }), rgb(0, 0, 0));
});

test('rgbw_color adds the white channel to each colour, at the brightest channel', () => {
  assert.deepEqual(colourOf({ rgbw_color: [255, 0, 0, 255] }), rgb(255, 128, 128));
});

test('rgbww_color mixes the lamp\'s coldest and warmest white into the colour', () => {
  // The synthetic lamps report no kelvin range, so it is today's 2000..6500 K.
  assert.deepEqual(colourOf({ rgbww_color: [0, 0, 0, 255, 0] }), rgb(255, 254, 250));
});

test('color_name is the named CSS colour, any case and spacing; an unknown name is no colour', () => {
  assert.deepEqual(colourOf({ color_name: 'Dark Orange' }), rgb(255, 140, 0));
  assert.equal(colourOf({ color_name: 'not a colour' }), undefined);
});

test('white is white, and its number is the brightness', () => {
  const [msg] = read({ entity_id: lampA1, white: 120 });
  assert.deepEqual(msg, { kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], at: NOW,
    light: { power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(120) }, colour: rgb(255, 255, 255), effect: undefined } });
});

test('the first colour key wins, in today\'s order', () => {
  // Break: the keys are read in another order, so a call naming two colours holds the other one.
  assert.deepEqual(colourOf({ color_temp_kelvin: 3000, rgb_color: [1, 2, 3], hs_color: [30, 100] }), kelvin(3000));
  assert.deepEqual(colourOf({ rgb_color: [1, 2, 3], hs_color: [30, 100] }), rgb(1, 2, 3));
  assert.deepEqual(colourOf({ hs_color: [30, 100], xy_color: [0.3, 0.3] }), rgb(255, 128, 0));
  assert.deepEqual(colourOf({ color_name: 'red', white: 50 }), rgb(255, 0, 0));
});

test('a colour key whose value cannot be read raises, as today', () => {
  for (const extra of [{ hs_color: [30] }, { xy_color: 'x' }, { rgbw_color: [1, 2, 3] }, { rgbww_color: [1, 2, 3, 4] }]) {
    assert.throws(() => colourOf(extra), ParseError, JSON.stringify(extra));
  }
});

// The targets.

test('an entity list given as text is split on commas', () => {
  assert.deepEqual(reach({ entity_id: `${lampA1},${lampB1}` }), { lamps: [lampA1, lampB1], rooms: [] });
});

test('an area reaches every lamp in it and names it whole', () => {
  assert.deepEqual(reach({ area_id: roomA }), { lamps: [lampA1, lampA2], rooms: [roomA] });
});

test('a device reaches the lamps its entities are', () => {
  // Break: a call aimed at a device holds nothing, and the next tick takes the lamp back.
  const view = house(view => ({ ...view, devices: { ...view.devices, 'device-b1': [lampB1] } }));
  assert.deepEqual(reach({ device_id: 'device-b1' }, view), { lamps: [lampB1], rooms: [] });
});

test('a label reaches the lamps it is on', () => {
  const view = house(view => ({ ...view, labels: { ...view.labels, reading: [lampA2] } }));
  assert.deepEqual(reach({ label_id: ['reading'] }, view), { lamps: [lampA2], rooms: [] });
});

test('a call on a lamp\'s own bulb reaches the lamp', () => {
  assert.deepEqual(reach({ entity_id: 'bulb-a3' }), { lamps: [lampA2], rooms: [] });
});

test('a Home Assistant group reaches its members, nested, without naming their room whole', () => {
  // Today a room is named whole only by an area or a catalog group.
  const view = house((view, states) => {
    states['group.upstairs'] = { state: 'on', attributes: { entity_id: [lampA1, 'group.inner'] } };
    states['group.inner'] = { state: 'on', attributes: { entity_id: [lampA2] } };
    states['light.room_a_lights'] = { state: 'on', attributes: { entity_id: [lampA1, lampA2] } };
    return { ...view, entitySources: { 'light.room_a_lights': 'group' } };
  });
  assert.deepEqual(reach({ entity_id: 'group.upstairs' }, view), { lamps: [lampA1, lampA2], rooms: [] });
  assert.deepEqual(reach({ entity_id: 'light.room_a_lights' }, view), { lamps: [lampA1, lampA2], rooms: [] });
});

test('a zone reaches its persons, which are no lamps', () => {
  const view = house((view, states) => {
    states['zone.home'] = { state: '1', attributes: { persons: ['person.someone'] } };
    states['person.someone'] = { state: 'home', attributes: {} };
    return view;
  });
  assert.deepEqual(reach({ entity_id: 'zone.home' }, view), { lamps: [], rooms: [] });
});

test('a catalog group reaches its lamps, and names whole each room whose every lamp it holds', () => {
  const view = house(view => ({ ...view, catalog: parseCatalog({ ...CATALOG, groups: { 'light.room_a_group': [lampA1, lampA2] } }) }));
  assert.deepEqual(reach({ entity_id: 'light.room_a_group' }, view), { lamps: [lampA1, lampA2], rooms: [roomA] });
  const partial = house(view => ({ ...view, catalog: parseCatalog({ ...CATALOG, groups: { 'light.some_of_a': [lampA1] } }) }));
  assert.deepEqual(reach({ entity_id: 'light.some_of_a' }, partial), { lamps: [lampA1], rooms: [] });
});

test('a target that is not text raises, as today', () => {
  for (const key of ['entity_id', 'area_id', 'device_id', 'label_id']) {
    assert.throws(() => reach({ [key]: [7] }), ParseError, key);
  }
});
