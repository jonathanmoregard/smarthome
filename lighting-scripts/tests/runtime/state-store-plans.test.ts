import assert from 'node:assert/strict';
import test from 'node:test';
import { houseRooms, planCommit, planOverrideBlock, planStore, toggleSaraMode } from '../../src/domain/state-store.ts';
import { clearAllOverrides } from '../../src/handlers/state-store.ts';
import type { CommitSnapshot } from '../../src/domain/state-store.ts';
import { parseCommitArgs, storedOverrides } from '../../src/parse/overrides.ts';
import { cachedProfile, parseOverrideBlockArgs, parseStoreProfile } from '../../src/parse/state-store.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { parseRooms } from '../../src/parse/rooms.ts';
import type { JsonObject } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';

const NOW = '2026-10-26T12:00:00+01:00';
function snapshot(overrides: JsonObject = {}, extra: Partial<CommitSnapshot> = {}): CommitSnapshot {
  return {
    now: NOW, rooms: parseRooms({}), before: storedOverrides(overrides),
    power: {}, switchRanges: {}, remoteAck: {}, pendingRooms: {},
    handledFull: undefined, fullVersion: undefined, fullLights: [], fullReason: undefined, ...extra,
  };
}
const details = (data: JsonObject) => parseCommitArgs({ data }).details();
/** The `variable.update_sensor` patch a commit plan writes, and every effect it yields. */
function commitEffects(snap: CommitSnapshot, data: JsonObject) {
  const effects = [...planCommit(snap, details(data))];
  const first = effects[0];
  assert.ok(first !== undefined && first.kind === 'service');
  return { effects, patch: first.data.attributes as JsonObject };
}

test('a commit writes the sensor patch, then asks for a render', () => {
  const { effects } = commitEffects(snapshot(), { op: 'set', via: 'remote', records: [{ kind: 'k', target: 't', value: 1 }] });
  assert.deepEqual(effects.map(effect => effect.kind === 'service' ? [effect.service, effect.target] : effect.kind), [
    ['variable.update_sensor', { entity_id: 'sensor.ls_overrides' }],
    ['script.turn_on', { entity_id: 'script.ls_render' }],
  ]);
  const first = effects[0]!;
  assert.ok(first.kind === 'service');
  assert.deepEqual(Object.keys(first.data), ['value', 'attributes', 'replace_attributes']);
  assert.equal(first.data.value, NOW);
});

test('a set record is stamped with now, keeps an explicit-null created, and marks no full render from a remote', () => {
  const before = { 'k:t': { kind: 'k', target: 't', created: null } };
  const { patch } = commitEffects(snapshot(before), { op: 'set', via: 'remote', who: 'u', records: [{ kind: 'k', target: 't', value: 2 }] });
  assert.deepEqual(patch.overrides, { 'k:t': { kind: 'k', target: 't', value: 2, when: NOW, created: null, who: 'u', via: 'remote' } });
  assert.deepEqual(Object.keys(patch), ['overrides', 'last_via', 'pending_rooms', 'last_request', 'received_at']);
});

test('clear_room drops a lamp record whose lamp sits in the area, read from the snapshot\'s rooms', () => {
  const before = { a: { scope: 'lamp', target: 'light.x' }, b: { scope: 'lamp', target: 'light.y' } };
  const { patch } = commitEffects(snapshot(before, { rooms: parseRooms({ 'light.x': 'kitchen', 'light.y': 'hall' }) }), { op: 'clear_room', area: 'kitchen' });
  assert.deepEqual(Object.keys(patch.overrides as JsonObject), ['b']);
});

test('a full render carries the unhandled previous lights forward', () => {
  const snap = snapshot({}, { fullVersion: 'v1', handledFull: 'v0', fullLights: ['light.old'], fullReason: 'config' });
  const { patch } = commitEffects(snap, { op: 'render_request', via: 'render_request', reason: 'tick', lights: ['light.new'] });
  assert.equal(patch.full_version, NOW);
  assert.equal(patch.full_reason, 'config');
  assert.deepEqual(patch.full_lights, ['light.old', 'light.new']);
});

test('the profile store writes the patched text, then tells listeners a lamp store changed', () => {
  const args = parseStoreProfile({ store: 'input_text.ls_lamp_x_day', brightness: 40 });
  const current = cachedProfile(JSON.stringify({ b: 1, effect: 'Candle', effect_channels: ['brightness', 'color'] }), args.entity);
  const effects = [...planStore(args, current, () => [])];
  assert.deepEqual(effects, [
    { kind: 'service', service: 'input_text.set_value',
      data: { value: JSON.stringify({ b: 40, effect: 'Candle', effect_channels: ['color'] }) }, target: { entity_id: 'input_text.ls_lamp_x_day' } },
    { kind: 'event', event: 'ls_lamp_store_changed', data: { store: 'input_text.ls_lamp_x_day' } },
  ]);
});

test('a non-lamp profile store fires no change event', () => {
  const args = parseStoreProfile({ store: 'input_text.ls_house_day', on: true });
  const effects = [...planStore(args, cachedProfile('{}', args.entity), () => ['brightness'])];
  assert.deepEqual(effects.map(effect => effect.kind), ['service']);
});

test('an override block sets the scopes not already scheduled to it and clears the rest', () => {
  const args = parseOverrideBlockArgs({ scope: 'house', block: 'Cosy', via: 'app' });
  const scheduled = (key: string | undefined) => key === 'kitchen' ? 'cosy' : 'day';
  assert.deepEqual([...planOverrideBlock(args, ['kitchen', 'hall'], scheduled)], [
    { kind: 'event', event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 'house', value: 'cosy' }, { kind: 'block', target: 'hall', value: 'cosy' }], via: 'app' } },
    { kind: 'event', event: 'ls_override', data: { op: 'clear', keys: ['block:kitchen'], via: 'app' } },
  ]);
});

test('house rooms are the labelled lamps\' areas, unique, without private rooms', () => {
  const view = house({}, {
    labels: { house_schedule: ['light.a', 'light.b', 'light.c'], on_off: ['switch.d'], private_room: ['bedroom'] },
    areas: { 'light.a': 'kitchen', 'light.b': 'bedroom', 'light.c': 'kitchen', 'switch.d': 'hall' },
  });
  assert.deepEqual(houseRooms(view), ['kitchen', 'hall']);
});

test('the Sara mode switch toggles the stored mode, and clear-all clears everything', () => {
  const via = carry('app');
  assert.deepEqual([...toggleSaraMode(true, via)], [{ kind: 'event', event: 'ls_override', data: { op: 'clear', keys: ['mode:sara'], via: 'app' } }]);
  assert.deepEqual([...toggleSaraMode(false, via)], [{ kind: 'event', event: 'ls_override', data: { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app' } }]);
  assert.deepEqual([...clearAllOverrides(via)], [{ kind: 'event', event: 'ls_override', data: { op: 'clear_all', via: 'app' } }]);
});
