import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInit, dispatchUpdate } from '../../src/domain/dispatch-render.ts';
import type { DispatchCmd, DispatchModel } from '../../src/domain/dispatch-render.ts';
import type { GroupCommand } from '../../src/domain/grouping.ts';
import { parseDispatchArgs } from '../../src/parse/dispatch-render.ts';
import { timestamp } from '../../src/parse/accessors.ts';
import type { EntityState, JsonObject } from '../../src/runtime/context.ts';
import type { Effect, HouseView } from '../../src/runtime/effects.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { house } from './house-view.ts';

const NOW = '2026-10-26T12:00:00+01:00';
const REVISION = '2026-10-26T11:00:00+00:00';
const runtime = 'sensor.ls_effects_runtime';
const catalogDocument: JsonObject = { effects: {}, members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'z2m/bulb/set' }, groups: {}, multicast: [] };
const steady: JsonObject = { on: true, area: 'studio', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
const effect = (name: string): JsonObject => ({ kind: 'effect', effect: name, intensity: 80 });
const candle: JsonObject = { on: true, area: 'studio', brightness: effect('Candle'), color: effect('Candle') };
const room: JsonObject = { is_room: true, on: true };

function args(plan: JsonObject = {}, targets: JsonObject = { 'light.lamp': steady, 'room:studio': room }) {
  return parseDispatchArgs({ plan: { revision: REVISION, plan_order: 10, base: {}, resolved: { targets, assignments: {} }, ...plan } });
}
function view(states: Record<string, string | [string, JsonObject] | EntityState> = {}, runtimeAttributes: JsonObject = {}): HouseView {
  return house({
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: REVISION },
    [runtime]: ['g1', { generation: 'g1', plan_order: 5, ...runtimeAttributes }],
    'light.lamp': 'on', 'light.bulb': 'on', ...states,
  }, { catalogDocument });
}
const catalog = carry({ the: 'catalog' });
const generation = carry('g1');
const light: GroupCommand = { topic: 'z2m/bulb/set', payload: carry({ brightness: 100 }), members: ['light.bulb'], owners: ['light.lamp'], group: null };
const batch = { commands: [light], rejected: [], input_count: 1, endpoint_count: 1, command_count: 1 };

type Step = [DispatchModel, DispatchCmd[]];
const open = (a = args(), v = view()): Step => dispatchUpdate(dispatchInit(a), { tag: 'start', house: v });
const catalogued = (a = args(), v = view()): Step => dispatchUpdate(open(a, v)[0], { tag: 'catalog', catalog, house: v });
const assigned = (a = args(), v = view()): Step => dispatchUpdate(catalogued(a, v)[0], { tag: 'assigned', result: { generation }, house: v });
const framed = (a = args(), v = view()): Step => dispatchUpdate(assigned(a, v)[0], { tag: 'framed', batch, house: v });
const emitted = (a = args(), v = view(), after = v): Step =>
  dispatchUpdate(framed(a, v)[0], { tag: 'emitted', result: { published_at: [1], completed: true }, house: after });
const effects = (cmds: DispatchCmd[]): Effect[] => cmds.map(cmd => {
  assert.equal(cmd.tag, 'effect');
  return (cmd as Extract<DispatchCmd, { tag: 'effect' }>).effect;
});

test('a plan for a moved revision, or older than the last dispatched, is dropped before anything runs', () => {
  assert.deepEqual(open(args({ revision: 'older' })), [{ tag: 'done', answer: null }, []]);
  assert.deepEqual(open(args(), view({}, { plan_order: 11 })), [{ tag: 'done', answer: null }, []]);
});

test('an accepted plan parses its details, then fetches the catalog', () => {
  const [model, cmds] = open();
  assert.equal(model.tag, 'cataloguing');
  assert.deepEqual(cmds, [{ tag: 'catalog' }]);
  assert.throws(() => open(parseDispatchArgs({ plan: { revision: REVISION, plan_order: 10 } })), /ls_dispatch\.plan.*resolved/);
});

test('the lamps to send are the on, sendable lamps whose light is not already applied; rooms never', () => {
  const [, cmds] = catalogued();
  assert.deepEqual(cmds, [{ tag: 'assign', args: {
    targets: { 'light.lamp': steady, 'room:studio': room }, assignments: {}, revision: REVISION, invalidate: ['light.lamp'], plan_order: 10,
  } }]);
  const applied = catalogued(args(), view({}, { applied: { 'light.lamp': steady } }))[1][0];
  assert.ok(applied !== undefined && applied.tag === 'assign');
  assert.deepEqual(applied.args.invalidate, [], 'an applied light is not resent');
  const off = catalogued(args(), view({ 'light.lamp': 'off' }))[1][0];
  assert.ok(off !== undefined && off.tag === 'assign');
  assert.deepEqual(off.args.invalidate, [], 'an off lamp is not sent');
});

test('the frame plan gets the lamps to send, the catalog as fetched, and the clock as read after the assignment', () => {
  const later = house({ ...Object.fromEntries(Object.entries(view().state)) }, { catalogDocument, now: '2026-10-26T12:00:05+01:00' });
  const [, cmds] = dispatchUpdate(catalogued()[0], { tag: 'assigned', result: { generation }, house: later });
  assert.deepEqual(cmds, [{ tag: 'frame', args: {
    targets: { 'light.lamp': steady }, catalog, timestamp: timestamp('2026-10-26T12:00:05+01:00'), transition_cap: null, transition_rooms: [],
  } }]);
  const remote = assigned(args({ remote: true }))[1][0];
  assert.ok(remote !== undefined && remote.tag === 'frame');
  assert.deepEqual([remote.args.transition_cap, remote.args.transition_rooms], [0.5, null]);
});

