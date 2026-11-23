import assert from 'node:assert/strict';
import test from 'node:test';
import { configSource, decodeModel } from '../../src/adapter/codecs/model.ts';
import { haInput, messages } from '../../src/adapter/inputs.ts';
import type { HaInput } from '../../src/adapter/inputs.ts';
import { handleInput } from '../../src/adapter/loop.ts';
import { lightingState } from '../../src/domain/lighting-state.ts';
import type { Model, Msg } from '../../src/domain/model.ts';
import { update } from '../../src/domain/update.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toBrightness, toBrightnessStep, toDashboardControlId, toInstant, toKelvin, toLampId, toPercentRange, toRemoteId, toRoomId, toSwitchId,
} from '../../src/parse/ids.ts';
import type { EntityState, JsonObject } from '../../src/runtime/context.ts';
import { ParseError } from '../../src/runtime/parse.ts';
import { parseRooms } from '../../src/parse/rooms.ts';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import type { HouseView } from '../../src/runtime/effects.ts';
import { CATALOG, houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';

/**
 * Home Assistant's inputs read into messages (M3 Task 3, spec 5.1): one test
 * per row, on the synthetic house at noon on Monday 2026-09-21 (UTC).
 */

const NOW_TEXT = '2026-09-21T12:00:00Z';
const NOW: Instant = toInstant(Date.parse(NOW_TEXT) / 1000);
const roomA = toRoomId('room-a');
const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2');
const remoteA = toRemoteId('remote-a');
const PERSON = 'person-1';

function states(change: (states: Record<string, EntityState>) => void = () => {}): Record<string, EntityState> {
  const made = syntheticStates();
  writeBack(world(), made);
  change(made);
  return made;
}

function modelOf(house = houseView(states(), NOW_TEXT)): Model {
  return decodeModel(configSource(house), house.catalog);
}

/** The messages of a script or automation run, as `haInput` names it and `messages` reads it. */
function read(script: string, args: JsonObject, house = houseView(states(), NOW_TEXT)): Msg[] {
  const input = haInput(script, args);
  assert.ok(input !== undefined, `${script} is an input`);
  return messages(input, modelOf(house), NOW, house);
}

/** The detector's trigger: a `call_service` event for the light domain. */
function call(service: string, serviceData: JsonObject, context: JsonObject = { id: 'ctx-1', user_id: PERSON }): JsonObject {
  return { trigger: { event: { data: { domain: 'light', service, service_data: serviceData }, context } } };
}

test('a tick is a clock message: the time-pattern automations are the clock, which the loop applies', () => {
  for (const [script, args] of [
    ['automation.lighting_schedule_engine', { trigger: { id: 'tick' } }],
    ['automation.lighting_schedule_end_overrides', { trigger: { id: 'after' } }],
    ['automation.lighting_recover_pending_output', { trigger: { id: '0' } }],
  ] as const) {
    const input = haInput(script, args);
    assert.deepEqual(input, { kind: 'tick' }, script);
    assert.deepEqual(messages(input!, modelOf(), NOW, houseView(states(), NOW_TEXT)), [], script);
  }
  assert.deepEqual(haInput('automation.lighting_schedule_engine', { trigger: { id: 'start' } }), { kind: 'started' });
  assert.deepEqual(haInput('ls_wake', {}), { kind: 'wake' });
});

test('the dashboard\'s UI refresh scripts are a wake: the turn re-syncs the controls and discovery', () => {
  // Break: the catalog refresh, which HA still bridges as a command, is dropped as not an input.
  assert.deepEqual(haInput('effects_ui_sync', {}), { kind: 'wake' });
  assert.deepEqual(haInput('effects_ui_catalog', {}), { kind: 'wake' });
});

test('the override event\'s hold is an overlay request', () => {
  assert.deepEqual(read('ls_commit', { data: { op: 'set', records: [{ kind: 'block', target: roomA, value: 'night' }], via: 'app' } }),
    [{ kind: 'overlayRequested', request: { kind: 'hold block', over: roomA, block: 'night' }, at: NOW }]);
  assert.deepEqual(read('ls_commit', { data: { op: 'clear_all', via: 'app' } }),
    [{ kind: 'overlayRequested', request: { kind: 'clear all' }, at: NOW }]);
});

test('a person\'s light.turn_on with a brightness is a lamp change', () => {
  assert.deepEqual(read('automation.lighting_schedule_lamp_change_detector', call('turn_on', { entity_id: [lampA1], brightness: 80,
    color_temp_kelvin: 3000 })), [{ kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], at: NOW,
    light: { power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(80) }, colour: { kind: 'kelvin', kelvin: toKelvin(3000) },
      effect: undefined } }]);
});

