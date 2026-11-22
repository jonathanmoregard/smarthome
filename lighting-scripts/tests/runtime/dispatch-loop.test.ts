import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue, ScriptContext } from '../../src/runtime/context.ts';
import { typed } from '../../src/runtime/entrypoints.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { timestamp } from '../../src/parse/accessors.ts';
import { parseDispatchArgs } from '../../src/parse/dispatch-render.ts';
import { dispatch } from '../../src/handlers/dispatch-render.ts';
import type { EmitOutcome } from '../../src/legacy/domain/transport.ts';
import { context, setCatalog } from './gestures-context.ts';

/**
 * `ls_dispatch` end to end, at its handler: the opening stops, the catalog,
 * the lamps to send, `effects_assign`, `effects_frame_plan`, `effects_emit`
 * (the light, then the bulb-effect starts), the guarded `applied` record, the
 * switches one by one, the lazy tail and the answer. One ordered log holds
 * every inter-handler call, service call and event, so the order is pinned as
 * well as the bytes. Stubs may change the house when they answer, which pins
 * which reads are made after which call.
 */

const NOW = '2026-10-26T12:00:00+01:00';
const LATER = '2026-10-26T12:00:05+01:00';
const REVISION = '2026-10-26T11:00:00+00:00';
const runtime = 'sensor.ls_effects_runtime';
const steady: JsonObject = { on: true, area: 'studio', brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
const effect = (name: string): JsonObject => ({ kind: 'effect', effect: name, intensity: 80 });
const candle: JsonObject = { on: true, area: 'studio', brightness: effect('Candle'), color: effect('Candle') };
const room: JsonObject = { is_room: true, on: true };

type Entry =
  | { call: string; args: JsonValue }
  | { service: string; data: JsonValue; target: JsonValue; guard: JsonValue }
  | { event: string; data: JsonValue };

/** What a stub does to the house as it answers. */
interface Hooks {
  catalog?: (ctx: ScriptContext) => void;
  assign?: (ctx: ScriptContext) => void;
  /** The nth emission (0, then 1), and what it answers. */
  emit?: (ctx: ScriptContext, nth: number) => EmitOutcome | void;
  service?: (ctx: ScriptContext, service: string, target: JsonValue) => void;
  event?: (ctx: ScriptContext) => void;
}

function plan(extra: JsonObject = {}, targets: JsonObject = { 'light.lamp': steady, 'room:studio': room }): JsonObject {
  return { revision: REVISION, plan_order: 10, base: {}, resolved: { targets, assignments: {} }, ...extra };
}

function attributes(ctx: ScriptContext, entity: string): JsonObject {
  const state = ctx.state[entity];
  if (state === undefined) throw new Error(`no ${entity}`);
  return state.attributes;
}
const setGeneration = (ctx: ScriptContext, generation: string) => { attributes(ctx, runtime).generation = generation; };
const moveRevision = (ctx: ScriptContext) => { ctx.state['sensor.ls_overrides'] = { state: '0', attributes: {}, last_updated: 'later' }; };

/** A house whose effect handlers log what they are handed and answer as a real one would. */
function house(hooks: Hooks = {}, runtimeAttributes: JsonObject = {}, states: Record<string, string> = {}) {
  const log: Entry[] = [];
  let emissions = 0;
  const ctx = context({
    effects_catalog: (c, args) => { log.push({ call: 'effects_catalog', args: structuredClone(args) }); hooks.catalog?.(c); return { the: 'catalog' }; },
    effects_assign: typed('effects_assign', { parse: args => args, run: (c, args) => {
      log.push({ call: 'effects_assign', args: structuredClone(args) });
      hooks.assign?.(c);
      const generation = attributes(c, runtime).generation;
      return { generation: carry(generation === undefined ? null : generation) };
    } }),
    effects_frame_plan: typed('effects_frame_plan', { parse: args => args, run: (_c, args) => {
      log.push({ call: 'effects_frame_plan', args: structuredClone(args) });
      const targets = args.targets;
      const owners = targets !== null && typeof targets === 'object' && !Array.isArray(targets) ? Object.keys(targets) : [];
      const commands = owners.map(owner => ({ topic: 'z2m/bulb/set', payload: carry({ brightness: 100 }), members: ['light.bulb'], owners: [owner], group: null }));
      return { commands, rejected: [], input_count: commands.length, endpoint_count: commands.length, command_count: commands.length };
    } }),
    effects_emit: typed('effects_emit', { parse: args => args, run: (c, args) => {
      log.push({ call: 'effects_emit', args: structuredClone(args) });
      const nth = emissions++;
      const answer = hooks.emit?.(c, nth);
      return answer === undefined ? { published_at: [nth + 1], completed: true } : answer;
    } }),
  });
  ctx.now = NOW;
  setCatalog(ctx, { effects: {}, members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'z2m/bulb/set' }, groups: {}, multicast: [] });
  ctx.state = {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: REVISION },
    [runtime]: { state: 'g1', attributes: { generation: 'g1', plan_order: 5, ...structuredClone(runtimeAttributes) } },
    'light.lamp': { state: 'on', attributes: {} }, 'light.bulb': { state: 'on', attributes: {} },
    ...Object.fromEntries(Object.entries(states).map(([entity, state]) => [entity, { state, attributes: {} }])),
  };
  ctx.emit = (service, data, target, guard) => {
    log.push({ service, data: structuredClone(data), target: target === undefined ? null : structuredClone(target), guard: guard === undefined ? null : structuredClone(guard) });
    hooks.service?.(ctx, service, target === undefined ? null : target);
  };
  ctx.fire = (event, data) => { log.push({ event, data: structuredClone(data) }); hooks.event?.(ctx); };
  return { ctx, log, run: (args: JsonObject) => dispatch(ctx, parseDispatchArgs(args)) };
}

