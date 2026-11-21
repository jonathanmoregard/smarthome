import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityState, ServiceCall, Snapshot } from '../../src/runtime/context.ts';
import { drivenLamps, liveScope, switchedOnRoom } from '../../src/runtime/live-rooms.ts';
import type { Origin } from '../../src/runtime/host.ts';
import type { LiveRooms } from '../../src/parse/live-rooms.ts';
import type { JsonObject } from '../../src/runtime/context.ts';
import { parseLiveRooms, readLiveRoomsFlag } from '../../src/parse/live-rooms.ts';

/**
 * A made-up house: two rooms with one lamp of one bulb each, a lamp the
 * registry puts in no room, and a remote per room. Both rooms' port switches
 * are on, so the list given to the port is what decides.
 */
function house(switches: Record<string, 'on' | 'off'> = { studio: 'on', den: 'on' }): Snapshot {
  const state: Record<string, EntityState> = {
    'sensor.ls_overrides': { state: '0', attributes: {} },
    'sensor.ls_effects_runtime': { state: '0', attributes: {} },
  };
  for (const [room, value] of Object.entries(switches)) state[`input_boolean.ls_${room}_on_port`] = { state: value, attributes: {} };
  return {
    now: '2026-10-26T12:00:00Z', members: [], state,
    areas: { 'light.studio': 'studio', 'light.studio_bulb': 'studio', 'switch.studio_fan': 'studio', 'light.den': 'den',
      'light.den_bulb': 'den', 'switch.den_fan': 'den', 'remote-s': 'studio', 'remote-d': 'den' },
    catalog: {
      members: { 'light.studio': ['light.studio_bulb'], 'light.den': ['light.den_bulb'], 'light.loose': ['light.loose_bulb'] },
      groups: {}, effects: {},
      topics: { 'light.studio_bulb': 'zigbee2mqtt/studio_bulb/set', 'light.den_bulb': 'zigbee2mqtt/den_bulb/set',
        'light.loose_bulb': 'zigbee2mqtt/loose_bulb/set' },
      remotes: { studio: { source: 'remote-studio', device_id: 'remote-s' }, den: { source: 'remote-den', device_id: 'remote-d' },
        attic: { source: 'remote-attic', device_id: 'remote-nowhere' } },
      ui_rows: [
        { source: 'light.studio', topics: { power: 'house/v1/effect_preview/studio_lamp/set/power' } },
        { source: 'light.den', topics: { power: 'house/v1/effect_preview/den_lamp/set/power' } },
      ],
    },
  };
}
const guarded = (owners: string[], topic: string): ServiceCall => ({ service: 'mqtt.publish', data: { topic, payload: '{}' },
  guard: { revision: 'r', generation: 'g', owners, members: [] } });
const turn = (service: string, entity: string): ServiceCall => ({ service, data: {}, target: { entity_id: entity } });
const sensor = (entity: string): ServiceCall => ({ service: 'variable.update_sensor', data: { attributes: {} }, target: { entity_id: entity } });
const house_: Origin = { kind: 'house' };
const inStudio: Origin = { kind: 'rooms', rooms: [...parseLiveRooms('studio')] };
/** Whether the scope sends the call whole, for a batch from the house unless another origin is named. */
const sendsWhole = (scope: ReturnType<typeof liveScope>, call: ServiceCall, view: Snapshot, origin: Origin = house_) => {
  const parts = scope.share(call, view, origin);
  assert.ok(parts.length === 0 || (parts.length === 1 && parts[0] === call), `expected the call whole or nothing, got ${JSON.stringify(parts)}`);
  return parts.length === 1;
};
/** Whether the scope runs an input at all (the port owns it). */
const drives = (live: LiveRooms, script: string, args: JsonObject, view: Snapshot) => liveScope(live).origin(script, args, view) !== undefined;

test('the live rooms are refused when the setting is missing, so a missing list never means every room', () => {
  assert.throws(() => parseLiveRooms(undefined), /--live-rooms/);
  assert.throws(() => readLiveRoomsFlag(['--live', '--config', 'catalog.json']), /--live-rooms/);
  assert.throws(() => readLiveRoomsFlag(['--live-rooms', '--live']), /--live-rooms/);
});

test('an empty live-room setting is an empty list, and a list names its rooms', () => {
  assert.equal(parseLiveRooms('').size, 0);
  assert.equal(readLiveRoomsFlag(['--live-rooms', '']).size, 0);
  assert.deepEqual([...parseLiveRooms('studio,den')].sort(), ['den', 'studio']);
  assert.deepEqual([...readLiveRoomsFlag(['--live-rooms', 'studio'])], ['studio']);
});

