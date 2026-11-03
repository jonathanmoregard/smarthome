/**
 * The typed entrypoint seam: one implementation, two views.
 *
 * `ctx.call(name, args)` hands the caller the handler's own result, while the
 * name-keyed shim still serves JSON to Home Assistant and the parity harness.
 * The parts that must not move are the observable ones -- the `scriptRuns`
 * entry, the argument bytes and the serialised result -- so each has its own
 * assertion here rather than being left to the parity gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { execute } from '../../src/runtime/engine.ts';
import type { JsonObject, ScriptContext, Snapshot } from '../../src/runtime/context.ts';
import { controllerHandlers } from '../../src/domain/controller.ts';
import { context } from './gestures-context.ts';

const snapshot: Snapshot = {
  state: {}, areas: { 'light.studio': 'studio' }, members: ['light.studio'],
  now: '2026-10-26T12:00:00+01:00',
};

const args: JsonObject = {
  targets: { 'room:studio': { on: true, level: 128 } },
  ranges: { 'switch.studio': { profile: 'cosy' } },
  defaults: { cosy: [30, 60] },
};

function studioContext(): ScriptContext {
  const ctx = context(controllerHandlers);
  ctx.areas['switch.studio'] = 'studio';
  return ctx;
}

test('the name-keyed shim still serves the same JSON to the edges', () => {
  const edge = execute({ script: 'ls_switch_plan', args, snapshot: { ...snapshot, areas: { 'switch.studio': 'studio' } } }, controllerHandlers);
  assert.deepEqual(edge.result, {
    switches: { 'switch.studio': { on: true, room: 'studio', brightness: 128 * 100 / 255, range: [30, 60] } },
  });
  assert.deepEqual(edge.scriptRuns, ['ls_switch_plan'], 'the call stays observable by name');
});

test('the typed call hands back what the planner built, not a JSON copy', () => {
  const planned = studioContext().call('ls_switch_plan', args);
  const decision = planned.switches['switch.studio'];
  assert.ok(decision !== undefined, 'the studio switch is planned');
  // Reads that need no accessor are the point of the seam: `on` is a boolean
  // and `range` a pair of numbers in the type, so neither needs re-dissolving.
  assert.equal(decision.on, true);
  assert.deepEqual(decision.range, [30, 60]);
  assert.equal(decision.room, 'studio');
});

test('a name-keyed stub is decoded, so existing stubs keep standing in', () => {
  const stubbed = context({ ls_switch_plan: () => ({ switches: { 'switch.hall': { on: false, room: 'hall', brightness: 0, range: [0, 100] } } }) });
  const planned = stubbed.call('ls_switch_plan', {});
  assert.equal(planned.switches['switch.hall']?.on, false);
  assert.equal(planned.switches['switch.hall']?.brightness, 0, 'a brightness of zero survives decoding');
});

test('a stub that has drifted from the result shape is rejected, not read leniently', () => {
  for (const [label, result] of [
    ['no switches key', {}],
    ['switches is not a mapping', { switches: [] }],
    ['a decision missing its range', { switches: { 'switch.hall': { on: true, room: 'hall', brightness: 1 } } }],
    ['a decision with a non-boolean on', { switches: { 'switch.hall': { on: 'yes', room: 'hall', brightness: 1, range: [0, 100] } } }],
  ] as const) {
    const stubbed = context({ ls_switch_plan: () => result as never });
    assert.throws(() => stubbed.call('ls_switch_plan', {}), /ls_switch_plan/, label);
  }
});
