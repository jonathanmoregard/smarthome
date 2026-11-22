import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { context } from './gestures-context.ts';

/**
 * `ls_remote_command` end to end: plan, commit against the plan's revision,
 * plan again while the commit is refused, up to a thousand times; a dry run
 * answers the plan; an accepted power plan switches its targets and, when on,
 * renders them as a lamp-on apply. One ordered log holds every inter-handler
 * call and every service call, so the order is pinned as well as the calls.
 */

type Entry = { plan: JsonObject } | { commit: JsonValue } | { service: string; target: JsonValue } | { apply: JsonObject };

const envelope = (revision: string) => ({ input_revision: revision, received_at: 1, request_id: 'remote:1' });
const reset = (revision: string) => ({ op: 'clear_room', area: 'studio', via: 'remote', ...envelope(revision) });
const power = (on: boolean) => ({ op: 'power', area: 'studio', on, targets: ['light.a', 'switch.b'], via: 'remote', ...envelope('r1') });
const noop = { op: 'noop', ...envelope('r1') };
const request = { source: 'remote', area: 'studio', command: 'toggle' };
const planned: Entry = { plan: request };
const committed = (plan: JsonObject): Entry => ({ commit: { ...plan, expected_revision: plan.input_revision, area: 'studio', via: 'remote', source: 'remote' } });

/** A house whose planner answers `plans` in turn (the last one repeats) and whose store answers `verdicts` in turn. */
function house(plans: JsonObject[], verdicts: boolean[]) {
  const log: Entry[] = [];
  let planIndex = 0, commitIndex = 0;
  const ctx = context({
    ...controllerHandlers,
    ls_remote_plan: (_ctx, args) => {
      log.push({ plan: structuredClone(args) });
      const plan = plans[Math.min(planIndex++, plans.length - 1)];
      if (plan === undefined) throw new Error('no plan to answer');
      return plan;
    },
    ls_commit: (_ctx, args) => {
      log.push({ commit: args.data === undefined ? null : structuredClone(args.data) });
      const accepted = verdicts[Math.min(commitIndex++, verdicts.length - 1)];
      if (accepted === undefined) throw new Error('no verdict to answer');
      return { accepted, revision: 'r', committed_at: 0 };
    },
    ls_apply: (_ctx, args) => { log.push({ apply: structuredClone(args) }); return null; },
  });
  ctx.emit = (service, _data, target) => { log.push({ service, target: target === undefined ? null : structuredClone(target) }); };
  return { ctx, log };
}

test('a plan the store accepts is committed once against its own revision, and answers nothing', () => {
  // Break: the commit names another revision, is sent twice, or the command answers the plan.
  const { ctx, log } = house([reset('r1')], [true]);
  assert.equal(ctx.run('ls_remote_command', request), null);
  assert.deepEqual(log, [planned, committed(reset('r1'))]);
});

test('a refused commit plans again and commits the new plan against the new revision', () => {
  // Break: a refusal stops the command, or the retry re-sends the first plan's revision.
  const { ctx, log } = house([reset('r1'), reset('r2')], [false, true]);
  assert.equal(ctx.run('ls_remote_command', request), null);
  assert.deepEqual(log, [planned, committed(reset('r1')), planned, committed(reset('r2'))]);
});

test('a thousand refusals exhaust the budget: a thousand plans, a thousand commits, then it raises', () => {
  // Break: the budget is off by one, or exhaustion answers instead of raising.
  const { ctx, log } = house([reset('r1')], [false]);
  assert.throws(() => ctx.run('ls_remote_command', request), /^Error: Override revision kept changing; retry budget exhausted$/);
  assert.equal(log.length, 2_000);
  assert.deepEqual(log.filter(entry => 'plan' in entry).length, 1_000);
  assert.deepEqual(log.filter(entry => 'commit' in entry).length, 1_000);
  assert.deepEqual(log.slice(-2), [planned, committed(reset('r1'))]);
});

test('a refusal on the last attempt but one still gets its last attempt', () => {
  // Break: the budget counts commits from one, so the thousandth plan is never made.
  const { ctx, log } = house([reset('r1')], [...Array.from({ length: 999 }, () => false), true]);
  assert.equal(ctx.run('ls_remote_command', request), null);
  assert.equal(log.length, 2_000);
});

test('a dry run answers the first plan and commits nothing, whatever the plan is', () => {
  // Break: a dry run commits, switches, or answers something other than the plan.
  for (const plan of [power(true), reset('r1'), noop]) {
    const { ctx, log } = house([plan], [true]);
    assert.deepEqual(ctx.run('ls_remote_command', { ...request, dry_run: true }), plan);
    assert.deepEqual(log, [planned]);
  }
});

test('a noop plan is not committed and does nothing more', () => {
  // Break: the noop is committed, or retried.
  const { ctx, log } = house([noop], [false]);
  assert.equal(ctx.run('ls_remote_command', request), null);
  assert.deepEqual(log, [planned]);
});

test('an accepted power-on switches the targets on, then applies them as a lamp-on render', () => {
  // Break: the apply is sent first, or is missing, or the switch names other targets.
  const { ctx, log } = house([power(true)], [true]);
  assert.equal(ctx.run('ls_remote_command', request), null);
  assert.deepEqual(log, [planned, committed(power(true)),
    { service: 'homeassistant.turn_on', target: { entity_id: ['light.a', 'switch.b'] } },
    { apply: { reason: 'lamp_on', lights: ['light.a', 'switch.b'] } }]);
});

test('an accepted power-off switches the targets off and applies nothing', () => {
  // Break: a power-off is followed by a lamp-on apply.
  const { ctx, log } = house([power(false)], [true]);
  assert.equal(ctx.run('ls_remote_command', request), null);
  assert.deepEqual(log, [planned, committed(power(false)),
    { service: 'homeassistant.turn_off', target: { entity_id: ['light.a', 'switch.b'] } }]);
});

test('a refused power plan switches nothing until a commit is accepted', () => {
  // Break: the switch follows the plan rather than the accepted commit.
  const { ctx, log } = house([power(true)], [false, true]);
  ctx.run('ls_remote_command', request);
  assert.deepEqual(log.map(entry => Object.keys(entry)[0]), ['plan', 'commit', 'plan', 'commit', 'service', 'apply']);
});