test('a live-room list with an empty entry is refused', () => {
  assert.throws(() => parseLiveRooms('studio,,den'), /empty room/);
  assert.throws(() => parseLiveRooms('studio,'), /empty room/);
});

test('lamp commands are sent only to lamps in live rooms', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(sendsWhole(scope, guarded(['light.studio'], 'zigbee2mqtt/studio_bulb/set'), view), true);
  assert.equal(sendsWhole(scope, guarded(['light.den'], 'zigbee2mqtt/den_bulb/set'), view), false);
  assert.equal(sendsWhole(scope, turn('light.turn_on', 'light.studio'), view), true);
  assert.equal(sendsWhole(scope, turn('light.turn_off', 'light.den'), view), false);
});

test('a command to a bulb topic with no owners is placed by the bulb', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  const bare = (topic: string): ServiceCall => ({ service: 'mqtt.publish', data: { topic, payload: '{}' } });
  assert.equal(sendsWhole(scope, bare('zigbee2mqtt/studio_bulb/set'), view), true);
  assert.equal(sendsWhole(scope, bare('zigbee2mqtt/den_bulb/set'), view), false);
});

test('switch commands are sent only to switches in live rooms', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(sendsWhole(scope, turn('homeassistant.turn_on', 'switch.studio_fan'), view), true);
  assert.equal(sendsWhole(scope, turn('homeassistant.turn_off', 'switch.den_fan'), view), false);
  assert.equal(sendsWhole(scope, turn('switch.turn_on', 'switch.den_fan'), view), false);
});

test('a group publish over a live and a not-live lamp sends the live lamp its share, on its own bulb topic', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  const group: ServiceCall = { service: 'mqtt.publish', data: { topic: 'zigbee2mqtt/group/set', payload: '{"state":"ON"}', qos: 0, retain: false },
    guard: { revision: 'r', generation: 'g', owners: ['light.den', 'light.studio'], members: ['light.den_bulb', 'light.studio_bulb'] } };
  assert.deepEqual(scope.share(group, view, house_), [{ service: 'mqtt.publish',
    data: { topic: 'zigbee2mqtt/studio_bulb/set', payload: '{"state":"ON"}', qos: 0, retain: false },
    guard: { revision: 'r', generation: 'g', owners: ['light.studio'], members: ['light.studio_bulb'] } }]);
});

test('a switching call over a live and a not-live lamp is sent for the live lamp only', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.deepEqual(scope.share({ service: 'light.turn_on', data: { brightness: 3 }, target: { entity_id: ['light.studio', 'light.den'] } }, view, house_),
    [{ service: 'light.turn_on', data: { brightness: 3 }, target: { entity_id: ['light.studio'] } }]);
  assert.deepEqual(scope.share({ service: 'homeassistant.turn_off', data: { entity_id: ['switch.den_fan', 'switch.studio_fan'] } }, view, house_),
    [{ service: 'homeassistant.turn_off', data: { entity_id: ['switch.studio_fan'] } }]);
});

test('a lamp the registry puts in no room is not in a live room', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(sendsWhole(scope, guarded(['light.loose'], 'zigbee2mqtt/loose_bulb/set'), view), false);
  assert.equal(sendsWhole(scope, turn('light.turn_on', 'light.loose'), view), false);
});

test('a live room whose port switch is off gets nothing, so switching it off hands the room back', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house({ studio: 'off', den: 'on' });
  assert.equal(sendsWhole(scope, guarded(['light.studio'], 'zigbee2mqtt/studio_bulb/set'), view), false);
  assert.equal(sendsWhole(scope, turn('homeassistant.turn_on', 'switch.studio_fan'), view), false);
  const missing = house({ den: 'on' });
  assert.equal(sendsWhole(scope, turn('light.turn_on', 'light.studio'), missing), false);
});

test('an empty live-room list sends nothing at all', () => {
  const scope = liveScope(parseLiveRooms('')), view = house();
  assert.equal(sendsWhole(scope, guarded(['light.studio'], 'zigbee2mqtt/studio_bulb/set'), view), false);
  assert.equal(sendsWhole(scope, turn('light.turn_on', 'light.studio'), view), false);
  assert.equal(sendsWhole(scope, turn('homeassistant.turn_on', 'switch.studio_fan'), view), false);
  assert.equal(sendsWhole(scope, sensor('sensor.ls_overrides'), view), false);
  assert.equal(sendsWhole(scope, turn('input_boolean.turn_off', 'input_boolean.ls_sara_mode_mirror'), view), false);
});

