import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';

const snapshot = { now: '2026-10-26T12:00:00+01:00', state: {}, areas: { 'light.logical': 'living', 'light.bulb': 'living' }, members: [] };
const catalog = { groups: { 'light.living': ['light.logical'] }, members: { 'light.logical': ['light.bulb'] }, effects: { Pulse: { channels: ['brightness'] } } };
const base = { brightness: 110, color: { kelvin: 2200 } };
const resolved = { level: 110, color: { kind: 'constant', value: { kelvin: 2200 } } };
const current = { plan: { base: { 'light.logical': base, 'room:living': base }, resolved: { targets: { 'light.logical': resolved, 'room:living': resolved } } } };

test('native bulb commands target its logical lamp and full groups target the room', async () => {
  const path = '../../src/domain/native-controls.ts';
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
  const path = '../../src/domain/native-controls.ts';
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
  const { nativeHandlers } = await import('../../src/domain/native-controls.ts');
  const s = { ...snapshot, state: { 'light.incidental': { state: 'on', attributes: { entity_id: ['light.bulb'] } }, 'light.bulb': { state: 'on', attributes: {} } } };
  const result = execute({ script: 'effects_native_plan', snapshot: s, args: { sd: { entity_id: 'light.incidental', brightness: 80 }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.deepEqual(result.result, { records: [], power: [] });
});

test('HSV conversion preserves off-grid hue precision at RGB rounding boundaries', async () => {
  const { nativeHandlers } = await import('../../src/domain/native-controls.ts');
  const result = execute({ script: 'effects_native_plan', snapshot, args: { sd: { entity_id: 'light.bulb', hs_color: [29.99999999999999, 100] }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.deepEqual(result.result.records[0].value.channels.color.value, { rgb: [255, 127, 0] });
});

test('registered group integration expands its bulbs through the runtime snapshot boundary', async () => {
  const { nativeHandlers } = await import('../../src/domain/native-controls.ts');
  const s = { ...snapshot, entitySources: { 'light.group': 'group' }, state: { 'light.group': { state: 'on', attributes: { entity_id: ['light.bulb'] } }, 'light.bulb': { state: 'on', attributes: {} } } };
  const result = execute({ script: 'effects_native_plan', snapshot: s, args: { sd: { entity_id: 'light.group', brightness: 80 }, catalog, current, stamp: 5 } }, nativeHandlers);
  assert.equal(result.result.records[0]?.target, 'light.logical');
});