test('a person\'s brightness step moves from the level the lamp shows', () => {
  // Carried from the deleted resolution-native test. Break: the step is taken as an absolute brightness, or from 0.
  const house = houseView(states(), NOW_TEXT), model = modelOf(house), shown = lightingState(model, NOW).lamps[lampA1];
  assert.ok(shown !== undefined && shown.power === 'on');
  const input = haInput('automation.lighting_schedule_lamp_change_detector', call('turn_on', { entity_id: [lampA1], brightness_step: 30 }));
  const msgs = messages(input!, model, NOW, house);
  assert.deepEqual(msgs, [{ kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], at: NOW,
    light: { power: 'on', brightness: { kind: 'step', by: toBrightnessStep(30) }, colour: undefined, effect: undefined } }]);
  const after = lightingState(msgs.reduce(update, model), NOW).lamps[lampA1];
  assert.ok(after !== undefined && after.power === 'on');
  assert.equal(after.level, shown.level + 30);
});

test('a brightness step on a lamp that shows off starts from 0, as Home Assistant steps an off light', () => {
  // Carried from the deleted off-lamp-blend test. Break: the step starts from the lamp's scheduled level under its off hold.
  const house = houseView(states(), NOW_TEXT);
  const off = update(modelOf(house), { kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], light: { power: 'off' },
    at: toInstant(NOW - 60) });
  assert.equal(lightingState(off, NOW).lamps[lampA1]?.power, 'off');
  const input = haInput('automation.lighting_schedule_lamp_change_detector', call('turn_on', { entity_id: [lampA1], brightness_step: 40 }));
  const msgs = messages(input!, off, NOW, house);
  assert.deepEqual(msgs, [{ kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], at: NOW,
    light: { power: 'on', brightness: { kind: 'step', by: toBrightnessStep(40) }, colour: undefined, effect: undefined } }]);
  const after = lightingState(msgs.reduce(update, off), NOW).lamps[lampA1];
  assert.ok(after !== undefined && after.power === 'on');
  assert.equal(after.level, 40);
});

test('a call naming a room whole changes the room', () => {
  const msgs = read('automation.lighting_schedule_lamp_change_detector', call('turn_on', { area_id: roomA, brightness_pct: 50 }));
  assert.deepEqual(msgs, [{ kind: 'lampChangedByPerson', lamps: [lampA1, lampA2], rooms: [roomA], at: NOW,
    light: { power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(128) }, colour: undefined, effect: undefined } }]);
});

test('the same call without a user is not', () => {
  assert.deepEqual(read('automation.lighting_schedule_lamp_change_detector',
    call('turn_on', { entity_id: [lampA1], brightness: 80 }, { id: 'ctx-1', user_id: null })), []);
});

test('a call caused by a running script is not', () => {
  const house = houseView(states(made => { made['script.some_scene'] = { state: 'on', attributes: {}, context: { id: 'ctx-1' } }; }), NOW_TEXT);
  assert.deepEqual(read('automation.lighting_schedule_lamp_change_detector', call('turn_on', { entity_id: [lampA1], brightness: 80 }), house), []);
});

test('a person\'s light.turn_off is the off hold, and a plain light.turn_on its end', () => {
  assert.deepEqual(read('automation.lighting_schedule_lamp_change_detector', call('turn_off', { entity_id: lampA1 })),
    [{ kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], light: { power: 'off' }, at: NOW }]);
  assert.deepEqual(read('automation.lighting_schedule_lamp_change_detector', call('turn_on', { entity_id: lampA1 })),
    [{ kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [], at: NOW,
      light: { power: 'on', brightness: undefined, colour: undefined, effect: undefined } }]);
});