test('a room cache is written only for a live room', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(sendsWhole(scope, sensor('sensor.ls_cache_studio'), view), true);
  assert.equal(sendsWhole(scope, sensor('sensor.ls_cache_den'), view), false);
});

test('in-process scripts always run, from any origin', () => {
  const scope = liveScope(parseLiveRooms('')), view = house();
  assert.equal(sendsWhole(scope, turn('script.turn_on', 'script.ls_render'), view), true);
  assert.equal(sendsWhole(scope, turn('script.turn_off', 'script.ls_render'), view), true);
});

test('while some room is on the old scripts, a house event writes nothing house-wide: the old scripts commit it', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(sendsWhole(scope, sensor('sensor.ls_overrides'), view), false);
  assert.equal(sendsWhole(scope, { service: 'input_text.set_value', data: { value: 'x' }, target: { entity_id: 'input_text.ls_house_day' } }, view), false);
  assert.equal(sendsWhole(scope, { service: 'mqtt.publish', data: { topic: 'house/v1/effect_preview/den_lamp/state', payload: '{}' } }, view), false);
  assert.equal(sendsWhole(scope, turn('input_boolean.turn_on', 'input_boolean.ls_sara_mode_mirror'), view), false);
});

test('an input from a driven room writes its own records house-wide, but never the dashboard mirror', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(sendsWhole(scope, sensor('sensor.ls_overrides'), view, inStudio), true);
  assert.equal(sendsWhole(scope, { service: 'input_number.set_value', data: { value: 1 }, target: { entity_id: 'input_number.ls_studio_remote_steps' } },
    view, inStudio), true);
  assert.equal(sendsWhole(scope, { service: 'mqtt.publish', data: { topic: 'house/v1/effect_preview/studio_lamp/state', payload: '{}' } }, view,
    inStudio), false);
  assert.equal(sendsWhole(scope, turn('input_boolean.turn_on', 'input_boolean.ls_sara_mode_mirror'), view, inStudio), false);
  assert.equal(sendsWhole(scope, { service: 'input_select.select_option', data: { option: 'Day' }, target: { entity_id: 'input_select.ls_studio_override' } },
    view, inStudio), false);
});

test('a driven room\'s input whose room is handed back before its output goes out writes nothing house-wide', () => {
  const scope = liveScope(parseLiveRooms('studio'));
  assert.equal(sendsWhole(scope, sensor('sensor.ls_overrides'), house({ studio: 'off', den: 'on' }), inStudio), false);
});

test('once every room is driven, every house-wide write and mirror is the port\'s', () => {
  const scope = liveScope(parseLiveRooms('studio,den')), view = house();
  assert.equal(sendsWhole(scope, sensor('sensor.ls_overrides'), view), true);
  assert.equal(sendsWhole(scope, { service: 'mqtt.publish', data: { topic: 'house/v1/effect_preview/den_lamp/state', payload: '{}' } }, view), true);
  assert.equal(sendsWhole(scope, turn('input_boolean.turn_on', 'input_boolean.ls_sara_mode_mirror'), view), true);
});

test('the render bookkeeping stays in the port while some room is still on the old scripts', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.equal(scope.keeps('sensor.ls_effects_runtime', view), true);
  assert.equal(sendsWhole(scope, sensor('sensor.ls_effects_runtime'), view), false);
  assert.equal(scope.keeps('sensor.ls_overrides', view), false);
});

test('once every room is live the render bookkeeping is shared again', () => {
  // The lamp in no room makes no room of its own, so studio and den are the whole house.
  const scope = liveScope(parseLiveRooms('studio,den')), view = house();
  assert.equal(scope.keeps('sensor.ls_effects_runtime', view), false);
  assert.equal(sendsWhole(scope, sensor('sensor.ls_effects_runtime'), view), true);
  assert.equal(scope.keeps('sensor.ls_effects_runtime', house({ studio: 'on', den: 'off' })), true);
});

test('a remote press in a room that is not live does nothing in the port', () => {
  const live = parseLiveRooms('studio'), view = house();
  const press = (room: string) => ({ room, trigger: { platform: 'mqtt', topic: 'zigbee2mqtt/x/action', payload: 'on' } });
  assert.equal(drives(live, 'automation.lighting_studio_remote_center', press('studio'), view), true);
  assert.equal(drives(live, 'automation.lighting_den_remote_center', press('den'), view), false);
  // A remote whose device the registry puts in no room does nothing.
  assert.equal(drives(parseLiveRooms('studio,attic'), 'automation.lighting_attic_remote_center', press('attic'), view), false);
  assert.equal(drives(live, 'ls_remote_gesture_den', { command: 'power' }, view), false);
  assert.equal(drives(live, 'ls_remote_power_quiet_studio', {}, view), true);
});

