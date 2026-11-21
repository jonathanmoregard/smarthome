import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteDecision, remoteOpening } from '../../src/domain/remote-input.ts';
import { dependencies, expiry, refreshBaseline, roomOpening, roomPlanAnswer } from '../../src/domain/planning.ts';
import { remoteRoomPlan } from '../../src/parse/remote-input.ts';
import { parseRoomBaseline, parseRoomPlanArgs } from '../../src/parse/planning.ts';
import { recordTimestamp } from '../../src/parse/resolution.ts';
import { timestamp } from '../../src/parse/accessors.ts';
import { emptyCatalog, parseCatalog } from '../../src/runtime/catalog.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import type { EntityState, JsonObject } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';

const NOW = '2026-10-26T12:00:00+01:00';
const REVISION = '2026-10-26T11:00:00+00:00';
const STAMP = recordTimestamp(NOW);
const sensor = (attributes: JsonObject = {}): EntityState => ({ state: '0', attributes, last_updated: REVISION });
const areas = { 'light.lamp': 'studio', 'switch.fan': 'studio', 'light.away': 'hall' };
const catalog = parseCatalog({ effects: { Glow: {} }, members: { 'light.lamp': ['light.bulb'], 'light.away': [] }, topics: {}, groups: {}, multicast: [] });

// ls_remote_plan

test('the opening reads the room, the revision and the stamp, and asks for context only for the arrows', () => {
  const view = house({ 'sensor.ls_overrides': sensor() }, { areas });
  const left = remoteOpening(view, { source: 'remote', area: 'studio', command: 'left' });
  assert.deepEqual([left.room, left.revision, left.stamp, left.timingRevision, left.needsContext], ['studio', REVISION, STAMP, 0, true]);
  assert.equal(remoteOpening(view, { source: 'remote', area: 'studio', command: 'right' }).needsContext, true);
  assert.equal(remoteOpening(view, { source: 'remote', area: 'studio', command: 'toggle' }).needsContext, false);
  assert.equal(remoteOpening(view, { source: 'remote', area: 'attic', command: 'toggle' }).room, undefined);
});

test('a dimming press under next-block expiry fingerprints the timing helpers and needs context', () => {
  const later = '2026-10-26T11:30:00+00:00';
  const view = house({
    'sensor.ls_overrides': sensor(), 'input_boolean.ls_ovr_next_block_on': 'on',
    'input_number.ls_studio_cosy_fade': { state: '5', attributes: {}, last_updated: later },
  }, { areas });
  const opening = remoteOpening(view, { source: 'remote', area: 'studio', command: 'up' });
  assert.equal(opening.timingRevision, recordTimestamp(later));
  assert.equal(opening.needsContext, true);
});

test('the opening raises on a missing overrides sensor, before any call', () => {
  assert.throws(() => remoteOpening(house({}, { areas }), { source: 'remote', area: 'studio', command: 'left' }), /ls_remote_plan\.revision/);
});

const noContext = remoteRoomPlan(undefined);

test('toggle flips the room: its catalog lamps and switch-range entities, off when any is on', () => {
  const view = house({ 'sensor.ls_overrides': sensor({ switch_ranges: { 'switch.fan': {} } }), 'switch.fan': 'on' }, { areas });
  const args = { source: 'remote', area: 'studio', command: 'toggle' };
  const result = remoteDecision(view, args, remoteOpening(view, args), noContext, catalog);
  assert.deepEqual(result, { op: 'power', area: 'studio', on: false, targets: ['light.lamp', 'switch.fan'], via: 'remote',
    input_revision: REVISION, received_at: STAMP, request_id: `remote:${STAMP}` });
});

test('toggle follows a saved room power over the lamp states', () => {
  const view = house({ 'sensor.ls_overrides': sensor({ power: { studio: false } }), 'light.lamp': 'on' }, { areas });
  const args = { source: 'remote', area: 'studio', command: 'toggle' };
  const result = remoteDecision(view, args, remoteOpening(view, args), noContext, catalog);
  assert.ok(result.op === 'power');
  assert.equal(result.on, true);
});

test('reset clears the room, sara_toggle flips the mode, an unknown room is a noop', () => {
  const view = house({ 'sensor.ls_overrides': sensor({ overrides: { 'mode:sara': {} } }) }, { areas });
  const decide = (area: string, command: string) => {
    const args = { source: 'remote', area, command };
    const { input_revision, received_at, request_id, ...op } = remoteDecision(view, args, remoteOpening(view, args), noContext, emptyCatalog());
    assert.deepEqual([input_revision, received_at, request_id], [REVISION, STAMP, `remote:${STAMP}`]);
    return op;
  };
  assert.deepEqual(decide('studio', 'reset'), { op: 'clear_room', area: 'studio', via: 'remote' });
  assert.deepEqual(decide('studio', 'sara_toggle'), { op: 'clear', keys: ['mode:sara'], via: 'remote' });
  assert.deepEqual(decide('attic', 'reset'), { op: 'noop' });
});

