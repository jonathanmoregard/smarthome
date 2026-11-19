import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheWrite, fullLights, fullReason, gradientUpdates, mergeRoomPlan, renderAck, renderOpening, roomPlanRequest, roomsPlan, roomsStart } from '../../src/domain/dispatch-render.ts';
import { fullPlan, roomPlanView } from '../../src/parse/dispatch-render.ts';
import { timestamp } from '../../src/parse/accessors.ts';
import type { EntityState, JsonObject } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';

const NOW = '2026-10-26T12:00:00+01:00';
const REVISION = '2026-10-26T11:00:00+00:00';
const runtime = 'sensor.ls_effects_runtime';
const overrides = (attributes: JsonObject): EntityState => ({ state: '0', attributes, last_updated: REVISION });

test('nothing pending and no unhandled full render is nothing to do', () => {
  assert.equal(renderOpening(house({ 'sensor.ls_overrides': overrides({ pending_rooms: { a: 1 } }), [runtime]: ['g', { handled_rooms: { a: 1 } }] })), undefined);
});

test('the opening finds the rooms whose pending version is unhandled, and an unhandled full render', () => {
  const view = house({
    'sensor.ls_overrides': overrides({ pending_rooms: { a: 1, b: 2 }, full_version: 'v2', received_at: 7, last_request: 'r' }),
    [runtime]: ['g', { handled_rooms: { a: 1, b: 1 }, handled_full: 'v1' }],
  });
  const opening = renderOpening(view);
  assert.ok(opening !== undefined);
  assert.deepEqual([opening.started, opening.revision, opening.rooms, opening.full, opening.fullVersion, opening.received, opening.request],
    [timestamp(NOW), REVISION, ['b'], true, 'v2', 7, 'r']);
});

test('the opening raises on a missing overrides sensor, and on a malformed full version', () => {
  assert.throws(() => renderOpening(house({})), /ls_render\.revision/);
  assert.throws(() => renderOpening(house({ 'sensor.ls_overrides': overrides({ full_version: 3 }) })), /ls_render\.full_version/);
});

test('the full render asks with its stored reason, Jinja-or config, and its stored lights, Jinja-or none', () => {
  assert.equal(fullReason(house({ 'sensor.ls_overrides': overrides({ full_reason: 'tick' }) })), 'tick');
  assert.equal(fullReason(house({ 'sensor.ls_overrides': overrides({ full_reason: '' }) })), 'config');
  assert.deepEqual(fullLights(house({ 'sensor.ls_overrides': overrides({ full_lights: ['light.a'] }) })), ['light.a']);
  assert.deepEqual(fullLights(house({ 'sensor.ls_overrides': overrides({ full_lights: {} }) })), []);
});

test('a full plan refreshes each baseline room cache whose gradients changed', () => {
  const planned = fullPlan({ plan: { base: { 'light.a': { area: 'x' }, 'light.b': { area: 'y' } }, gradients: { 'light.a': { g: 1 }, 'light.b': { g: 2 } } } }, []);
  const view = house({ 'sensor.ls_cache_x': ['1', { cache: { keep: 1, gradients: { 'light.a': { g: 0 } } } }], 'sensor.ls_cache_y': ['1', { cache: { gradients: { 'light.b': { g: 2 } } } }] });
  assert.deepEqual(gradientUpdates(view, planned), { x: { keep: 1, gradients: { 'light.a': { g: 1 } } } });
});

test('a room plan is asked with the stored overrides and that room\'s cache', () => {
  const view = house({ 'sensor.ls_overrides': overrides({ overrides: { k: {} } }), 'sensor.ls_cache_x': ['1', { cache: { c: 1 } }] });
  assert.deepEqual(roomPlanRequest(view, 'x'), { room: 'x', overrides: { k: {} }, cache: { c: 1 }, reason: 'remote' });
});

test('merging a room plan replaces that room\'s stored targets in place of the others, and accumulates the rest', () => {
  const view = house({ [runtime]: ['g', { targets: { 'light.o': { area: 'y' }, 'light.a': { area: 'x' } }, assignments: { 'light.a': { area: 'x' } } }] });
  const planned = roomPlanView({ plan: {
    resolved: { targets: { 'light.a': { area: 'x', new: true } }, assignments: {} }, base: { 'light.a': {} }, switches: { 's.x': {} },
    mirror: [{ m: 1 }], stale_keys: ['k', 'k'], sara_mirror: 'on',
  }, cache_update: { fresh: true } });
  const merged = mergeRoomPlan(roomsStart(view), 'x', planned);
  assert.deepEqual(merged.targets, { 'light.o': { area: 'y' }, 'light.a': { area: 'x', new: true } });
  assert.deepEqual(merged.assignments, {});
  assert.deepEqual([merged.bases, merged.switches, merged.mirrors, merged.stale, merged.saraMirror], [{ 'light.a': {} }, { 's.x': {} }, [{ m: 1 }], ['k'], 'on']);
  assert.deepEqual(merged.updates, { x: { fresh: true } });
  const plan = roomsPlan(merged, { revision: REVISION, started: 5, rooms: ['x'] }) as unknown as JsonObject;
  assert.deepEqual(Object.keys(plan), ['base', 'resolved', 'switches', 'mirror', 'stale_keys', 'revision', 'plan_order', 'remote', 'remote_rooms',
    'sara_mirror', 'output_targets']);
  assert.deepEqual([plan.plan_order, plan.remote, plan.output_targets], [5, false, ['light.a']]);
});

test('a cache is written only to a room cache sensor that has a value', () => {
  assert.equal(cacheWrite(house({ 'sensor.ls_cache_x': 'unknown' }), 'x', {} as never), undefined);
  assert.deepEqual(cacheWrite(house({ 'sensor.ls_cache_x': '1' }), 'x', { c: 1 } as never), {
    kind: 'service', service: 'variable.update_sensor', target: { entity_id: 'sensor.ls_cache_x' },
    data: { value: NOW, attributes: { cache: { c: 1 } }, replace_attributes: false },
  });
});

test('a completed dispatch is acknowledged with its latency, guarded on output success', () => {
  const view = house({ 'sensor.ls_overrides': overrides({}), [runtime]: ['g', { generation: 'g1', handled_full: 'v0' }] });
  const opening = { started: 1, revision: REVISION, received: 7, request: 'r', pending: { x: 2 }, fullVersion: undefined, full: false, rooms: ['x'] };
  const ack = renderAck(view, opening, 3, { completed: true, published_at: [4] });
  assert.deepEqual(ack, {
    kind: 'service', service: 'variable.update_sensor', target: { entity_id: runtime },
    data: { value: NOW, replace_attributes: false, attributes: {
      handled_rooms: { x: 2 }, handled_full: 'v0',
      last_latency: { request_id: 'r', received_at: 7, started_at: 1, planned_at: 3, published_at: [4], completed_at: timestamp(NOW), rooms: ['x'], full: false },
    } },
    guard: { revision: REVISION, generation: 'g1', requiresOutputSuccess: true },
  });
  assert.equal(renderAck(view, opening, 3, null), undefined);
  assert.equal(renderAck(view, opening, 3, { completed: false, published_at: [] }), undefined);
  assert.equal(renderAck(view, { ...opening, revision: 'older' }, 3, { completed: true, published_at: [] }), undefined);
});