test('an input is owned by the room it comes from, and anything else by the house', () => {
  const scope = liveScope(parseLiveRooms('studio')), view = house();
  assert.deepEqual(scope.origin('automation.lighting_studio_remote_center', { room: 'studio' }, view), inStudio);
  assert.deepEqual(scope.origin('ls_remote_gesture', { room: 'studio', command: 'power_done' }, view), inStudio);
  assert.equal(scope.origin('ls_remote_gesture', { room: 'den', command: 'power_done' }, view), undefined);
  assert.deepEqual(scope.origin('ls_apply', { reason: 'config' }, view), house_);
  assert.deepEqual(scope.origin('automation.lighting_recover_pending_output', {}, view), house_);
});

test('a dashboard overlay on a lamp in a room that is not live does nothing in the port', () => {
  const live = parseLiveRooms('studio'), view = house();
  const control = (alias: string) => ({ trigger: { platform: 'mqtt', topic: `house/v1/effect_preview/${alias}/set/brightness`, payload: '80' } });
  assert.equal(drives(live, 'automation.effects_native_light_controls', control('studio_lamp'), view), true);
  assert.equal(drives(live, 'automation.effects_native_light_controls', control('den_lamp'), view), false);
  assert.equal(drives(live, 'automation.effects_native_light_controls', control('unknown'), view), false);
});

test('a lamp switched from the app is the port\'s only when every lamp it names is in a live room', () => {
  const live = parseLiveRooms('studio'), view = house();
  const change = (entity: string | string[]) => ({ trigger: { platform: 'event', event: { event_type: 'call_service',
    data: { domain: 'light', service: 'turn_on', service_data: { entity_id: entity } }, context: { id: 'c', user_id: 'u' } } } });
  assert.equal(drives(live, 'automation.lighting_schedule_lamp_change_detector', change('light.studio'), view), true);
  assert.equal(drives(live, 'automation.lighting_schedule_lamp_change_detector', change(['light.studio', 'light.den']), view), false);
  assert.equal(drives(live, 'automation.lighting_schedule_lamp_change_detector', change('light.den'), view), false);
});

test('a lamp switched on in a room that is not live does nothing in the port, while the schedule tick is the house\'s', () => {
  const live = parseLiveRooms('studio'), view = house();
  const on = (entity: string) => ({ trigger: { platform: 'device', id: 'lamp_on', entity_id: entity } });
  assert.equal(drives(live, 'automation.lighting_schedule_engine', on('light.studio'), view), true);
  assert.equal(drives(live, 'automation.lighting_schedule_engine', on('light.den'), view), false);
  assert.equal(drives(live, 'automation.lighting_schedule_engine', { trigger: { platform: 'time_pattern', id: 'tick' } }, view), true);
  assert.equal(drives(live, 'automation.lighting_recover_pending_output', { trigger: { platform: 'time_pattern' } }, view), true);
});

test('the lamps the port re-sends on start are the lamps in its driven rooms', () => {
  assert.deepEqual(drivenLamps(parseLiveRooms('studio'), house()), ['light.studio']);
  assert.deepEqual(drivenLamps(parseLiveRooms('studio'), house({ studio: 'off', den: 'on' })), []);
  assert.deepEqual(drivenLamps(parseLiveRooms(''), house()), []);
});

test('a live room\'s port switch turning on names the room; any other change names none', () => {
  const live = parseLiveRooms('studio');
  const state = (value: string): EntityState => ({ state: value, attributes: {} });
  assert.equal(switchedOnRoom(live, 'input_boolean.ls_studio_on_port', state('off'), state('on')), 'studio');
  assert.equal(switchedOnRoom(live, 'input_boolean.ls_studio_on_port', undefined, state('on')), 'studio');
  assert.equal(switchedOnRoom(live, 'input_boolean.ls_studio_on_port', state('on'), state('on')), undefined);
  assert.equal(switchedOnRoom(live, 'input_boolean.ls_studio_on_port', state('on'), state('off')), undefined);
  assert.equal(switchedOnRoom(live, 'input_boolean.ls_den_on_port', state('off'), state('on')), undefined);
  assert.equal(switchedOnRoom(live, 'light.studio', state('off'), state('on')), undefined);
});