test('a remote\'s action is a press, with what its room reports', () => {
  const args = (trigger: JsonObject) => ({ room: roomA, device_id: remoteA, source: 'remote-a', trigger });
  assert.deepEqual(read('automation.lighting_room_a_remote_center', args({ payload: 'on' })),
    [{ kind: 'remoteButtonPressed', remote: remoteA, button: { kind: 'power' }, anyOn: true, at: NOW }]);
  assert.deepEqual(read('automation.lighting_room_a_remote_directions', args({ id: 'down' })),
    [{ kind: 'remoteButtonPressed', remote: remoteA, button: { kind: 'arrow', direction: 'down' }, anyOn: true, at: NOW }]);
  assert.deepEqual(read('automation.lighting_room_a_remote_preset_arrows',
    args({ payload_json: { action: 'color_temperature_move', action_color_temperature: 200 } })),
  [{ kind: 'remoteButtonPressed', remote: remoteA, button: { kind: 'preset', button: 'coolest' }, anyOn: true, at: NOW }]);
  const dark = houseView(states(made => { made[lampA1] = { state: 'off', attributes: {} }; made[lampA2] = { state: 'off', attributes: {} }; }), NOW_TEXT);
  assert.deepEqual(read('automation.lighting_room_a_remote_center', args({ payload: 'on' }), dark),
    [{ kind: 'remoteButtonPressed', remote: remoteA, button: { kind: 'power' }, anyOn: false, at: NOW }]);
});

test('a dashboard power message whose on is not a boolean is dropped, not read as off', () => {
  // Break: `on` is read as `data.on === true`, so an absent or unreadable one switches the room off.
  const house = houseView(states(), NOW_TEXT);
  const power = (on: JsonObject) => ({ kind: 'overlay event', data: { op: 'power', area: roomA, ...on } } as const);
  for (const bad of [{}, { on: 'on' }, { on: 1 }, { on: null }, { on: 'true' }]) {
    assert.throws(() => messages(power(bad), modelOf(house), NOW, house), ParseError, JSON.stringify(bad));
  }
  assert.deepEqual(messages(power({ on: false }), modelOf(house), NOW, house),
    [{ kind: 'overlayRequested', request: { kind: 'room power', room: roomA, power: 'off' }, at: NOW }]);
  assert.deepEqual(messages(power({ on: true }), modelOf(house), NOW, house),
    [{ kind: 'overlayRequested', request: { kind: 'room power', room: roomA, power: 'on' }, at: NOW }]);
});

test('a helper change re-reads the config', () => {
  const before = states();
  const first = handleInput(undefined, houseView(before, NOW_TEXT), { kind: 'started' });
  const after = structuredClone(before);
  after['input_datetime.ls_house_day_start'] = { state: '08:00:00', attributes: {} };
  const changed = handleInput(first.state, houseView(after, NOW_TEXT), { kind: 'helper changed' });
  assert.deepEqual(changed.state.model.config.house.day.weekdayStart, { hour: 8, minute: 0 });
  assert.deepEqual(changed.state.model.overlays, first.state.model.overlays);
});

test('the dashboard\'s scripts: hold a block, clear, toggle the mode, save a range', () => {
  assert.deepEqual(read('ls_override_block', { scope: 'house', block: 'Night' }),
    [{ kind: 'overlayRequested', request: { kind: 'hold block', over: 'house', block: 'night' }, at: NOW }]);
  assert.deepEqual(read('ls_clear_overrides', {}), [{ kind: 'overlayRequested', request: { kind: 'clear all' }, at: NOW }]);
  assert.deepEqual(read('ls_sara_mode', {}), [{ kind: 'modeToggled', on: true, at: NOW }]);
  assert.deepEqual(read('ls_range_save', { entity: 'switch.plug_a', profile: 'custom', minimum: 10, maximum: 40 }),
    [{ kind: 'rangeSaved', switch: toSwitchId('switch.plug_a'), rule: { kind: 'custom', range: toPercentRange(10, 40) }, room: roomA, at: NOW }]);
  assert.throws(() => read('ls_range_save', { entity: 'switch.nowhere', profile: 'bright' }), ParseError);
});

test('the mode switch in the dashboard is the mode toggled, only from a person', () => {
  const trigger = (user: string | null) => ({ trigger: { id: 'on', to_state: { context: { user_id: user } } } });
  assert.deepEqual(read('automation.lighting_schedule_sara_mode_switch', trigger(PERSON)), [{ kind: 'modeToggled', on: true, at: NOW }]);
  assert.deepEqual(read('automation.lighting_schedule_sara_mode_switch', trigger(null)), []);
});

