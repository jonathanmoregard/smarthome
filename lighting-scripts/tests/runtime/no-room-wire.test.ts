import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { remoteInputHandlers } from '../../src/handlers/remote-input.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { uiHandlers } from '../../src/handlers/ui-state.ts';
import { context } from './gestures-context.ts';
import { typed } from '../../src/runtime/entrypoints.ts';
import { recordTimestamp } from '../../src/parse/resolution.ts';

/**
 * A request that names no room (or no switch) is "no room" inside the port,
 * but the scripts spell it `''` on the wire: in the arguments one script
 * passes another, in the entity names it builds and in the answer it gives.
 * These pin those bytes, so the representation inside can change without
 * moving any of them.
 */

const NOW = '2026-10-26T12:00:00+01:00';

test('ls_plan with no room asks ls_base for room_only "" ', () => {
  const seen: JsonObject[] = [];
  const ctx = context({
    ...controllerHandlers,
    ls_base: typed('ls_base', { parse: args => args, run: (_ctx, args) => {
      seen.push(structuredClone(args));
      return { targets: {}, schedule: { cmds: [], profiles: {}, revision: 'r', stale_keys: [], sched: {}, schedule_details: {}, mirror: [],
        sara_mirror: null } };
    } }),
    effects_catalog: () => ({}),
    effects_gradient_plan: typed('effects_gradient_plan', { parse: args => args, run: () => ({ gradients: {} }) }),
    effects_resolve: typed('effects_resolve', { parse: args => args, run: () => ({ targets: {}, assignments: {} }) }),
    ls_switch_plan: typed('ls_switch_plan', { parse: args => args, run: () => ({ switches: {} }) }),
  });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.run('ls_plan', {});
  ctx.run('ls_plan', { room: 'studio' });
  assert.deepEqual(seen.map(args => args.room_only), ['', 'studio']);
});

function scheduled() {
  const ctx = context(scheduleHandlers);
  ctx.members = ['light.studio', 'light.hall'];
  ctx.areas = { 'light.studio': 'studio', 'light.hall': 'hall' };
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k, rgb_color: [255, 255, 255] });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  for (const lamp of ['light.studio', 'light.hall']) ctx.put(lamp, 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  return ctx;
}
const targetsOf = (result: JsonValue): string[] => {
  assert.ok(typeof result === 'object' && result !== null && !Array.isArray(result) && typeof result.targets === 'object'
    && result.targets !== null);
  return Object.keys(result.targets).sort();
};

test('ls_base reads room_only "" as no room, exactly as an absent one', () => {
  const ctx = scheduled();
  const at = { test_now: '2026-10-23T12:00:00+02:00', overrides: {} };
  assert.deepEqual(ctx.run('ls_base', { ...at, room_only: '' }), ctx.run('ls_base', at));
  assert.deepEqual(targetsOf(ctx.run('ls_base', { ...at, room_only: '' })), ['light.hall', 'light.studio', 'room:hall', 'room:studio']);
  assert.deepEqual(targetsOf(ctx.run('ls_base', { ...at, room_only: 'studio' })), ['room:studio']);
});

test('ls_room_base given room "" plans every room', () => {
  const ctx = scheduled();
  const at = { test_now: '2026-10-23T12:00:00+02:00', overrides: {} };
  assert.deepEqual(targetsOf(ctx.run('ls_room_base', { ...at, room: '' })), ['light.hall', 'light.studio', 'room:hall', 'room:studio']);
  assert.deepEqual(targetsOf(ctx.run('ls_room_base', { ...at, room: 'studio' })), ['light.studio', 'room:studio']);
});

function remote(overrides: JsonObject) {
  const seen: JsonObject[] = [];
  const ctx = context({ ...remoteInputHandlers, ls_room_plan: (_ctx, args) => { seen.push(structuredClone(args)); return {}; } });
  ctx.now = NOW;
  ctx.areas = { 'light.studio': 'studio' };
  ctx.put('sensor.ls_overrides', '0', { overrides });
  ctx.put('input_boolean.ls_ovr_next_block_on', 'on');
  ctx.put('sensor.ls_cache_', '0', { cache: { marker: 'empty room cache' } });
  return { ctx, seen };
}

test('a remote in no room asks ls_room_plan about room "" with the "" room cache, and answers noop', () => {
  const { ctx, seen } = remote({});
  const answer = ctx.run('ls_remote_plan', { source: 'remote', area: 'attic', command: 'up' });
  assert.ok(typeof answer === 'object' && answer !== null && !Array.isArray(answer));
  assert.equal(answer.op, 'noop');
  assert.deepEqual(seen, [{ room: '', overrides: {}, cache: { marker: 'empty room cache' }, reason: 'remote' }]);
});

test('a remote in no room reads the newest remote record saved for target ""', () => {
  // The scripts' empty room matches a record whose target is the empty text: its
  // valid-until is still ahead, so no room plan is needed.
  const record = { kind: 'input', scope: 'room', target: '', when: '2026-10-26T10:00:00+00:00',
    value: { remote_valid_until: 9_999_999_999, remote_timing_revision: recordTimestamp(NOW) } };
  const { ctx, seen } = remote({ 'channels:remote': record });
  ctx.run('ls_remote_plan', { source: 'remote', area: 'attic', command: 'up' });
  assert.deepEqual(seen, []);
  // The same record saved for a real room does not apply to the remote in no room.
  const elsewhere = remote({ 'channels:remote': { ...record, target: 'studio' } });
  elsewhere.ctx.run('ls_remote_plan', { source: 'remote', area: 'attic', command: 'up' });
  assert.equal(elsewhere.seen.length, 1);
});

test('a range save naming no switch answers entity "" and reads the range saved under ""', () => {
  const ctx = context(uiHandlers);
  ctx.put('sensor.ls_overrides', '0', { switch_ranges: {} });
  assert.deepEqual(ctx.run('ls_range_save', { profile: 'custom', dry_run: true }), {
    valid: false, entity: '', config: { profile: 'custom' },
    errors: ['Choose a physical on/off lamp or smart plug.', 'Enter both ends of Own Range: 0–100%, with From no higher than Through.'],
  });
  ctx.put('sensor.ls_overrides', '0', { switch_ranges: { '': { min: 10, max: 60 } } });
  assert.deepEqual(ctx.run('ls_range_save', { profile: 'custom', dry_run: true }), {
    valid: false, entity: '', config: { profile: 'custom', min: 10, max: 60 }, errors: ['Choose a physical on/off lamp or smart plug.'],
  });
});
