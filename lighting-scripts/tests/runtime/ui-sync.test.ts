import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardWrites, uiSyncWrites } from '../../src/adapter/codecs/writes.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { EntityState, JsonObject } from '../../src/adapter/ha-client.ts';
import type { HouseView } from '../../src/adapter/codecs/house.ts';
import { CATALOG, houseView, syntheticStates } from './fixtures/house-view.ts';

/**
 * The dashboard's proxies and discovery configs kept in step with what Home
 * Assistant shows (moved from `uiMessages` and `effects_ui_catalog`): a
 * profile editor's channels from its source light, every row's availability
 * from its source, and each discovery row's effect list from the catalog's
 * choices. Each is sent only where the proxy, or the discovered light, shows
 * otherwise; a start sends every channel.
 */

const NOW = '2026-09-21T12:00:00Z';
const topics = (alias: string, channels: readonly string[]) =>
  Object.fromEntries(channels.map(channel => [channel, `house/v1/effect_preview/${alias}/set/${channel}`]));
const EDITOR = 'light.ls_lamp_lamp_a2_day', EDITOR_PROXY = 'light.ep_lamp_a2_day', STORE = 'input_text.ls_lamp_lamp_a2_day';
const LIVE = 'light.room_a_all', LIVE_PROXY = 'light.ep_room_a_all';
const CHANNELS = ['power', 'brightness', 'temperature', 'rgb', 'effect', 'availability'];
/** The live control's proxy, as its discovery row describes it. */
const DISCOVERED = LIVE_PROXY;
const DISCOVERY_CONFIG = { unique_id: 'ep_room_a_all', name: 'Room A', effect_list: ['Normal Light', 'Candle'] };

function house(change: (states: Record<string, EntityState>) => void, catalog: JsonObject = {}): HouseView {
  const states = syntheticStates(change);
  const view = houseView(states, NOW);
  return {
    ...view,
    catalog: parseCatalog({
      ...CATALOG,
      ui_rows: [
        { source: EDITOR, proxy: EDITOR_PROXY, store: STORE, members: ['light.lamp_a2'], topics: topics('lamp_a2_day', CHANNELS) },
        { source: LIVE, proxy: LIVE_PROXY, store: '', members: ['light.lamp_a1', 'light.lamp_a2'], topics: topics('room_a_all', CHANNELS) },
      ],
      ui_discovery: [{ entity: DISCOVERED, config: DISCOVERY_CONFIG }],
      ...catalog,
    }),
  };
}

/** The editor's source lit at 120 in 2700 K, its store running the candle; the live control's source and proxy alike, its effect list the choices. */
function shown(states: Record<string, EntityState>): void {
  states[EDITOR] = { state: 'on', attributes: { brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 2700 } };
  states[STORE] = { state: JSON.stringify({ own: true, b: 120, m: 'ct', k: 2700, effect: 'Candle', effect_channels: ['brightness', 'color'] }),
    attributes: {} };
  states[LIVE] = { state: 'on', attributes: {} };
  states[LIVE_PROXY] = { state: 'on', attributes: { effect_list: ['Normal Light', 'Candle'] } };
}

/** The editor's proxy showing what its source shows. */
function inStep(states: Record<string, EntityState>): void {
  shown(states);
  states[EDITOR_PROXY] = { state: 'on', attributes: { brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 2703, effect: 'Candle' } };
}

const sent = (alias: string, channel: string, payload: string) =>
  ({ kind: 'control sync', topic: `house/v1/effect_preview/${alias}/set/${channel}`, payload });

test('a profile editor is sent each channel its proxy shows otherwise', () => {
  // Break: the profile editors are left out (the gap this closes), or a channel the proxy already shows is sent.
  const writes = uiSyncWrites(house(states => {
    shown(states);
    states[EDITOR_PROXY] = { state: 'off', attributes: { brightness: 120, color_mode: 'color_temp', color_temp_kelvin: 4000, effect: 'Normal Light' } };
  }), false);
  assert.deepEqual(writes, [
    sent('lamp_a2_day', 'power', 'ON'), sent('lamp_a2_day', 'effect', 'Candle'), sent('lamp_a2_day', 'temperature', '370'),
  ]);
});

