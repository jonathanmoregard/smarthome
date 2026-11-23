import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';
import { blend } from '../../src/legacy/domain/scale.ts';
import { resolveEffects } from '../../src/legacy/domain/resolution.ts';
import { parseResolveArgs } from '../../src/parse/resolution.ts';
import { planGradients } from '../../src/legacy/domain/gradient.ts';
import { parseGradientPlanArgs } from '../../src/parse/gradient.ts';
import { switchPlan } from '../../src/legacy/domain/controller.ts';
import { parseSwitchPlanArgs } from '../../src/parse/controller.ts';

/**
 * Off is a state that cannot carry a colour (2026-11-20). When one end of the
 * cosy <-> day blend has the lamp off, the blend takes its colour from the lit
 * end only, ramps brightness from 1 at the off end up to the lit end's level,
 * and is off AT the off end and past it. Both ends off: the lamp is skipped.
 * An off anchor is spelled `{on: false}`; a lit one keeps `{brightness, color}`.
 */

const DAY = { on: true as const, brightness: 200, color: { kelvin: 4000 } };
const COSY = { on: true as const, brightness: 80, color: { kelvin: 2200 } };
const OFF = { on: false as const };

test('cosy off, day lit: off at the cosy end and past it, ramping up from 1 in the day colour', () => {
  assert.deepEqual(blend(DAY, OFF, 0), { on: false, position: 0 });
  assert.deepEqual(blend(DAY, OFF, -0.5), { on: false, position: -0.5 });
  assert.deepEqual(blend(DAY, OFF, 0.125), { on: true, brightness: 25.875, color: { kelvin: 4000 }, position: 0.125 });
  assert.deepEqual(blend(DAY, OFF, 0.5), { on: true, brightness: 100.5, color: { kelvin: 4000 }, position: 0.5 });
  assert.deepEqual(blend(DAY, OFF, 1), { on: true, brightness: 200, color: { kelvin: 4000 }, position: 1 });
  // Past the lit end the existing above-day rule applies unchanged.
  assert.deepEqual(blend(DAY, OFF, 1.5), { on: true, brightness: 227.5, color: { kelvin: 5250 }, position: 1.5 });
});

test('cosy lit, day off: the mirror image -- off at the day end and past it', () => {
  assert.deepEqual(blend(OFF, COSY, 1), { on: false, position: 1 });
  assert.deepEqual(blend(OFF, COSY, 1.5), { on: false, position: 1.5 });
  assert.deepEqual(blend(OFF, COSY, 0.875), { on: true, brightness: 10.875, color: { kelvin: 2200 }, position: 0.875 });
  assert.deepEqual(blend(OFF, COSY, 0.5), { on: true, brightness: 40.5, color: { kelvin: 2200 }, position: 0.5 });
  assert.deepEqual(blend(OFF, COSY, 0), { on: true, brightness: 80, color: { kelvin: 2200 }, position: 0 });
  // Below the lit cosy end the existing below-cosy rule applies, the off day end reading as level 1.
  assert.deepEqual(blend(OFF, COSY, -0.5), { on: true, brightness: 79.125, color: { kelvin: 2075 }, position: -0.5 });
});

test('both ends off: nothing to blend', () => {
  assert.equal(blend(OFF, OFF, 0.5), undefined);
});

test('two lit ends blend exactly as the scale always has', () => {
  assert.deepEqual(blend(DAY, COSY, 0.5), { on: true, brightness: 140, color: { kelvin: 3100 }, position: 0.5 });
});

const resolve = (args: JsonObject) => resolveEffects(parseResolveArgs(args), new Set());
const scaleClaim = (position: number): JsonObject => ({ kind: 'channels', scope: 'lamp', target: 'lamp', when: '2026-10-26T12:00:00+01:00',
  value: { channels: { brightness: { kind: 'scale', position, updated: 1 }, color: { kind: 'scale', position, updated: 1 } } } });
const offInCosy: JsonObject = { area: 'living', period: 'cosy', on: false, day: { brightness: 200, color: { kelvin: 4000 } }, cosy: { on: false } };

test('an off target resolves with no level and no colour: its channels hold nothing', () => {
  const lamp = resolve({ base: { lamp: offInCosy } }).targets.lamp!;
  assert.deepEqual(lamp.brightness, { kind: 'none', updated: -1 });
  assert.deepEqual(lamp.color, { kind: 'none', updated: -1 });
  assert.equal(lamp.on, false);
  assert.equal(Object.hasOwn(lamp, 'level'), false);
});

test('a scale towards a lit day lights an off-in-cosy lamp, dim and in the day colour; at the cosy end it stays off', () => {
  const lit = resolve({ base: { lamp: offInCosy }, overrides: { s: scaleClaim(0.5) } }).targets.lamp!;
  assert.equal(lit.on, true);
  assert.deepEqual(lit.brightness, { kind: 'constant', value: 100.5, updated: 1, origin: 'scale', position: 0.5 });
  assert.deepEqual(lit.color, { kind: 'constant', value: { kelvin: 4000 }, updated: 1, origin: 'scale', position: 0.5 });
  assert.equal(lit.level, 100.5);
  const off = resolve({ base: { lamp: offInCosy }, overrides: { s: scaleClaim(0) } }).targets.lamp!;
  assert.equal(off.on, false);
  assert.deepEqual(off.brightness, { kind: 'none', updated: 1, origin: 'scale', position: 0 });
  assert.deepEqual(off.color, { kind: 'none', updated: 1, origin: 'scale', position: 0 });
  assert.equal(Object.hasOwn(off, 'level'), false);
});

