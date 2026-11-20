import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';

const snapshot = { now: '2026-10-26T12:00:00+01:00', state: {}, areas: { 'light.logical': 'living', 'light.bulb': 'living' }, members: [] };
const catalog = { groups: { 'light.living': ['light.logical'] }, members: { 'light.logical': ['light.bulb'] }, effects: { Pulse: { channels: ['brightness'] } } };
const base = { brightness: 110, color: { kelvin: 2200 } };
const resolved = { level: 110, color: { kind: 'constant', value: { kelvin: 2200 } } };
const current = { plan: { base: { 'light.logical': base, 'room:living': base }, resolved: { targets: { 'light.logical': resolved, 'room:living': resolved } } } };

test('native bulb commands target its logical lamp and full groups target the room', async () => {
  const path = '../../src/handlers/native-controls.ts';
  const port = await import(path).catch(() => ({}));
  assert.equal(typeof port.nativeHandlers, 'object', 'native control handlers exist');
  const lamp = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', brightness_pct: 50, hs_color: [120, 100] }, catalog, current, stamp: 5 } }, port.nativeHandlers);
  assert.deepEqual(lamp.result.records, [{ kind: 'channels', key: 'channels:native:light.logical', source: 'native:light.logical', scope: 'lamp', target: 'light.logical', value: { channels: { brightness: { kind: 'constant', value: 127.5, updated: 5 }, color: { kind: 'constant', value: { rgb: [0, 255, 0] }, updated: 5 } } } }]);
  assert.deepEqual(lamp.calls, []);
  const room = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.living', brightness: 80 }, catalog, current, stamp: 5 } }, port.nativeHandlers);
  assert.equal(room.result.records[0].scope, 'room');
  assert.equal(room.result.records[0].target, 'living');
});

test('UI invalid controls fail closed and normal-light restores underlying colour under Sara', async () => {
  const path = '../../src/handlers/native-controls.ts';
  const port = await import(path).catch(() => ({}));
  assert.equal(typeof port.nativeHandlers, 'object');
  const pink = structuredClone(current);
  pink.plan.resolved.targets['light.logical'].color = { kind: 'constant', value: { rgb: [255, 105, 180] }, policy: 'sara' };
  const handlers = { ...port.nativeHandlers, effects_catalog: () => catalog, ls_plan: () => pink };
  const bad = execute({ script: 'effects_set', snapshot, args: { source: 'light.logical', attribute: 'brightness', value: -1, dry_run: true } }, handlers);
  assert.equal(bad.result.valid, false);
  assert.deepEqual(bad.result.events, []);
  const restore = execute({ script: 'effects_set', snapshot, args: { source: 'light.logical', attribute: 'effect', value: 'Normal Light', dry_run: true } }, handlers);
  assert.deepEqual(restore.result.records[0].value.channels.color.value, { kelvin: 2200 });
  assert.deepEqual(restore.events, []);
});

test('native expansion does not treat incidental entity_id attributes as group integration membership', async () => {
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const s = { ...snapshot, state: { 'light.incidental': { state: 'on', attributes: { entity_id: ['light.bulb'] } }, 'light.bulb': { state: 'on', attributes: {} } } };
  const result = execute({ script: 'effects_native_plan', snapshot: s, args: { sd: { entity_id: 'light.incidental', brightness: 80 }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.deepEqual(result.result, { records: [], power: [] });
});

test('empty native requests do not evaluate unused current state or stamp', async () => {
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const result = execute({ script: 'effects_native_plan', snapshot, args: { sd: {}, catalog: { groups: {}, members: {}, effects: {} } } }, nativeHandlers);
  assert.deepEqual(result.result, { records: [], power: [] });
  const area = execute({ script: 'effects_native_plan', snapshot, args: { sd: { area_id: 'living' }, catalog: { groups: {}, members: {}, effects: {} }, current: { plan: { base: {} } }, stamp: 5 } }, nativeHandlers);
  assert.deepEqual(area.result, { records: [], power: [] });
});

test('raw Kelvin payloads retain their captured value type', async () => {
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const result = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', color_temp_kelvin: '2300' }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.deepEqual(result.result.records[0].value.channels.color.value, { kelvin: '2300' });
  const stamped = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', brightness: 10 }, catalog, current, stamp: '5' } }, nativeHandlers);
  assert.equal(stamped.result.records[0].value.channels.brightness.updated, '5');
});

test('HSV conversion preserves off-grid hue precision at RGB rounding boundaries', async () => {
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const result = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', hs_color: [29.99999999999999, 100] }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.deepEqual(result.result.records[0].value.channels.color.value, { rgb: [255, 127, 0] });
});

test('registered group integration expands its bulbs through the runtime snapshot boundary', async () => {
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const s = { ...snapshot, entitySources: { 'light.group': 'group' }, state: { 'light.group': { state: 'on', attributes: { entity_id: ['light.bulb'] } }, 'light.bulb': { state: 'on', attributes: {} } } };
  const result = execute({ script: 'effects_native_plan', snapshot: s, args: { sd: { entity_id: 'light.group', brightness: 80 }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.equal(result.result.records[0]?.target, 'light.logical');
});

test('a boolean native brightness is claimed as given, intensity included', async () => {
  // `bool` is an `int` in Python, so `true` passes the numeric test and is stored
  // as `true`, not as 1. A brightness parse that coerced would store 1.
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const result = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', brightness: true, effect: 'pulse' }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.equal(JSON.stringify(result.result.records[0].value.channels), JSON.stringify({
    brightness: { kind: 'effect', effect: 'Pulse', instance: 'native:light.bulb:Pulse', updated: 5, intensity: true },
  }));
});

test('a native brightness step reads the resolved level before the step', async () => {
  // An absent level is an off lamp, which steps from 0; a present malformed one
  // still raises, and before the step itself is read.
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const malformed = structuredClone(current);
  (malformed.plan.resolved.targets['light.logical'] as { level?: unknown }).level = 'bright';
  assert.throws(() => execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', brightness_step: 'up' }, catalog, current: malformed, stamp: 5 } }, nativeHandlers),
    /resolved target\.level must be a finite number/);
});

test('a reset to normal light with no base colour under Sara writes no colour value at all', async () => {
  // The underlying colour is carried as read: absent stays absent (no `value` key), not null.
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const sara = structuredClone(current);
  delete (sara.plan.base['light.logical'] as { color?: unknown }).color;
  sara.plan.resolved.targets['light.logical'].color = { kind: 'constant', value: { rgb: [1, 2, 3] }, policy: 'sara' };
  const handlers = { ...nativeHandlers, effects_catalog: () => catalog, ls_plan: () => sara };
  const result = execute({ script: 'effects_set', snapshot, args: { source: 'light.logical', attribute: 'effect', value: 'Normal Light', dry_run: true } }, handlers);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result.result.records[0].value.channels.color))), ['kind', 'updated']);
});

test('an effect name the catalog mapping inherits is not unknown; its channels then fail to parse', async () => {
  // `name in effects` finds inherited names, so the control is not refused as
  // 'Unknown effect.'; the channel lookup then raises on the non-mapping.
  const { nativeHandlers } = await import('../../src/handlers/native-controls.ts');
  const handlers = { ...nativeHandlers, effects_catalog: () => catalog, ls_plan: () => current };
  assert.throws(() => execute({ script: 'effects_set', snapshot, args: { source: 'light.logical', attribute: 'effect', value: 'toString', dry_run: true } }, handlers),
    /catalog\.effects\.toString must be an object/);
});