test('the light goes out through effects_emit under the assigned generation', () => {
  assert.deepEqual(framed()[1], [{ tag: 'emit', args: { commands: [light], revision: REVISION, generation } }]);
});

test('a candle lamp is started after its light: a second emission of channel_change per on member', () => {
  const [model, cmds] = emitted(args({}, { 'light.lamp': candle }));
  assert.equal(model.tag, 'starting');
  assert.deepEqual(cmds, [{ tag: 'emit', args: { commands: [
    { topic: 'z2m/bulb/set', payload: { effect: 'channel_change' }, members: ['light.bulb'], owners: ['light.lamp'], group: null },
  ], revision: REVISION, generation } }]);
});

test('a complete output records what was applied under the generation, guarded on output success', () => {
  const v = view({}, { applied: { 'light.other': steady } });
  const [model, cmds] = emitted(args(), view(), v);
  assert.equal(model.tag, 'switching');
  assert.deepEqual(effects(cmds), [{
    kind: 'service', service: 'variable.update_sensor', target: { entity_id: runtime },
    data: { value: generation, replace_attributes: false, attributes: { applied: { 'light.other': steady, 'light.lamp': steady } } },
    guard: { revision: REVISION, generation, requiresOutputSuccess: true },
  }]);
});

test('a candle start that completes records the applied light and nothing else', () => {
  const a = args({}, { 'light.lamp': candle });
  const [, cmds] = dispatchUpdate(emitted(a)[0], { tag: 'emitted', result: { published_at: [2], completed: true }, house: view() });
  const update = effects(cmds)[0];
  assert.ok(update !== undefined && update.kind === 'service');
  assert.deepEqual(update.data.attributes, { applied: { 'light.lamp': candle } });
});

test('output that moved the generation, or did not complete, records nothing', () => {
  assert.deepEqual(emitted(args(), view(), view({}, { generation: 'g2' })), [{ tag: 'done', answer: null }, []]);
  const [model, cmds] = dispatchUpdate(framed()[0], { tag: 'emitted', result: { published_at: [], completed: false }, house: view() });
  assert.equal(model.tag, 'finishing');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]?.tag, 'plan');
});

test('each switch whose state differs is switched, one per step, with the house re-read between', () => {
  const a = args({ switches: { 'switch.a': { on: true }, 'switch.b': { on: false }, 'switch.c': { on: true } } });
  const v = view({ 'switch.a': 'off', 'switch.b': 'off', 'switch.c': 'off' }, { applied: { 'light.lamp': steady } });
  const [first, firstCmds] = emitted(a, v);
  assert.deepEqual(effects(firstCmds), [{ kind: 'service', service: 'homeassistant.turn_on', data: {}, target: { entity_id: 'switch.a' },
    guard: { revision: REVISION, generation } }]);
  const [second, secondCmds] = dispatchUpdate(first, { tag: 'performed', house: v });
  assert.deepEqual(effects(secondCmds).map(e => e.kind === 'service' ? e.target : e), [{ entity_id: 'switch.c' }]);
  const [third, thirdCmds] = dispatchUpdate(second, { tag: 'performed', house: v });
  assert.equal(third.tag, 'finishing');
  assert.equal(thirdCmds[0]?.tag, 'plan');
});

test('the tail mirrors, flips the Sara mirror and clears stale keys, lazily, then answers', () => {
  const a = args({ mirror: [{ entity: 'input_select.x', option: 'Day' }], sara_mirror: 'on', stale_keys: ['k'] });
  const v = view({}, { applied: { 'light.lamp': steady } });
  const [model, cmds] = emitted(a, v);
  assert.equal(model.tag, 'finishing');
  const tail = cmds[0];
  assert.ok(tail !== undefined && tail.tag === 'plan');
  assert.deepEqual([...tail.plan], [
    { kind: 'service', service: 'input_select.select_option', data: { option: 'Day' }, target: { entity_id: 'input_select.x' }, guard: { revision: REVISION, generation } },
    { kind: 'service', service: 'input_boolean.turn_on', data: {}, target: { entity_id: 'input_boolean.ls_sara_mode_mirror' }, guard: { revision: REVISION, generation } },
    { kind: 'event', event: 'ls_override', data: { op: 'clear', keys: ['k'], via: 'rule_next_block', expected_revision: REVISION } },
  ]);
  assert.deepEqual(dispatchUpdate(model, { tag: 'performed', house: v }), [{ tag: 'done', answer: { completed: true, published_at: [1] } }, []]);
  assert.deepEqual(dispatchUpdate(model, { tag: 'performed', house: view({}, { generation: 'g2' }) }),
    [{ tag: 'done', answer: { completed: false, published_at: [1] } }, []]);
});

test('a revision that moves during the switches stops the switching and drops the tail', () => {
  const a = args({ switches: { 'switch.a': { on: true }, 'switch.b': { on: true } }, mirror: [{ entity: 'input_select.x', option: 'Day' }] });
  const applied = { applied: { 'light.lamp': steady } };
  const v = view({ 'switch.a': 'off', 'switch.b': 'off' }, applied);
  const moved = view({ 'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: 'later' }, 'switch.a': 'on', 'switch.b': 'off' }, applied);
  const [model, cmds] = emitted(a, v);
  assert.equal(effects(cmds).length, 1);
  assert.deepEqual(dispatchUpdate(model, { tag: 'performed', house: moved }), [{ tag: 'done', answer: null }, []]);
});

test('a message the phase does not expect is a defect', () => {
  assert.throws(() => dispatchUpdate(open()[0], { tag: 'performed', house: view() }), /ls_dispatch.*cataloguing.*performed/);
});
