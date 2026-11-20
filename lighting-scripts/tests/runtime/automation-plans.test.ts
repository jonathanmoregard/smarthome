import assert from 'node:assert/strict';
import test from 'node:test';
import { controlTopic, endOverrides, forwardNativeControl, forwardOverride, forwardRemote, houseRangeDefaults, lampChangeOverrides, pendingOutputDirty, refreshUi, requestRender, runScheduleEngine, saraModeSwitch } from '../../src/domain/automations.ts';
import { decideRangeSave, discoveryPublish, publishUi, saveRange, uiChoices } from '../../src/domain/ui-state.ts';
import { nativeCapture } from '../../src/parse/automations.ts';
import { parseRangeSaveArgs } from '../../src/parse/ui-state.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import type { JsonObject } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';
import { id } from './support/ids.ts';

const override = (data: JsonObject) => ({ kind: 'event', event: 'ls_override', data });
const turnOn = (script: string) => ({ kind: 'service', service: 'script.turn_on', data: {}, target: { entity_id: `script.${script}` } });

test('a remote forwards its gesture to the room\'s gesture script, preset with its payload', () => {
  assert.deepEqual([...forwardRemote('preset', { room: id.room('studio'), command: 'preset', payload: carry({ a: 1 }), source: 's', deviceId: undefined })],
    [{ kind: 'script', name: 'ls_remote_gesture_studio', args: { command: 'preset', payload: { a: 1 }, source: 's' } }]);
  assert.deepEqual([...forwardRemote('power', { room: id.room('studio'), command: 'power', payload: carry(null), source: undefined, deviceId: id.remote('d') })],
    [{ kind: 'script', name: 'ls_remote_gesture_studio', args: { command: 'power', device_id: 'd' } }]);
});

test('a native control topic names its alias and a supported attribute, else nothing', () => {
  assert.deepEqual(controlTopic('zigbee2mqtt/x/set/lamp/brightness'), { alias: 'lamp', attribute: 'brightness' });
  assert.equal(controlTopic('zigbee2mqtt/x/set/lamp/hue'), undefined);
});

test('a native control sets the control, then resyncs the UI', () => {
  assert.deepEqual([...forwardNativeControl('light.a', 'power', carry('ON'))],
    [{ kind: 'script', name: 'effects_set', args: { source: 'light.a', attribute: 'power', value: 'ON' } }, turnOn('effects_ui_sync')]);
});

test('the store writer commits the event data with who replaced', () => {
  assert.deepEqual([...forwardOverride({ data: carry({ op: 'set', who: 'x' }), who: carry('u') })],
    [{ kind: 'script', name: 'ls_commit', args: { data: { op: 'set', who: 'u' } } }]);
});

test('pending output is dirty on an unhandled full version or an unhandled room', () => {
  const clean = { fullVersion: 'v', handledFull: 'v', pendingRooms: { [id.room('a')]: carry('t') }, handledRooms: { [id.room('a')]: carry('t') } };
  assert.equal(pendingOutputDirty(clean), false);
  assert.equal(pendingOutputDirty({ ...clean, handledFull: 'w' }), true);
  assert.equal(pendingOutputDirty({ ...clean, handledRooms: {} }), true);
  assert.deepEqual([...requestRender()], [turnOn('ls_render')]);
});

test('refresh and the schedule engine forward their trigger', () => {
  assert.deepEqual([...refreshUi({ id: 'start' })], [{ kind: 'script', name: 'effects_ui_sync', args: { force: true } }]);
  assert.deepEqual([...runScheduleEngine({ id: 'lamp_on', entityId: undefined })], [{ kind: 'script', name: 'ls_apply', args: { reason: 'lamp_on', lights: [null] } }]);
  assert.deepEqual([...runScheduleEngine({ id: undefined, entityId: 'light.a' })], [{ kind: 'script', name: 'ls_apply', args: { reason: null } }]);
});