const catalogCall: Entry = { call: 'effects_catalog', args: {} };
const assignCall = (invalidate: string[], targets: JsonObject = { 'light.lamp': steady, 'room:studio': room }): Entry =>
  ({ call: 'effects_assign', args: { targets, assignments: {}, revision: REVISION, invalidate, plan_order: 10 } });
const frameCall = (targets: JsonObject, at = NOW, cap: number | null = null, rooms: JsonValue = []): Entry =>
  ({ call: 'effects_frame_plan', args: { targets, catalog: { the: 'catalog' }, timestamp: timestamp(at), transition_cap: cap, transition_rooms: rooms } });
const lightCommand = (owner: string) => ({ topic: 'z2m/bulb/set', payload: { brightness: 100 }, members: ['light.bulb'], owners: [owner], group: null });
const emitCall = (commands: JsonValue[], generation = 'g1'): Entry => ({ call: 'effects_emit', args: { commands, revision: REVISION, generation } });
const startCall = (generation = 'g1'): Entry => emitCall([
  { topic: 'z2m/bulb/set', payload: { effect: 'channel_change' }, members: ['light.bulb'], owners: ['light.lamp'], group: null }], generation);
const appliedWrite = (applied: JsonObject, generation = 'g1'): Entry => ({ service: 'variable.update_sensor', target: { entity_id: runtime },
  data: { value: generation, replace_attributes: false, attributes: { applied } }, guard: { revision: REVISION, generation, requiresOutputSuccess: true } });
const switched = (state: 'on' | 'off', entity: string, generation = 'g1'): Entry =>
  ({ service: `homeassistant.turn_${state}`, data: {}, target: { entity_id: entity }, guard: { revision: REVISION, generation } });
const selected = (entity: string, option: string): Entry =>
  ({ service: 'input_select.select_option', data: { option }, target: { entity_id: entity }, guard: { revision: REVISION, generation: 'g1' } });
const sara = (state: 'on' | 'off'): Entry =>
  ({ service: `input_boolean.turn_${state}`, data: {}, target: { entity_id: 'input_boolean.ls_sara_mode_mirror' }, guard: { revision: REVISION, generation: 'g1' } });
const cleared = (keys: string[]): Entry => ({ event: 'ls_override', data: { op: 'clear', keys, via: 'rule_next_block', expected_revision: REVISION } });
/** The calls up to and including the light's emission, for the steady lamp. */
const throughLight: Entry[] = [catalogCall, assignCall(['light.lamp']), frameCall({ 'light.lamp': steady }), emitCall([lightCommand('light.lamp')])];

