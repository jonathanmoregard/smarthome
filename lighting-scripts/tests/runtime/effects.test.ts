import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';
import { perform, run } from '../../src/runtime/effects.ts';
import type { Effect, Plan } from '../../src/runtime/effects.ts';

test('perform lands each effect kind on the context method that owns it', () => {
  const seen: unknown[] = [];
  const ctx = context({ child: (_ctx, args) => { seen.push(args); return 'ignored'; } });
  const guard = { revision: 'r1', generation: 3 };
  perform(ctx, { kind: 'service', service: 'light.turn_on', data: { brightness: 9 }, target: { entity_id: 'light.a' }, guard });
  perform(ctx, { kind: 'service', service: 'mqtt.publish', data: { topic: 't' } });
  perform(ctx, { kind: 'event', event: 'ls_override', data: { op: 'clear_all' } });
  perform(ctx, { kind: 'state', entity: 'timer.chord', state: 'active' });
  perform(ctx, { kind: 'schedule', script: 'later', args: { a: 1 }, delayMs: 600 });
  perform(ctx, { kind: 'script', name: 'child', args: { b: 2 } });
  // The fake context records the guard nowhere, so assert the argument it was given.
  assert.deepEqual(ctx.calls, [
    { service: 'light.turn_on', data: { brightness: 9 }, target: { entity_id: 'light.a' } },
    { service: 'mqtt.publish', data: { topic: 't' } },
  ]);
  assert.deepEqual(ctx.events, [{ event: 'ls_override', data: { op: 'clear_all' } }]);
  assert.equal(ctx.get('timer.chord'), 'active');
  assert.deepEqual(ctx.scheduled, [{ script: 'later', args: { a: 1 }, due: Date.parse(ctx.now) + 600 }]);
  assert.deepEqual(seen, [{ b: 2 }]);
});

test('perform hands a service guard to emit unchanged', () => {
  const ctx = context();
  const received: unknown[] = [];
  ctx.emit = (service, data, target, guard) => { received.push([service, data, target, guard]); };
  const guard = { revision: 'r1', generation: null, owners: ['x'] };
  perform(ctx, { kind: 'service', service: 's', data: {}, guard });
  assert.deepEqual(received, [['s', {}, undefined, guard]]);
});

test('run performs a plan in yield order and answers its return value', () => {
  const ctx = context();
  function* plan(): Plan<number> {
    yield { kind: 'event', event: 'first', data: {} };
    yield { kind: 'event', event: 'second', data: {} };
    return 7;
  }
  assert.equal(run(ctx, plan()), 7);
  assert.deepEqual(ctx.events.map(e => e.event), ['first', 'second']);
});

test('run is lazy: a raise after a yield happens after that effect is performed', () => {
  const ctx = context();
  function* plan(): Plan<null> {
    yield { kind: 'event', event: 'before', data: {} };
    throw new Error('late raise');
  }
  assert.throws(() => run(ctx, plan()), /late raise/);
  assert.deepEqual(ctx.events.map(e => e.event), ['before']);
});

test('a plan is inspectable without a context', () => {
  function* plan(): Plan<string> {
    yield { kind: 'state', entity: 'e', state: 's' };
    return 'done';
  }
  const effects: Effect[] = [...plan()];
  assert.deepEqual(effects, [{ kind: 'state', entity: 'e', state: 's' }]);
});
