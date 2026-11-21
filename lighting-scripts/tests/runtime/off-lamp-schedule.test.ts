import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { planningHandlers } from '../../src/handlers/planning.ts';
import { resolutionHandlers } from '../../src/handlers/resolution.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { nativeHandlers } from '../../src/handlers/native-controls.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { resultCodecs } from '../../src/parse/results.ts';
import { context, setCatalog } from './gestures-context.ts';

/**
 * The schedule reads a light honestly (2026-11-20): on with a level (and a
 * colour when Home Assistant reports one), off with neither, or absent when the
 * entity is missing or unavailable. Nothing is invented: no 255, no 3000 K, no
 * white. Spelling: an off profile is `{on: false}`, a lit one keeps
 * `{brightness, color}`, an absent one is no key; an off target has `on: false`
 * and no `brightness`/`color`.
 */
const cosy = '2026-10-23T19:00:00+02:00';
const OFF = { brightness: null, color_mode: null, color_temp_kelvin: null, rgb_color: null };
function house() {
  const ctx = context({ ...handlers, ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...planningHandlers });
  ctx.now = cosy;
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k, rgb_color: [255, 180, 100] });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500, rgb_color: [255, 200, 150] });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  setCatalog(ctx, { effects: {}, processors: {} });
  return ctx;
}
type Base = { targets: Record<string, JsonObject>; schedule: { cmds: JsonObject[]; profiles: Record<string, JsonObject> } };
const base = (ctx: ReturnType<typeof house>) => ctx.run('ls_base', { test_now: cosy, overrides: {} }) as unknown as Base;
const roomBase = (ctx: ReturnType<typeof house>) => ctx.run('ls_room_base', { test_now: cosy, overrides: {}, room: 'studio' }) as unknown as Base;

test('an off lamp is observed as off, with no level or colour', () => {
  const ctx = house();
  ctx.put('light.studio', 'off', OFF);
  for (const run of [base, roomBase]) assert.deepEqual(run(ctx).targets['light.studio']!.observed, { on: false });
});

test('an unavailable lamp is not observed at all', () => {
  const ctx = house();
  ctx.put('light.studio', 'unavailable', {});
  for (const run of [base, roomBase]) assert.equal(Object.hasOwn(run(ctx).targets['light.studio']!, 'observed'), false);
});

test('a lamp whose scene is off is an off target: no level, no colour, an off command', () => {
  const ctx = house();
  ctx.put('light.ls_house_cosy', 'off', OFF);
  const result = base(ctx);
  const lamp = result.targets['light.studio']!;
  assert.equal(lamp.on, false);
  assert.equal(Object.hasOwn(lamp, 'brightness'), false);
  assert.equal(Object.hasOwn(lamp, 'color'), false);
  assert.deepEqual(lamp.cosy, { on: false });
  assert.deepEqual(lamp.day, { brightness: 240, color: { kelvin: 4500 } });
  assert.equal(Object.hasOwn(result.schedule.profiles['light.studio']!, 'brightness'), false);
  assert.deepEqual(result.schedule.cmds, [{ kind: 'off', transition: 3, ids: ['light.studio'] }]);
  const room = roomBase(ctx).targets['room:studio']!;
  assert.equal(room.on, false);
  assert.equal(Object.hasOwn(room, 'brightness'), false);
  assert.equal(Object.hasOwn(room, 'color'), false);
});

test('an unavailable day scene is no anchor rather than a white one', () => {
  const ctx = house();
  ctx.put('light.ls_house_day', 'unavailable', {});
  assert.equal(Object.hasOwn(base(ctx).targets['light.studio']!, 'day'), false);
  assert.equal(Object.hasOwn(roomBase(ctx).targets['room:studio']!, 'day'), false);
});

test('an on scene that reports no brightness has no honest level: it is absent', () => {
  const ctx = house();
  ctx.put('light.ls_house_day', 'on', { brightness: null, color_mode: 'onoff', color_temp_kelvin: null, rgb_color: null });
  assert.equal(Object.hasOwn(base(ctx).targets['light.studio']!, 'day'), false);
});

test('an on scene with no colour gives a lit target with no colour and a brightness-only command', () => {
  const ctx = house();
  ctx.put('light.ls_house_cosy', 'on', { brightness: 90, color_mode: 'brightness', color_temp_kelvin: null, rgb_color: null });
  const result = base(ctx);
  const lamp = result.targets['light.studio']!;
  assert.equal(lamp.on, true);
  assert.equal(lamp.brightness, 90);
  assert.equal(Object.hasOwn(lamp, 'color'), false);
  assert.deepEqual(lamp.cosy, { brightness: 90 });
  assert.deepEqual(result.schedule.cmds, [{ kind: 'brightness', brightness: 90, transition: 3, ids: ['light.studio'] }]);
});

test('the scheduled result decodes back to itself, off and colourless lamps included', () => {
  const ctx = house();
  ctx.put('light.ls_house_cosy', 'off', OFF);
  ctx.put('light.studio', 'off', OFF);
  for (const run of [base, roomBase]) {
    const result = run(ctx);
    const json = JSON.parse(JSON.stringify(result));
    assert.deepEqual(JSON.parse(JSON.stringify(resultCodecs.ls_base.decode!(json, 'ls_base'))), json);
  }
  const lit = house();
  lit.put('light.ls_house_cosy', 'on', { brightness: 90, color_mode: 'brightness', color_temp_kelvin: null, rgb_color: null });
  const json = JSON.parse(JSON.stringify(base(lit)));
  assert.deepEqual(JSON.parse(JSON.stringify(resultCodecs.ls_base.decode!(json, 'ls_base'))), json);
});

test('a cached room plan re-reads what the lamp shows: off is {on: false}, unavailable drops the reading', () => {
  const ctx = house();
  const first = ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote' }) as unknown as { cache_update: JsonObject };
  const replan = () => ctx.run('ls_room_plan', { room: 'studio', overrides: {}, reason: 'remote', cache: first.cache_update }) as unknown as
    { cache_hit: boolean; plan: { base: Record<string, JsonObject> } };
  ctx.put('light.studio', 'off', OFF);
  const off = replan();
  assert.equal(off.cache_hit, true);
  assert.deepEqual(off.plan.base['light.studio']!.observed, { on: false });
  ctx.put('light.studio', 'unavailable', {});
  const gone = replan();
  assert.equal(gone.cache_hit, true);
  assert.equal(Object.hasOwn(gone.plan.base['light.studio']!, 'observed'), false);
});

test('holding what an off lamp shows holds its schedule, not a made-up white 255', () => {
  const ctx = house();
  ctx.put('light.studio', 'off', OFF);
  const plan = ctx.run('ls_plan', { reason: 'config', test_now: cosy,
    test_overrides: { hold: { kind: 'light', target: 'light.studio', when: cosy, value: null } } }) as unknown as
    { plan: { resolved: { targets: Record<string, { brightness: JsonObject; color: JsonObject }> } } };
  const lamp = plan.plan.resolved.targets['light.studio']!;
  assert.equal(lamp.brightness.value, 90);
  assert.deepEqual(lamp.color.value, { kelvin: 2500 });
});
