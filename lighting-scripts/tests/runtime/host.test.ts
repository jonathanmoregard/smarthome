import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Snapshot, ServiceCall } from '../../src/runtime/context.ts';
import { execute } from '../../src/runtime/engine.ts';
const snapshot: Snapshot = { state: { 'sensor.ls_overrides': { state: '1', attributes: {}, last_updated: 'r1' }, 'sensor.ls_effects_runtime': { state: '1', attributes: { generation: 1, applied: {} } }, 'light.a': { state: 'on', attributes: {} } }, areas: { 'light.a': 'living' }, members: ['light.a'], now: '2026-10-26T12:00:00Z' };
const guard = { revision: 'r1', generation: 1, owners: ['light.a'], members: ['light.a'] };

test('stale async output stops the batch and does not persist speculative applied success', async () => {
  const path = '../../src/runtime/host.ts'; const port = await import(path).catch(() => ({}));
  assert.equal(typeof port.LightingHost, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const calls: ServiceCall[] = [];
  const host = await port.LightingHost.open({ path: join(directory, 'state.json'), initial: snapshot, autoTimers: false,
    program: (request: Parameters<typeof execute>[0]) => execute(request, { render: ctx => { ctx.emit('mqtt.publish', { topic: 'one' }, undefined, guard); ctx.emit('mqtt.publish', { topic: 'two' }, undefined, guard); ctx.emit('variable.update_sensor', { attributes: { applied: { a: 1 } } }, { entity_id: 'sensor.ls_effects_runtime' }, { ...guard, requiresOutputSuccess: true }); return null; } }),
    transport: { send: async (call: ServiceCall) => { calls.push(call); if (calls.length === 1) { entered(); await gate; } }, close: async () => {} } });
  await host.dispatch('render'); await started;
  assert.deepEqual(host.snapshot().state['sensor.ls_effects_runtime'].attributes.applied, {});
  await host.update(state => { state.state['sensor.ls_overrides'].last_updated = 'r2'; });
  release(); await host.drain();
  assert.deepEqual(calls.map(c => c.data.topic), ['one']);
  assert.deepEqual(host.snapshot().state['sensor.ls_effects_runtime'].attributes.applied, {});
  await host.close();
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).snapshot.state['sensor.ls_effects_runtime'].attributes.applied, {});
});

test('exclusive host ownership prevents duplicate writers and pending work is not replayed after uncertain shutdown', async () => {
  const path = '../../src/runtime/host.ts'; const port = await import(path).catch(() => ({}));
  assert.equal(typeof port.LightingHost, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  const file = join(directory, 'state.json');
  const calls: ServiceCall[] = [];
  const options = { path: file, initial: snapshot, autoTimers: false,
    program: (request: Parameters<typeof execute>[0]) => execute(request, { emit: ctx => { ctx.emit('light.turn_on', { brightness: 80 }); return null; } }),
    transport: { send: async (call: ServiceCall) => { calls.push(call); throw new Error('ack lost'); }, close: async () => {} } };
  const first = await port.LightingHost.open(options);
  await assert.rejects(port.LightingHost.open(options), /owner|locked/i);
  await first.dispatch('emit'); await first.drain(); await first.close();
  const recovered = await port.LightingHost.open(options); await recovered.drain();
  assert.equal(calls.length, 1);
  assert.equal(recovered.recoveryRequired, true);
  await recovered.close();
});

test('scheduled continuation starts after actual output completion and survives restart once', async () => {
  const { LightingHost } = await import('../../src/runtime/host.ts');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  let now = Date.parse(snapshot.now), release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const program = (request: Parameters<typeof execute>[0]) => execute(request, {
    start: ctx => { ctx.emit('mqtt.publish', { topic: 'request' }); ctx.schedule('complete', {}, 10_000); return null; },
    complete: (ctx, args) => { ctx.put('sensor.completed', String(args.host_output_success)); return null; },
  });
  const options = { path: join(directory, 'state.json'), initial: snapshot, autoTimers: false, now: () => now, program, transport: { send: async () => { await wait; }, close: async () => {} } };
  const host = await LightingHost.open(options);
  await host.dispatch('start'); now += 20_000; await host.runDue();
  assert.equal(host.snapshot().state['sensor.completed'], undefined);
  release(); await host.drain();
  assert.equal(host.snapshot().scheduled?.[0]?.due, now + 10_000);
  await host.close();
  const reopened = await LightingHost.open(options);
  now += 11_000; await reopened.runDue(); await reopened.runDue();
  assert.equal(reopened.snapshot().state['sensor.completed']?.state, 'true');
  assert.equal(reopened.snapshot().scheduled?.length, 0);
  await reopened.close();
});

test('confirmed helper revisions drive rendering and old echoes cannot overwrite newer pending intent', async () => {
  const { LightingHost } = await import('../../src/runtime/host.ts');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let writes = 0; const sends: ServiceCall[] = [];
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial: snapshot, autoTimers: false,
    program: request => execute(request, {
      input: (ctx, args) => { ctx.put('sensor.ls_overrides', '1', { wanted: args.value! }); ctx.emit('variable.update_sensor', { attributes: { wanted: args.value! } }, { entity_id: 'sensor.ls_overrides' }); ctx.emit('script.turn_on', {}, { entity_id: 'script.render' }); return null; },
      render: ctx => { ctx.emit('mqtt.publish', { topic: 'lamp', payload: JSON.stringify({ brightness: ctx.attr('sensor.ls_overrides', 'wanted') }) }, undefined, { revision: ctx.state['sensor.ls_overrides']!.last_updated!, generation: 1 }); return null; },
    }), transport: { send: async call => { sends.push(call); if (call.service === 'variable.update_sensor') { const version = ++writes; if (version === 1) { entered(); await wait; } return { states: { 'sensor.ls_overrides': { state: '1', attributes: { wanted: call.data.attributes.wanted }, last_updated: `2026-10-26T12:00:0${version}Z` } } }; } }, close: async () => {} } });
  await host.dispatch('input', { value: 80 }); await started;
  await host.dispatch('input', { value: 90 });
  await host.ingestState('sensor.ls_overrides', { state: '1', attributes: { wanted: 80 }, last_updated: '2026-10-26T12:00:01Z' });
  assert.equal(host.snapshot().state['sensor.ls_overrides']!.attributes.wanted, 90);
  release(); await host.drain();
  const physical = sends.filter(call => call.service === 'mqtt.publish');
  assert.ok(physical.length > 0);
  assert.equal(physical.at(-1)?.guard?.revision, '2026-10-26T12:00:02Z');
  assert.equal(JSON.parse(String(physical.at(-1)?.data.payload)).brightness, 90);
  await host.ingestState('sensor.ls_overrides', { state: '1', attributes: { wanted: 80 }, last_updated: '2026-10-26T12:00:01Z' });
  assert.equal(host.snapshot().state['sensor.ls_overrides']!.attributes.wanted, 90);
  await host.close();
});