test('the whole run, in order: catalog, assign, frame, light, applied, switches, tail, answer', () => {
  // Break: any step reordered, skipped or sent with other bytes.
  const { log, run } = house({}, {}, { 'switch.a': 'off', 'switch.b': 'off' });
  const answer = run({ plan: plan({ switches: { 'switch.a': { on: true }, 'switch.b': { on: false } },
    mirror: [{ entity: 'input_select.x', option: 'Day' }], sara_mirror: 'on', stale_keys: ['k'] }) });
  assert.deepEqual(answer, { completed: true, published_at: [1] });
  assert.deepEqual(log, [...throughLight, appliedWrite({ 'light.lamp': steady }), switched('on', 'switch.a'),
    selected('input_select.x', 'Day'), sara('on'), cleared(['k'])]);
});

test('a plan for a moved revision is dropped before anything runs, its details unread', () => {
  // Break: the revision check moves after the details parse or after the catalog.
  const { log, run } = house();
  assert.equal(run({ plan: { revision: 'older', plan_order: 10 } }), null);
  assert.deepEqual(log, []);
});

test('a plan older than the last dispatched is dropped before anything runs, its details unread; an equal one is not', () => {
  // Break: the plan-order check uses <= or is skipped, or the details parse first.
  const older = house({}, { plan_order: 11 });
  assert.equal(older.run({ plan: { revision: REVISION, plan_order: 10 } }), null);
  assert.deepEqual(older.log, []);
  const equal = house({}, { plan_order: 10 });
  assert.deepEqual(equal.run({ plan: plan() }), { completed: true, published_at: [1] });
  assert.deepEqual(equal.log.slice(0, 1), [catalogCall]);
});

test('an accepted plan parses its details before the catalog, and raises on missing ones', () => {
  // Break: the details are read lazily after the catalog, or leniently.
  const { log, run } = house();
  assert.throws(() => run({ plan: { revision: REVISION, plan_order: 10 } }), /ls_dispatch\.plan\.resolved/);
  assert.deepEqual(log, []);
});

test('the lamps to send are read after the catalog: rooms never, an applied light not again, an off lamp not', () => {
  // Break: the lamps to send are chosen before the catalog call, or a room or an off lamp is sent.
  const applied = house({ catalog: ctx => { attributes(ctx, runtime).applied = { 'light.lamp': steady }; } });
  assert.deepEqual(applied.run({ plan: plan() }), { completed: true, published_at: [1] });
  assert.deepEqual(applied.log, [catalogCall, assignCall([]), frameCall({}), emitCall([])]);
  const off = house({ catalog: ctx => { ctx.state['light.lamp'] = { state: 'off', attributes: {} }; } });
  off.run({ plan: plan() });
  assert.deepEqual(off.log, [catalogCall, assignCall([]), frameCall({}), emitCall([])]);
});

test('the clock and generation are read after the assignment', () => {
  // Break: the frame timestamp is read before effects_assign, or the generation is not the assigned one.
  const { log, run } = house({ assign: ctx => { ctx.now = LATER; setGeneration(ctx, 'g2'); } });
  assert.deepEqual(run({ plan: plan() }), { completed: true, published_at: [1] });
  assert.deepEqual(log, [catalogCall, assignCall(['light.lamp']), frameCall({ 'light.lamp': steady }, LATER),
    emitCall([lightCommand('light.lamp')], 'g2'), appliedWrite({ 'light.lamp': steady }, 'g2')]);
});

test('a remote dispatch caps transitions everywhere; remote rooms cap them in those rooms', () => {
  // Break: the cap or the rooms it applies to change.
  const remote = house();
  remote.run({ plan: plan({ remote: true, remote_rooms: ['studio'] }) });
  assert.deepEqual(remote.log[2], frameCall({ 'light.lamp': steady }, NOW, 0.5, null));
  const rooms = house();
  rooms.run({ plan: plan({ remote_rooms: ['studio'] }) });
  assert.deepEqual(rooms.log[2], frameCall({ 'light.lamp': steady }, NOW, 0.5, ['studio']));
});