test('nothing is sent when every proxy and discovered light shows what it should', () => {
  // Break: a channel is sent every turn, whatever the proxy shows.
  assert.deepEqual(uiSyncWrites(house(inStep), false), []);
});

test('a row whose source is unavailable is sent offline and nothing else; back, online', () => {
  // Break: the availability channel is not published, or an unavailable row's channels are still sent.
  const gone = uiSyncWrites(house(states => { inStep(states); states[EDITOR] = { state: 'unavailable', attributes: {} }; }), false);
  assert.deepEqual(gone, [sent('lamp_a2_day', 'availability', 'offline')]);
  const back = uiSyncWrites(house(states => { inStep(states); states[LIVE_PROXY] = { ...states[LIVE_PROXY]!, state: 'unavailable' }; }), false);
  assert.deepEqual(back, [sent('room_a_all', 'availability', 'online')]);
});

test('a start sends every channel of each profile editor, and every row its availability', () => {
  // Break: a start leaves a proxy that already looks right unsent, so a proxy Home Assistant restored stale stays stale.
  assert.deepEqual(uiSyncWrites(house(inStep), true), [
    sent('lamp_a2_day', 'availability', 'online'), sent('lamp_a2_day', 'power', 'ON'), sent('lamp_a2_day', 'effect', 'Candle'),
    sent('lamp_a2_day', 'brightness', '120'), sent('lamp_a2_day', 'temperature', '370'), sent('room_a_all', 'availability', 'online'),
  ]);
});

test('a discovered light whose effect list is not the catalog\'s choices is republished with them', () => {
  // Break: the effect-list publish no longer runs (the gap this closes), or it runs when the list already matches.
  const choices = ['Normal Light', 'Candle', 'Fireplace'];
  const writes = uiSyncWrites(house(inStep, { ui_choices: choices }), false);
  assert.deepEqual(writes, [{
    kind: 'discovery', topic: 'homeassistant/light/ep_room_a_all/config', payload: JSON.stringify({ ...DISCOVERY_CONFIG, effect_list: choices }),
  }]);
});

test('a malformed row or discovery row is passed over, and the others are still sent', () => {
  // Break: one bad row in the catalog stops the whole sync (or the turn).
  const writes = uiSyncWrites(house(states => { inStep(states); states[EDITOR] = { state: 'unavailable', attributes: {} }; }, {
    ui_rows: [{ proxy: 'light.ep_nothing' }, 7, { source: EDITOR, proxy: EDITOR_PROXY, store: STORE, members: [], topics: topics('lamp_a2_day', CHANNELS) }],
    ui_discovery: [{ entity: DISCOVERED }, 'x'],
  }), false);
  assert.deepEqual(writes, [sent('lamp_a2_day', 'availability', 'offline')]);
});

test('a discovery row whose light Home Assistant does not report is not republished, turn after turn', () => {
  // Break: an unreported light's effect list reads as missing, so its config is republished every turn.
  const writes = uiSyncWrites(house(states => { inStep(states); delete states[DISCOVERED]; }), false);
  assert.deepEqual(writes.filter(write => write.kind === 'discovery'), []);
});

test("the mode's mirror is the one the catalog's mode names", () => {
  // M5 carry-over: the mode's name is the household's, so the code names no mirror. Break: a mirror name built in.
  const base = houseView(syntheticStates(states => {
    states['input_boolean.ls_evening_mode_mirror'] = { state: 'off', attributes: {} };
  }), NOW);
  const view = { blockShown: { house: 'day' as const }, modeOn: true, plantsAllOff: false, controls: [] };
  const named = { ...base, catalog: parseCatalog({ ...CATALOG, mode: 'evening' }) };
  assert.deepEqual(dashboardWrites(undefined, view, [], named), [{ kind: 'mode mirror', entity: 'input_boolean.ls_evening_mode_mirror', on: true }]);
  assert.deepEqual(dashboardWrites(undefined, view, [], { ...base, catalog: { ...named.catalog, mode: undefined } }), []);
});