test('end-after clears overrides at least the limit old; an off rule never reads its limit', () => {
  const now = Date.parse('2026-10-26T12:00:00+01:00');
  const overrides = { old: { when: new Date(now - 3 * 3600e3).toISOString() }, fresh: { when: new Date(now - 60e3).toISOString() } };
  const view = house({ 'input_boolean.ls_ovr_after_on': 'on', 'input_number.ls_ovr_after_min': '120', 'sensor.ls_overrides': ['x', { overrides }] });
  assert.deepEqual(endOverrides(view, { id: 'after' }), [override({ op: 'clear', keys: ['old'], via: 'rule_after' })]);
  const off = house({ 'input_boolean.ls_ovr_after_on': 'off', 'input_number.ls_ovr_after_min': 'garbage', 'sensor.ls_overrides': ['x', { overrides }] });
  assert.deepEqual(endOverrides(off, { id: 'after' }), []);
  const at = house({ 'input_boolean.ls_ovr_at_on': 'on', 'sensor.ls_overrides': ['x', { overrides }] });
  assert.deepEqual(endOverrides(at, { id: 'at' }), [override({ op: 'clear_all', via: 'rule_at' })]);
});

test('the Sara switch sets or clears mode:sara only on a change', () => {
  assert.deepEqual([...saraModeSwitch({ id: 'on', who: 'u' }, false)], [override({ op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who: 'u' })]);
  assert.deepEqual([...saraModeSwitch({ id: 'on', who: 'u' }, true)], []);
  assert.deepEqual([...saraModeSwitch({ id: 'off', who: 'u' }, true)], [override({ op: 'clear', keys: ['mode:sara'], via: 'app', who: 'u' })]);
});

test('a lamp change powers its areas, then reads the records list where the inline read sat', () => {
  const seen: unknown[] = [];
  const plan = lampChangeOverrides(nativeCapture({ power: [{ area: 'kitchen' }], records: 'not a list' }), 'u');
  assert.throws(() => { for (const effect of plan) seen.push(effect); });
  assert.deepEqual(seen, [override({ op: 'power', area: 'kitchen', on: true, via: 'app', who: 'u' })]);
  assert.deepEqual([...lampChangeOverrides(nativeCapture({ power: [], records: [{ k: 1 }] }), 'u')],
    [override({ op: 'set', records: [{ k: 1 }], via: 'app', who: 'u' })]);
});

test('house range defaults fire only when both profiles are valid, reading cosy only after bright passes', () => {
  const valid = house({ 'input_number.ls_range_bright_min': '10', 'input_number.ls_range_bright_max': '90', 'input_number.ls_range_cosy_min': '0', 'input_number.ls_range_cosy_max': '40' });
  assert.deepEqual(houseRangeDefaults(valid), [override({ op: 'range_defaults', ranges: { bright: [10, 90], cosy: [0, 40] }, via: 'schedule-ui' })]);
  const badBright = house({ 'input_number.ls_range_bright_min': '95', 'input_number.ls_range_bright_max': '90', 'input_number.ls_range_cosy_min': 'garbage' });
  assert.deepEqual(houseRangeDefaults(badBright), []);
});

test('a range save decides its rule from the house and fires it unless dry', () => {
  const view = house({ 'switch.plug': 'on' }, { areas: { 'switch.plug': 'kitchen' }, devices: { dev: ['switch.plug'] } });
  const result = decideRangeSave(view, parseRangeSaveArgs({ entity: 'switch.plug', profile: 'custom', minimum: 10, maximum: 20 }));
  assert.deepEqual(result, { valid: true, errors: [], entity: 'switch.plug', config: { profile: 'custom', min: 10, max: 20 } });
  assert.deepEqual([...saveRange(result)], [override({ op: 'range_set', entity: 'switch.plug', profile: 'custom', min: 10, max: 20, via: 'schedule-ui' })]);
  const unassigned = decideRangeSave(house({ 'switch.plug': 'on' }, { devices: { dev: ['switch.plug'] } }), parseRangeSaveArgs({ entity: 'switch.plug' }));
  assert.deepEqual(unassigned.errors, ['Assign this lamp to a room before configuring its range.']);
  assert.throws(() => [...saveRange(unassigned)], /Assign this lamp/);
});

test('UI discovery republishes a row with the catalog choices', () => {
  assert.deepEqual(uiChoices(house({})), ['Normal Light', 'Candle']);
  const row = { entity: 'light.p', uniqueId: 'u1', config: carry({ name: 'P', effect_list: [] }) };
  assert.deepEqual(discoveryPublish(row, ['A']), { kind: 'service', service: 'mqtt.publish',
    data: { topic: 'homeassistant/light/u1/config', payload: JSON.stringify({ name: 'P', effect_list: ['A'] }), qos: 0, retain: true } });
  assert.deepEqual([...publishUi([{ topic: 't', payload: 'p' }])],
    [{ kind: 'service', service: 'mqtt.publish', data: { topic: 't', payload: 'p', qos: 0, retain: true } }]);
});
