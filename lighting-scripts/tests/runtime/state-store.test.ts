import assert from 'node:assert/strict';
import test from 'node:test';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { context } from './gestures-context.ts';

test('ls_commit power uses the captured Home Assistant bool filter trimming', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', {});
  ctx.run('ls_commit', { data: { op: 'power', area: 'studio', on: ' enable ' } });
  assert.equal(ctx.calls[0]?.data.attributes.power.studio, true);
});

test('ls_commit power rejects values rejected by the captured Home Assistant bool filter', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', {});
  assert.throws(
    () => ctx.run('ls_commit', { data: { op: 'power', area: 'studio', on: 'hot' } }),
    /ls_commit\.data\.on/,
  );
});

test('ls_store profile booleans use the captured Home Assistant bool filter', () => {
  const ctx = context({ ...stateStoreHandlers, effects_catalog: () => ({ effects: {} }) });
  ctx.put('input_text.profile', '{}');
  assert.throws(() => ctx.run('ls_store', { store: 'input_text.profile', own: 'hot' }), /ls_store\.own/);
});

test('ls_commit rejects unhashable record keys on the shared affected-room lookup', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', {});
  assert.throws(
    () => ctx.run('ls_commit', { data: { op: 'clear_all', records: [{ key: [] }] } }),
    /ls_commit\.data\.records\[0\]\.key.*unhashable/,
  );
});

test('ls_override_block rejects unhashable schedule keys', () => {
  const ctx = context({
    ...stateStoreHandlers,
    ls_apply: () => ({ plan: { sched: {} } }),
  });
  assert.throws(
    () => ctx.run('ls_override_block', { scope: [], block: 'night' }),
    /ls_override_block\.scope.*unhashable/,
  );
});

test('ls_override_block raises an unhashable scope only after the ls_apply dry run', () => {
  // The dry-run call is observable (scriptRuns, the parity trace), so the scope
  // parse must not move the raise ahead of it.
  const runs: unknown[] = [];
  const ctx = context({ ...stateStoreHandlers, ls_apply: (_c, args) => { runs.push(args); return { plan: { sched: {} } }; } });
  assert.throws(() => ctx.run('ls_override_block', { scope: { a: 1 }, block: 'night' }), /ls_override_block\.scope.*unhashable/);
  assert.deepEqual(runs, [{ dry_run: true }]);
  assert.deepEqual(ctx.events, []);
});

test('ls_override_block compares only string schedule values and carries scope and via raw', () => {
  const sched = { studio: 5, hall: 'night', '7': 'night' };
  const ctx = context({ ...stateStoreHandlers, ls_apply: () => ({ plan: { sched } }) });
  ctx.run('ls_override_block', { scope: 'studio', block: 'NIGHT', via: 0 });
  ctx.run('ls_override_block', { scope: 'hall', block: 'Night', via: { by: 'x' } });
  ctx.run('ls_override_block', { scope: 7, block: 'night' });
  ctx.run('ls_override_block', { block: 'night', via: null });
  assert.equal(JSON.stringify(ctx.events), JSON.stringify([
    { event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 'studio', value: 'night' }], via: 0 } },
    { event: 'ls_override', data: { op: 'clear', keys: ['block:hall'], via: { by: 'x' } } },
    { event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 7, value: 'night' }], via: 'app' } },
    { event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: null, value: 'night' }], via: null } },
  ]));
});

test('ls_override_block reads the dry-run plan leniently', () => {
  for (const result of [null, [], { plan: 3 }, { plan: { sched: [] } }]) {
    const ctx = context({ ...stateStoreHandlers, ls_apply: () => result });
    ctx.run('ls_override_block', { scope: 'studio', block: 'night' });
    assert.deepEqual(ctx.events, [{ event: 'ls_override', data: { op: 'set', records: [{ kind: 'block', target: 'studio', value: 'night' }], via: 'app' } }],
      `dry-run result ${JSON.stringify(result)}`);
  }
});

// Round 4: captured `'mode:sara' in (overrides or {})` is Python `in` (rendered
// in Home Assistant 2026.7.4: a list's elements and a string's substrings count).
test('ls_sara_mode tests the overrides attribute with Python `in`', () => {
  const run = (overrides: unknown) => {
    const ctx = context(stateStoreHandlers);
    if (overrides !== undefined) ctx.put('sensor.ls_overrides', 'x', { overrides: overrides as never });
    ctx.run('ls_sara_mode', {});
    return (ctx.events[0]?.data as { op: string }).op;
  };
  assert.equal(run(undefined), 'set');
  assert.equal(run(['mode:sara']), 'clear');
  assert.equal(run('mode:sara'), 'clear');
  assert.equal(run({ 'mode:sara': null }), 'clear');
});

test('ls_clear_overrides defaults only an absent via', () => {
  const ctx = context(stateStoreHandlers);
  ctx.run('ls_clear_overrides', {});
  ctx.run('ls_clear_overrides', { via: false });
  assert.deepEqual(ctx.events.map(e => e.data), [{ op: 'clear_all', via: 'app' }, { op: 'clear_all', via: false }]);
});

const sensorUpdate = (ctx: ReturnType<typeof context>) =>
  ctx.calls.find(c => c.service === 'variable.update_sensor')?.data.attributes as Record<string, unknown>;