test('a first up press stores a one-step adjustment over the default range', () => {
  const view = house({ 'sensor.ls_overrides': sensor() }, { areas });
  const args = { source: 'remote', area: 'studio', command: 'up' };
  const result = remoteDecision(view, args, remoteOpening(view, args), noContext, emptyCatalog());
  assert.ok(result.op === 'set');
  assert.deepEqual(result.records, [{ kind: 'input', key: { kind: 'remote input', source: 'remote' }, source: 'remote', scope: 'room',
    target: 'studio', value: {
    step_range: { min: -20, max: 20 },
    adjustment: { steps: 1, lower: -19, upper: 20, anchor: 'current', updated: STAMP, last: 'up', has_up: true },
  } }]);
});

// ls_room_plan

const roomArgs = (fields: JsonObject = {}) => parseRoomPlanArgs({ room: 'studio', ...fields });
const planView = (states: Record<string, string | [string, JsonObject] | EntityState> = {}) => house({ 'sensor.ls_overrides': sensor(), ...states }, {
  areas, labels: { house_schedule: ['light.lamp', 'light.away', 'light.zed'], on_off: ['switch.fan'] },
});

test('the room opening reads the revision first, and an absent cache is a miss', () => {
  assert.throws(() => roomOpening(house({}), roomArgs()), /ls_room_plan\.revision/);
  const opening = roomOpening(planView(), roomArgs({ test_now: 1000 }));
  assert.deepEqual([opening.at, opening.revision, opening.hit], [1000, REVISION, undefined]);
  assert.deepEqual(opening.periods, {});
});

test('the dependency fingerprint holds the room\'s lamps and switches, sorted, and the tick and private flags', () => {
  const view = house({}, { areas: { ...areas, 'light.zed': 'studio' },
    labels: { house_schedule: ['light.zed', 'light.lamp', 'light.away'], on_off: ['switch.fan'], private_room: ['studio'] } });
  const deps = dependencies(view, 'studio', 'tick', carry([1, 2, 3]));
  assert.deepEqual([deps.lamps, deps.switches, deps.private, deps.tick, deps.expiry], [['light.lamp', 'light.zed'], ['switch.fan'], true, true, 'unknown']);
  assert.deepEqual(deps.warm, [1, 2, 3]);
});

const baseline = (details: JsonObject, extra: JsonObject = {}) => parseRoomBaseline({
  targets: { 'room:studio': { is_room: true }, 'light.lamp': { on: true } },
  schedule: { schedule_details: { studio: details }, profiles: {} }, ...extra,
}, 'test baseline');

test('a fading room expires now; a settled one at its next boundary', () => {
  const view = house({});
  assert.equal(expiry(view, baseline({}), 'studio', 1000), 1000);
  assert.equal(expiry(view, baseline({ fading: false, next_fs: 1500, left: 900, cur_ts: 990 }), 'studio', 1000), 1080);
});

test('the refresh mirrors the scheduled block onto the room select and records lamp observations', () => {
  const view = house({ 'input_select.ls_studio_override': 'Day', 'light.lamp': 'off' });
  const deps = dependencies(view, 'studio', 'remote', carry([]));
  const refreshed = refreshBaseline(view, baseline({ cur: 'cosy', fading: false }), undefined, 'studio', deps, roomArgs().overrides, 1000);
  assert.deepEqual(refreshed.stale, []);
  const schedule = refreshed.schedule as unknown as JsonObject;
  assert.deepEqual(schedule.mirror, [{ entity: 'input_select.ls_studio_override', option: 'Cosy' }]);
  const lamp = refreshed.targets['light.lamp'] as unknown as JsonObject;
  assert.deepEqual(Object.keys(lamp), ['on', 'ignore_overrides', 'observed']);
  assert.equal(Object.hasOwn(refreshed.targets['room:studio'] as unknown as JsonObject, 'observed'), false);
});

test('the answer stamps the plan order from now and asks for the Sara mirror only when it differs', () => {
  const view = house({ 'input_boolean.ls_sara_mode_mirror': 'off' });
  const refreshed = { targets: {}, schedule: carry({ keep: 1 }), stale: [] };
  const answer = roomPlanAnswer(view, {
    room: 'studio', reason: 'remote', revision: REVISION, refreshed, active: { 'mode:sara': carry({}) },
    resolved: { targets: {}, assignments: {} }, gradients: carry({}), catalog: carry({}), switches: {}, update: null, hit: false,
  });
  const plan = answer.plan as unknown as JsonObject;
  assert.deepEqual([plan.keep, plan.room, plan.revision, plan.plan_order, plan.remote, plan.sara_mirror], [1, 'studio', REVISION, timestamp(NOW), true, 'on']);
  assert.deepEqual([answer.cache_update, answer.cache_hit], [null, false]);
});
