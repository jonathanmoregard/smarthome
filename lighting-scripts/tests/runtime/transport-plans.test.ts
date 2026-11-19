import assert from 'node:assert/strict';
import test from 'node:test';
import { assignDecision, filterCommands, frameRows, planAssignUpdate, planStops, publishCommand, stillCurrent, stopCommands } from '../../src/domain/transport.ts';
import type { EmitCommand } from '../../src/domain/transport.ts';
import { parseAssignArgs, parseFilterArgs, parseFramePlanArgs, runtimeState } from '../../src/parse/transport.ts';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import type { JsonObject } from '../../src/runtime/context.ts';
import type { Effect } from '../../src/runtime/effects.ts';
import { house } from './house-view.ts';

const NOW = '2026-10-26T12:00:00+01:00';
const REVISION = '2026-10-26T11:00:00+00:00';
const runtime = 'sensor.ls_effects_runtime';
const bridge = 'binary_sensor.zigbee2mqtt_bridge_connection_state';
const overrides = { state: '0', attributes: {}, last_updated: REVISION };
const catalogDocument: JsonObject = {
  effects: {}, members: { 'light.lamp': ['light.bulb', 'light.bare'] }, topics: { 'light.bulb': 'z2m/bulb/set' },
  groups: { 'light.group': ['light.lamp', 'light.other'] }, multicast: [],
};
const steady: JsonObject = { on: true, brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
const breathe: JsonObject = { on: true, brightness: { kind: 'effect', effect: 'Breathe', intensity: 80, updated: 1 }, color: { kind: 'constant', value: { kelvin: 2500 } } };

// effects_frame_plan

test('a frame row goes to every on member of an on lamp, the topic null where the catalog has none', () => {
  const view = house({ 'light.lamp': 'on', 'light.bulb': 'on', 'light.bare': 'on' });
  const rows = frameRows(view, parseFramePlanArgs({ catalog: catalogDocument, targets: { 'light.lamp': steady } }));
  assert.deepEqual(rows, [
    { entity: 'light.bulb', owner: 'light.lamp', topic: 'z2m/bulb/set', payload: { brightness: 100, color_temp: 400, transition: 3 } },
    { entity: 'light.bare', owner: 'light.lamp', topic: null, payload: { brightness: 100, color_temp: 400, transition: 3 } },
  ]);
});

test('an off lamp, and an off member, get no frame row', () => {
  const args = parseFramePlanArgs({ catalog: catalogDocument, targets: { 'light.lamp': steady } });
  assert.deepEqual(frameRows(house({ 'light.lamp': 'off', 'light.bulb': 'on' }), args), []);
  assert.deepEqual(frameRows(house({ 'light.lamp': 'on', 'light.bulb': 'off', 'light.bare': 'off' }), args), []);
});

test('a switched-off target is sent OFF with its transition', () => {
  const view = house({ 'light.lamp': 'on', 'light.bulb': 'on' });
  const rows = frameRows(view, parseFramePlanArgs({ catalog: catalogDocument, targets: { 'light.lamp': { ...steady, on: false, transition: 2 } } }));
  assert.deepEqual(rows[0]?.payload, { state: 'OFF', transition: 2 });
});

// effects_emit

function command(fields: Partial<EmitCommand> = {}): EmitCommand {
  return { body: '{"state":"ON"}', turnsOff: false, owners: ['light.lamp'], members: ['light.bulb'], topic: 'z2m/bulb/set', ...fields };
}
const live = (extra: Record<string, [string, JsonObject] | string> = {}) => house({
  'sensor.ls_overrides': overrides, [runtime]: ['g', { generation: 'g1' }], [bridge]: 'on',
  'light.lamp': 'on', 'light.bulb': 'on', ...extra,
}, { areas: { 'light.lamp': 'kitchen' } });
const gate = (fields: { command?: EmitCommand; current?: string; effectTargets?: JsonObject } = {}) => ({
  revision: REVISION, generation: 'g1', current: fields.current ?? REVISION, command: fields.command ?? command(),
  effectTargets: fields.effectTargets ?? {},
});

test('an allowed command is one guarded MQTT publish of its body', () => {
  const effect = publishCommand(live(), gate());
  assert.deepEqual(effect, {
    kind: 'service', service: 'mqtt.publish', data: { topic: 'z2m/bulb/set', payload: '{"state":"ON"}', qos: 0, retain: false },
    guard: { revision: REVISION, generation: 'g1', owners: ['light.lamp'], members: ['light.bulb'] },
  });
});

test('a command is withheld when the revision moved, the generation moved, or the bridge is down', () => {
  assert.equal(publishCommand(live(), gate({ current: 'later' })), undefined);
  assert.equal(publishCommand(live({ [runtime]: ['g', { generation: 'g2' }] }), gate()), undefined);
  assert.equal(publishCommand(live({ [bridge]: 'off' }), gate()), undefined);
});

test('a command is withheld when an owner or a member is not on', () => {
  assert.equal(publishCommand(live({ 'light.lamp': 'off' }), gate()), undefined);
  assert.equal(publishCommand(live({ 'light.bulb': 'unavailable' }), gate()), undefined);
});

test('a closed power gate withholds a light command but lets an OFF through', () => {
  const closed = { 'sensor.ls_overrides': { ...overrides, attributes: { power: { kitchen: false } } } };
  const view = house({ ...closed, [runtime]: ['g', { generation: 'g1' }], [bridge]: 'on', 'light.lamp': 'on', 'light.bulb': 'on' },
    { areas: { 'light.lamp': 'kitchen' } });
  assert.equal(publishCommand(view, gate()), undefined);
  assert.notEqual(publishCommand(view, gate({ command: command({ turnsOff: true }) })), undefined);
});

test('effect targets gate on the runtime assignment and ride in the guard', () => {
  const assigned = { [runtime]: ['g', { generation: 'g1', assignments: { 'light.lamp': { effect: 'Candle' } } }] as [string, JsonObject] };
  const matching = publishCommand(live(assigned), gate({ effectTargets: { 'light.lamp': { effect: 'Candle' } } }));
  assert.ok(matching !== undefined && matching.kind === 'service');
  assert.deepEqual(matching.guard?.effectTargets, { 'light.lamp': { effect: 'Candle' } });
  assert.equal(publishCommand(live(assigned), gate({ effectTargets: { 'light.lamp': { effect: 'Breathe' } } })), undefined);
  assert.equal(publishCommand(live(assigned), gate({ effectTargets: { 'light.other': {} } })), undefined);
});

test('still current needs both the revision and the runtime generation unchanged', () => {
  assert.equal(stillCurrent(live(), 'effects_emit', REVISION, 'g1'), true);
  assert.equal(stillCurrent(live(), 'effects_emit', 'older', 'g1'), false);
  assert.equal(stillCurrent(live(), 'effects_emit', REVISION, null), false);
  assert.throws(() => stillCurrent(house({}), 'effects_emit', REVISION, 'g1'), /effects_emit\.revision/);
});

// effects_assign

const assignView = (attributes: JsonObject, extra: Record<string, string> = {}) =>
  house({ [runtime]: ['g0', { revision: REVISION, generation: 'g0', plan_order: 5, ...attributes }], ...extra });
const details = (args: JsonObject) => parseAssignArgs({ revision: REVISION, targets: {}, assignments: {}, ...args }).details();

test('an unchanged assignment keeps its generation and writes only for a newer plan order', () => {
  const same = assignView({ targets: { 'light.lamp': steady } });
  const older = assignDecision(same, REVISION, details({ targets: { 'light.lamp': steady }, plan_order: 5 }));
  assert.deepEqual([older.changed, older.write, older.generation], [false, false, 'g0']);
  assert.deepEqual([...planAssignUpdate(older, REVISION, details({}))], []);
  const newer = assignDecision(same, REVISION, details({ targets: { 'light.lamp': steady }, plan_order: 6 }));
  assert.deepEqual([newer.changed, newer.write, newer.planOrder], [false, true, 6]);
});

test('a changed assignment takes now as its generation and writes the runtime in the captured key order', () => {
  const view = assignView({ targets: {}, applied: { 'light.lamp': steady, 'light.kept': steady } });
  const parsed = details({ targets: { 'light.lamp': steady }, assignments: { 'light.lamp': {} }, invalidate: ['light.lamp'] });
  const decision = assignDecision(view, REVISION, parsed);
  assert.deepEqual([decision.changed, decision.generation, decision.planOrder], [true, NOW, 5]);
  const effects = [...planAssignUpdate(decision, REVISION, parsed)];
  assert.deepEqual(effects, [{
    kind: 'service', service: 'variable.update_sensor', target: { entity_id: runtime },
    data: { value: NOW, replace_attributes: false, attributes: {
      targets: { 'light.lamp': steady }, assignments: { 'light.lamp': {} }, applied: { 'light.kept': steady },
      revision: REVISION, generation: NOW, plan_order: 5,
    } },
  }]);
  assert.deepEqual(Object.keys((effects[0] as Extract<Effect, { kind: 'service' }>).data), ['value', 'replace_attributes', 'attributes']);
});

test('a stored revision other than the request is a change', () => {
  const decision = assignDecision(assignView({ revision: 'other' }), REVISION, details({}));
  assert.equal(decision.changed, true);
});

test('a non-number stored plan order raises when the request carries none', () => {
  assert.throws(() => assignDecision(assignView({ plan_order: 'x' }), REVISION, details({})), /plan_order/);
});

test('a lamp leaving a bulb effect stops it on every on member that has a topic', () => {
  const catalog = parseCatalog(catalogDocument);
  const view = house({
    [runtime]: ['g0', { assignments: { 'light.lamp': { effect: 'Breathe', ...breathe } }, targets: { 'light.lamp': breathe } }],
    'light.bulb': 'on', 'light.bare': 'on',
  });
  const parsed = details({ targets: { 'light.lamp': steady } });
  const commands = stopCommands(view, catalog, parsed.targetViews(), runtimeState(view));
  assert.deepEqual(commands, [
    { topic: 'z2m/bulb/set', payload: { effect: 'stop_colorloop' }, members: ['light.bulb'], owners: ['light.lamp'], group: false },
    { topic: 'z2m/bulb/set', payload: { effect: 'stop_effect' }, members: ['light.bulb'], owners: ['light.lamp'], group: false },
  ]);
  assert.deepEqual(stopCommands(house({ [runtime]: ['g0', {}], 'light.bulb': 'on' }), catalog, parsed.targetViews(), runtimeState(view)), commands,
    'the previous assignment comes from the runtime state read before the write');
  assert.deepEqual(stopCommands(house({ 'light.bulb': 'off' }), catalog, parsed.targetViews(), runtimeState(view)), [], 'an off member is not told');
});

test('a room target and a lamp that ran no bulb effect are not told to stop', () => {
  const catalog = parseCatalog(catalogDocument);
  const view = house({ [runtime]: ['g0', { assignments: { 'light.lamp': {} } }], 'light.bulb': 'on' });
  assert.deepEqual(stopCommands(view, catalog, details({ targets: { 'light.lamp': steady } }).targetViews(), runtimeState(view)), []);
  const was = house({ [runtime]: ['g0', { assignments: { 'light.lamp': { effect: 'Breathe' } } }], 'light.bulb': 'on' });
  assert.deepEqual(stopCommands(was, catalog, details({ targets: { 'light.lamp': { ...steady, is_room: true } } }).targetViews(), runtimeState(was)), []);
});

test('the stops go to effects_emit as one inter-handler run, even when there are none', () => {
  assert.deepEqual([...planStops([], REVISION, 'g1')], [
    { kind: 'script', name: 'effects_emit', args: { commands: [], revision: REVISION, generation: 'g1' } },
  ]);
});

// effects_filter_commands

test('a command naming a group with an assigned member keeps only the unassigned members', () => {
  const catalog = parseCatalog(catalogDocument);
  const args = parseFilterArgs({ commands: [{ qos: 1, ids: ['light.group', 'light.solo'] }, { ids: ['light.lamp'] }] });
  assert.deepEqual(filterCommands(catalog, ['light.lamp'], args.commands), {
    commands: [{ qos: 1, ids: ['light.other', 'light.solo'] }],
  });
});