test('a dashboard control over a whole room switches the room, and sets a light over it', () => {
  const control = toDashboardControlId('light.room_a_all');
  assert.deepEqual(read('effects_set', { source: 'light.room_a_all', attribute: 'power', value: 'OFF' }),
    [{ kind: 'overlayRequested', request: { kind: 'room power', room: roomA, power: 'off' }, at: NOW }]);
  assert.deepEqual(read('automation.effects_native_light_controls', { trigger: { topic: 'house/v1/effect_preview/room_a_all/set/brightness',
    payload: '100' } }), [{ kind: 'overlayRequested', at: NOW, request: { kind: 'dashboard control', control, over: { kind: 'room', room: roomA },
    light: { power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(100) }, colour: undefined, effect: undefined } } }]);
});

test("a save to a plug's store is the plug's profile saved, and a lamp's store the lamp's", () => {
  // Break: a plug's store save reads as no message (the plug's profile is not saved), or as a lamp's.
  assert.deepEqual(read('ls_store', { store: 'input_text.ls_lamp_plug_a_cosy', own: true, on: true }),
    [{ kind: 'switchProfileSaved', switch: toSwitchId('switch.plug_a'), block: 'cosy', change: { own: true, power: 'on' }, at: NOW }]);
  assert.deepEqual(read('ls_store', { store: 'input_text.ls_lamp_lamp_a2_day', on: false }), [{
    kind: 'lampProfileSaved', lamp: lampA2, block: 'day', at: NOW,
    change: { own: undefined, power: 'off', brightness: undefined, colour: undefined, effect: undefined },
  }]);
});

test('a name that is not an input is not ours, and a field that cannot be read raises', () => {
  const notOurs: HaInput | undefined = haInput('effects_catalog', {});
  assert.equal(notOurs, undefined);
  assert.throws(() => read('ls_override_block', { scope: roomA, block: 'teatime' }), ParseError);
});

test('a remote automation\'s source picks the remote, where its room has two and the press names no device', () => {
  // Break: the source is dropped, so the press goes to the first remote of the room (today's automation forwarded it).
  const remoteC = toRemoteId('remote-c');
  const base = houseView(states(), NOW_TEXT);
  const two: HouseView = {
    ...base,
    rooms: parseRooms({ ...base.rooms.ofId, 'remote-c': 'room-a' }),
    catalog: parseCatalog({ ...CATALOG, remotes: { ...(CATALOG.remotes as JsonObject), second: { device_id: 'remote-c', source: 'remote-c' } } }),
  };
  assert.deepEqual(read('automation.lighting_room_a_remote_center', { room: roomA, source: 'remote-c', trigger: { payload: 'on' } }, two),
    [{ kind: 'remoteButtonPressed', remote: remoteC, button: { kind: 'power' }, anyOn: true, at: NOW }]);
});

test('a missing room or topic is absent, not empty text, and an input that needs it raises', () => {
  // Break: an empty text stands in for the missing room or topic.
  assert.deepEqual(haInput('ls_remote_gesture', { command: 'power' }),
    { kind: 'remote action', room: undefined, device: undefined, source: undefined, button: { kind: 'power' } });
  assert.deepEqual(haInput('automation.lighting_room_a_remote_center', { trigger: { payload: 'on' } }),
    { kind: 'remote action', room: undefined, device: undefined, source: undefined, button: { kind: 'power' } });
  assert.deepEqual(haInput('automation.effects_native_light_controls', { trigger: { payload: 'ON' } }),
    { kind: 'effect preview', topic: undefined, payload: 'ON' });
  assert.throws(() => read('ls_remote_gesture', { command: 'power' }), /names no remote and no room/);
  assert.throws(() => read('automation.effects_native_light_controls', { trigger: { payload: 'ON' } }), /no topic/);
  assert.throws(() => read('ls_remote_command', { command: 'toggle' }), /names no remote and no room/);
  assert.throws(() => read('ls_range_save', { profile: 'bright' }), /Choose a physical on\/off lamp or smart plug\./);
});
