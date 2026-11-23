/**
 * The synthetic house as Home Assistant shows it to the adapter: its states,
 * rooms, labels and devices, the catalog with a topic per bulb, the Zigbee
 * bridge connected, and the clock. Each bulb is an entity of its own, kept by
 * a `FakeBulbs` world that the publishes move.
 */
import type { MqttTopic } from '../../../src/adapter/encode.ts';
import type { BulbId } from '../../../src/domain/types/ids.ts';
import { entriesOf } from '../../../src/domain/types/ids.ts';
import { toMqttTopic } from '../../../src/parse/ids.ts';
import { parseRooms } from '../../../src/parse/rooms.ts';
import { parseCatalog } from '../../../src/runtime/catalog.ts';
import type { EntityState, JsonObject } from '../../../src/runtime/context.ts';
import type { HouseView } from '../../../src/runtime/effects.ts';
import { FakeBulbs } from '../fake-bulbs.ts';
import { syntheticSource } from './synthetic-house.ts';

/** The catalog document: the synthetic catalog with a topic per bulb and one live control over `room-a`. */
export const CATALOG: JsonObject = {
  members: { 'light.lamp_a1': ['bulb-a1', 'bulb-a2'], 'light.lamp_a2': ['bulb-a3'], 'light.lamp_b1': ['bulb-b1'] },
  bulbs: { 'bulb-a1': { candle: true } },
  remotes: { 'room-a': { device_id: 'remote-a', source: 'remote-a' }, unplaced: { device_id: 'remote-b', source: 'remote-b' } },
  topics: { 'bulb-a1': 'zigbee2mqtt/bulb-a1', 'bulb-a2': 'zigbee2mqtt/bulb-a2', 'bulb-a3': 'zigbee2mqtt/bulb-a3', 'bulb-b1': 'zigbee2mqtt/bulb-b1' },
  ui_rows: [{
    source: 'light.room_a_all', proxy: 'light.ep_room_a_all', store: '', members: ['light.lamp_a1', 'light.lamp_a2'],
    topics: { power: 'house/v1/effect_preview/room_a_all/set/power', brightness: 'house/v1/effect_preview/room_a_all/set/brightness',
      temperature: 'house/v1/effect_preview/room_a_all/set/temperature', effect: 'house/v1/effect_preview/room_a_all/set/effect' },
  }],
};

/** The synthetic source's states with no overlays stored, the bridge connected, and the given changes. */
export function syntheticStates(change: (states: Record<string, EntityState>) => void = () => {}): Record<string, EntityState> {
  const states = structuredClone(syntheticSource().states) as Record<string, EntityState>;
  const sensor = states['sensor.ls_overrides']!;
  sensor.attributes = { overrides: {}, power: {}, switch_ranges: sensor.attributes.switch_ranges!, range_defaults: sensor.attributes.range_defaults! };
  states['binary_sensor.zigbee2mqtt_bridge_connection_state'] = { state: 'on', attributes: {} };
  states['switch.plug_a'] = { state: 'off', attributes: {} };
  change(states);
  return states;
}

/** The house at `now` (ISO text) over `states`, which the test keeps and the world writes back into. */
export function houseView(states: Record<string, EntityState>, now: string): HouseView {
  const source = syntheticSource();
  const catalog = parseCatalog(CATALOG);
  return {
    state: states,
    rooms: parseRooms({ 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b', 'switch.plug_a': 'room-a',
      'remote-a': 'room-a' }),
    members: [],
    labels: { on_off: ['switch.plug_a'], private_room: ['room-b'] },
    devices: { 'device-plug-a': ['switch.plug_a'] },
    entitySources: {},
    timezone: source.timezone,
    now,
    catalog,
    get: entity => states[entity] === undefined ? 'unknown' : states[entity].state,
    attr: (entity, key) => states[entity]?.attributes[key],
  };
}

/** The bulbs' world: every bulb starts on at full, as `FakeBulbs` does. */
export function world(): FakeBulbs {
  const topics: Record<BulbId, MqttTopic> = Object.fromEntries(entriesOf(CATALOG.topics as Record<BulbId, string>)
    .map(([bulb, topic]) => [bulb, toMqttTopic(topic)]));
  return new FakeBulbs(topics);
}

/** What the bulbs show, written into the states as Home Assistant reports them. */
export function writeBack(bulbs: FakeBulbs, states: Record<string, EntityState>): void {
  for (const bulb of Object.keys(CATALOG.topics as JsonObject) as BulbId[]) {
    const shown = bulbs.shows(bulb);
    if (shown.reach === 'unreachable') { states[bulb] = { state: 'unavailable', attributes: {} }; continue; }
    const light = shown.light;
    if (light.power === 'off') { states[bulb] = { state: 'off', attributes: {} }; continue; }
    const colour = light.colour;
    const attributes: JsonObject = colour === undefined ? { brightness: light.level }
      : colour.kind === 'kelvin' ? { brightness: light.level, color_mode: 'color_temp', color_temp_kelvin: colour.kelvin }
        : { brightness: light.level, color_mode: 'rgb', rgb_color: [colour.rgb.red, colour.rgb.green, colour.rgb.blue] };
    states[bulb] = { state: 'on', attributes };
  }
  for (const [lamp, members] of Object.entries(CATALOG.members as Record<string, string[]>)) {
    states[lamp] = { state: members.some(bulb => states[bulb]?.state === 'on') ? 'on' : 'off', attributes: { entity_id: members } };
  }
}