test('ls_commit set merges a channels record over the stored one, byte for byte', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', 'x', { overrides: {
    k1: { kind: 'channels', created: 'c0', when: 'w0', foo: [1], value: { period: 'p', channels: {
      brightness: { kind: 'constant', v: 1 }, color: { kind: 'effect', underlying: { kind: 'scale', s: 2 } }, keep: { kind: 'x' } }, extra: 1 } },
    other: 5,
  } });
  ctx.run('ls_commit', { data: { via: 'app', who: 'me', records: [{ key: 'k1', kind: 'channels', scope: 'lamp', target: 'light.a',
    value: { channels: { brightness: { kind: 'effect', e: 1 }, color: { kind: 'effect' }, own: { kind: 'effect', underlying: 0 } }, extra: 2 }, zz: { a: 1 } }] } });
  const overrides = sensorUpdate(ctx).overrides as Record<string, unknown>;
  assert.equal(JSON.stringify(overrides), JSON.stringify({
    k1: { key: 'k1', kind: 'channels', scope: 'lamp', target: 'light.a',
      value: { period: 'p', channels: {
        brightness: { kind: 'effect', e: 1, underlying: { kind: 'constant', v: 1 } },
        color: { kind: 'effect', underlying: { kind: 'scale', s: 2 } },
        keep: { kind: 'x' },
        own: { kind: 'effect', underlying: 0 } }, extra: 2 },
      zz: { a: 1 }, when: ctx.now, created: 'c0', who: 'me', via: 'app' },
    other: 5,
  }));
});

test('ls_commit set reads a key written earlier in the same commit as the old record', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', 'x', { overrides: { k: { when: 'w0' } } });
  ctx.run('ls_commit', { data: { records: [
    { key: 'k', kind: 'channels', value: { channels: { brightness: { kind: 'constant', v: 3 } } } },
    { key: 'k', kind: 'channels', value: { channels: { brightness: { kind: 'effect' } } } },
  ] } });
  const k = (sensorUpdate(ctx).overrides as Record<string, Record<string, unknown>>).k!;
  assert.equal(k.created, 'w0');
  assert.equal(JSON.stringify(k.value), JSON.stringify({ channels: { brightness: { kind: 'effect', underlying: { kind: 'constant', v: 3 } } } }));
  assert.equal(k.via, null);
  assert.equal(k.who, null);
});

test('ls_commit clear_room compares raw targets with the raw area, absent included', () => {
  const ctx = context(stateStoreHandlers);
  ctx.areas['light.known'] = 'studio';
  ctx.put('sensor.ls_overrides', 'x', { overrides: {
    a: { scope: 'room' }, b: { scope: 'room', target: 'x' }, c: { kind: 'light', target: 'light.unknown' },
    d: 5, e: { kind: 'block', target: 'studio' }, f: { scope: 'lamp', target: 'light.known' },
  } });
  ctx.run('ls_commit', { data: { op: 'clear_room', via: 'remote' } });
  assert.deepEqual(Object.keys(sensorUpdate(ctx).overrides as object), ['b', 'd', 'e', 'f']);
});

// The committed record's room is an argument and is refused; a SAVED previous
// record's non-text room target marks no room (round 4, lenient saved values).
test('ls_commit refuses a non-string affected room argument; a saved one marks no room', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', {});
  assert.throws(() => ctx.run('ls_commit', { data: { records: [{ key: 'k', scope: 'room', target: 5 }] } }),
    /ls_commit affected\[0\]\.room must be a string, got number 5/);
  ctx.put('sensor.ls_overrides', 'x', { overrides: { k: { scope: 'room', target: [1] } } });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  ctx.run('ls_commit', { data: { op: 'clear', records: [{ key: 'k' }] } });
  assert.deepEqual(sensorUpdate(ctx).pending_rooms, {});
});

test('ls_commit carries stored maps and raw request values through', () => {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', 'x', {
    power: { hall: 'raw', studio: false }, remote_ack: { r1: [1] }, pending_rooms: { hall: 0 },
    switch_ranges: { 'switch.a': { profile: 'odd' } },
  });
  ctx.run('ls_commit', { data: { op: 'range_set', entity: 'switch.b', profile: 'custom', min: true, max: 50,
    via: 'remote', source: 'r2', request_id: { n: 1 }, received_at: { at: 1 } } });
  assert.equal(JSON.stringify(sensorUpdate(ctx)), JSON.stringify({
    switch_ranges: { 'switch.a': { profile: 'odd' }, 'switch.b': { profile: 'custom', min: true, max: 50 } },
    remote_ack: { r1: [1], r2: { n: 1 } },
    overrides: {}, last_via: 'remote', pending_rooms: { hall: 0 }, last_request: ctx.now, received_at: { at: 1 },
  }));
  const power = context(stateStoreHandlers);
  power.put('sensor.ls_overrides', 'x', { power: { hall: 'raw', studio: false } });
  power.run('ls_commit', { data: { op: 'power', area: 'studio', on: 'on', via: 0 } });
  assert.equal(JSON.stringify(sensorUpdate(power).power), JSON.stringify({ hall: 'raw', studio: true }));
  assert.equal(sensorUpdate(power).last_via, 0);
});

test('ls_commit full render keeps unhandled lights first and dedupes by identity', () => {
  const ctx = context(stateStoreHandlers);
  const light = { id: 1 };
  ctx.put('sensor.ls_overrides', 'x', { full_version: 'v1', full_lights: ['l1', light, 'l2'], full_reason: 'cfg' });
  ctx.run('ls_commit', { data: { op: 'render_request', via: 'remote', reason: 'tick', lights: ['l2', 'l3', light, { id: 1 }] } });
  const attributes = sensorUpdate(ctx);
  assert.equal(attributes.full_reason, 'config');
  assert.equal(JSON.stringify(attributes.full_lights), JSON.stringify(['l1', light, 'l2', 'l3', { id: 1 }]));
  assert.equal((attributes.full_lights as unknown[])[1], light);
});