test('a candle lamp is started after its light, and both emissions are recorded and answered', () => {
  // Break: the start is skipped, sent before the light, or its publish times are dropped.
  const { log, run } = house();
  const targets = { 'light.lamp': candle };
  assert.deepEqual(run({ plan: plan({}, targets) }), { completed: true, published_at: [1, 2] });
  assert.deepEqual(log, [catalogCall, assignCall(['light.lamp'], targets), frameCall(targets), emitCall([lightCommand('light.lamp')]),
    startCall(), appliedWrite(targets)]);
});

test('the starts are read after the light went out: a bulb that went off then gets none', () => {
  // Break: the starts are chosen before the first emission.
  const { log, run } = house({ emit: (ctx, nth) => { if (nth === 0) ctx.state['light.bulb'] = { state: 'off', attributes: {} }; } });
  const targets = { 'light.lamp': candle };
  assert.deepEqual(run({ plan: plan({}, targets) }), { completed: true, published_at: [1] });
  assert.deepEqual(log, [catalogCall, assignCall(['light.lamp'], targets), frameCall(targets), emitCall([lightCommand('light.lamp')]),
    appliedWrite(targets)]);
});

test('the applied record merges what the runtime holds after the last emission', () => {
  // Break: the stored applied map is read before the emission.
  const { log, run } = house({ emit: ctx => { attributes(ctx, runtime).applied = { 'light.other': steady }; } });
  run({ plan: plan() });
  assert.deepEqual(log.at(-1), appliedWrite({ 'light.other': steady, 'light.lamp': steady }));
});

test('a generation moved by the light stops the run: no applied record, no switches parsed, no tail', () => {
  // Break: the still-current check after emission is dropped, or the switches are read before it.
  const { log, run } = house({ emit: ctx => { setGeneration(ctx, 'g2'); } }, {}, { 'switch.a': 'off' });
  assert.equal(run({ plan: plan({ switches: 5, mirror: [{ entity: 'input_select.x', option: 'Day' }], stale_keys: ['k'] }) }), null);
  assert.deepEqual(log, throughLight);
});

test('a generation moved by the start stops the run after the start', () => {
  // Break: the still-current check runs before the start emission.
  const { log, run } = house({ emit: (ctx, nth) => { if (nth === 1) setGeneration(ctx, 'g2'); } });
  const targets = { 'light.lamp': candle };
  assert.equal(run({ plan: plan({}, targets) }), null);
  assert.deepEqual(log.at(-1), startCall());
});

test('a revision moved by the light stops the run', () => {
  // Break: the still-current check reads only the generation.
  const { log, run } = house({ emit: ctx => { moveRevision(ctx); } });
  assert.equal(run({ plan: plan() }), null);
  assert.deepEqual(log, throughLight);
});

test('incomplete output records nothing applied, still switches and runs the tail, and answers incomplete', () => {
  // Break: an incomplete output writes `applied`, or stops the switches or the tail.
  const light = house({ emit: () => ({ published_at: [], completed: false }) }, {}, { 'switch.a': 'off' });
  assert.deepEqual(light.run({ plan: plan({ switches: { 'switch.a': { on: true } }, stale_keys: ['k'] }) }), { completed: false, published_at: [] });
  assert.deepEqual(light.log, [...throughLight, switched('on', 'switch.a'), cleared(['k'])]);
  const start = house({ emit: (_ctx, nth) => nth === 1 ? { published_at: [9], completed: false } : undefined });
  const targets = { 'light.lamp': candle };
  assert.deepEqual(start.run({ plan: plan({}, targets) }), { completed: false, published_at: [1, 9] });
  assert.deepEqual(start.log.at(-1), startCall());
});

test('nothing to send records nothing applied', () => {
  // Break: an empty send writes an empty applied record.
  const { log, run } = house({}, { applied: { 'light.lamp': steady } });
  run({ plan: plan() });
  assert.deepEqual(log, [catalogCall, assignCall([]), frameCall({}), emitCall([])]);
});