test('a scale to the off end switches a lit lamp off', () => {
  const litInCosy = { area: 'living', period: 'cosy', on: true, brightness: 80, color: { kelvin: 2200 }, day: { on: false },
    cosy: { brightness: 80, color: { kelvin: 2200 } } };
  const result = resolve({ base: { lamp: litInCosy }, overrides: { s: scaleClaim(1) } }).targets.lamp!;
  assert.equal(result.on, false);
  assert.deepEqual(result.brightness, { kind: 'none', updated: 1, origin: 'scale', position: 1 });
});

test('both ends off: a scale claim skips the lamp, which keeps its schedule', () => {
  const bothOff = { ...offInCosy, day: { on: false } };
  const lamp = resolve({ base: { lamp: bothOff }, overrides: { s: scaleClaim(0.5) } }).targets.lamp!;
  assert.deepEqual(lamp.brightness, { kind: 'none', updated: -1 });
  assert.deepEqual(lamp.owners, { brightness: 'base', color: 'base' });
  assert.equal(lamp.on, false);
});

test('a lit anchor that reports no colour gives no blend, like a missing anchor', () => {
  const lamp = { area: 'living', period: 'cosy', on: true, brightness: 80, color: { kelvin: 2200 }, day: { brightness: 200 },
    cosy: { brightness: 80, color: { kelvin: 2200 } } };
  const result = resolve({ base: { lamp }, overrides: { s: scaleClaim(0.5) } }).targets.lamp!;
  assert.equal(result.brightness.kind === 'constant' && result.brightness.origin, 'invalid_source');
});

const remote = (steps: number): JsonObject => ({ remote: { kind: 'input', scope: 'room', target: 'living', when: '2026-10-26T12:00:00+01:00',
  value: { adjustment: { steps, lower: -20, upper: 20, last: 'up', anchor: 'current', updated: 1 } } } });

test('the remote seeds a lit cosy lamp at cosy when day is off: brighter walks towards the off day end', () => {
  const litInCosy = { area: 'living', period: 'cosy', on: true, brightness: 80, color: { kelvin: 2200 }, day: { on: false },
    cosy: { brightness: 80, color: { kelvin: 2200 } } };
  const half = resolve({ base: { lamp: litInCosy }, overrides: remote(5) }).targets.lamp!;
  assert.deepEqual(half.brightness, { kind: 'constant', value: 40.5, updated: 1, origin: 'scale', position: 0.5 });
  assert.equal(half.on, true);
  const end = resolve({ base: { lamp: litInCosy }, overrides: remote(10) }).targets.lamp!;
  assert.equal(end.on, false);
});

test('the remote seeds an off lamp at its off end: brighter lights it from 1 towards day', () => {
  const lamp = resolve({ base: { lamp: offInCosy }, overrides: remote(5) }).targets.lamp!;
  assert.deepEqual(lamp.brightness, { kind: 'constant', value: 100.5, updated: 1, origin: 'scale', position: 0.5 });
  assert.equal(lamp.on, true);
});

test('the gradient planner compiles no curve for a target with an off end', () => {
  const plan = planGradients(parseGradientPlanArgs({ base: {
    lamp: { day: { brightness: 200, color: { kelvin: 4000 } }, cosy: { on: false } },
    lit: { day: { brightness: 200, color: { kelvin: 4000 } }, cosy: { brightness: 80, color: { kelvin: 2200 } } },
  } }));
  assert.deepEqual(Object.keys(plan), ['lit']);
});

test('a switch in an off room is off and reports no brightness', () => {
  const switches = switchPlan({ 'switch.plug': 'studio' }, parseSwitchPlanArgs({
    targets: { 'room:studio': { on: false } }, ranges: { 'switch.plug': { profile: 'custom', min: 0, max: 100 } }, defaults: {},
  }));
  assert.deepEqual(switches, { 'switch.plug': { on: false, room: 'studio', range: [0, 100] } });
});

const nativeSnapshot: Snapshot = { now: '2026-10-26T12:00:00+01:00', state: {}, areas: { 'light.logical': 'living', 'light.bulb': 'living' },
  members: [] };
const nativeCatalog = { groups: {}, members: { 'light.logical': ['light.bulb'] }, effects: {} };
const offCurrent = { plan: { base: { 'light.logical': { on: false } },
  resolved: { targets: { 'light.logical': { on: false, brightness: { kind: 'none', updated: -1 }, color: { kind: 'none', updated: -1 } } } } } };
const native = (sd: JsonObject) => execute({ script: 'effects_native_plan', snapshot: nativeSnapshot,
  args: { sd: { entity_id: 'light.bulb', ...sd }, catalog: nativeCatalog, current: offCurrent, stamp: 5 } }, handlers).result as JsonObject;

test('a brightness step on an off lamp starts from 0, as Home Assistant steps an off light', () => {
  const records = native({ brightness_step: 30 }).records as JsonObject[];
  assert.deepEqual((records[0]!.value as JsonObject).channels, { brightness: { kind: 'constant', value: 30, updated: 5 } });
});

test('resetting an off lamp to normal light claims both channels with no value, dropping them to the schedule', () => {
  const records = native({ effect: 'none' }).records as JsonObject[];
  assert.deepEqual(JSON.parse(JSON.stringify((records[0]!.value as JsonObject).channels)),
    { brightness: { kind: 'constant', updated: 5 }, color: { kind: 'constant', updated: 5 } });
});