test('the switches are read only after the applied record, and a malformed set raises there', () => {
  // Break: the switches are parsed with the other details, or before the record.
  const { log, run } = house();
  assert.throws(() => run({ plan: plan({ switches: 5 }) }), /ls_dispatch\.plan\.switches/);
  assert.deepEqual(log, [...throughLight, appliedWrite({ 'light.lamp': steady })]);
});

test('each switch whose state differs is switched, the house re-read after each', () => {
  // Break: the states are read once up front, or a switch already right is switched.
  const { log, run } = house({ service: (ctx, service, target) => {
    if (service === 'homeassistant.turn_on' && JSON.stringify(target) === '{"entity_id":"switch.a"}') ctx.state['switch.b'] = { state: 'on', attributes: {} };
  } }, {}, { 'switch.a': 'off', 'switch.b': 'off', 'switch.c': 'on' });
  assert.deepEqual(run({ plan: plan({ switches: { 'switch.a': { on: true }, 'switch.b': { on: true }, 'switch.c': { on: false } } }) }),
    { completed: true, published_at: [1] });
  assert.deepEqual(log, [...throughLight, appliedWrite({ 'light.lamp': steady }), switched('on', 'switch.a'), switched('off', 'switch.c')]);
});

test('a revision moved by a switch stops the switching and drops the tail, after parsing the rest', () => {
  // Break: the loop stops parsing at the move, keeps switching, or still runs the tail.
  const moving: Hooks = { service: (ctx, service) => { if (service === 'homeassistant.turn_on') moveRevision(ctx); } };
  const { log, run } = house(moving, {}, { 'switch.a': 'off', 'switch.b': 'off' });
  assert.equal(run({ plan: plan({ switches: { 'switch.a': { on: true }, 'switch.b': { on: true } },
    mirror: [{ entity: 'input_select.x', option: 'Day' }], stale_keys: ['k'] }) }), null);
  assert.deepEqual(log, [...throughLight, appliedWrite({ 'light.lamp': steady }), switched('on', 'switch.a')]);
  const malformed = house(moving, {}, { 'switch.a': 'off', 'switch.b': 'off' });
  assert.throws(() => malformed.run({ plan: plan({ switches: { 'switch.a': { on: true }, 'switch.b': { on: true }, 'switch.c': 5 } }) }),
    /ls_dispatch\.plan\.switches\.switch\.c/);
  assert.deepEqual(malformed.log.at(-1), switched('on', 'switch.a'));
});

test('the tail parses each mirror where it is sent: a malformed one raises after the ones before it went out', () => {
  // Break: the mirrors are parsed up front, before any is sent.
  const { log, run } = house();
  assert.throws(() => run({ plan: plan({ mirror: [{ entity: 'input_select.x', option: 'Day' }, { entity: 5 }] }) }), /ls_dispatch\.plan\.mirror\[1\]/);
  assert.deepEqual(log.at(-1), selected('input_select.x', 'Day'));
});

test('the Sara mirror follows only on or off, and no stale keys send no clear', () => {
  // Break: another stored value flips the mirror, or an empty clear is sent.
  const off = house();
  off.run({ plan: plan({ sara_mirror: 'off', stale_keys: [] }) });
  assert.deepEqual(off.log.at(-1), sara('off'));
  const other = house();
  other.run({ plan: plan({ sara_mirror: 'x' }) });
  assert.deepEqual(other.log.at(-1), appliedWrite({ 'light.lamp': steady }));
});

test('the answer is complete only if the revision and generation still hold after the tail', () => {
  // Break: the final still-current check is dropped or made before the tail.
  const generation = house({ event: ctx => { setGeneration(ctx, 'g2'); } });
  assert.deepEqual(generation.run({ plan: plan({ stale_keys: ['k'] }) }), { completed: false, published_at: [1] });
  assert.deepEqual(generation.log.at(-1), cleared(['k']));
  const revision = house({ event: ctx => { moveRevision(ctx); } });
  assert.deepEqual(revision.run({ plan: plan({ stale_keys: ['k'] }) }), { completed: false, published_at: [1] });
});
