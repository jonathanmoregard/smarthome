import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Snapshot } from '../../src/runtime/context.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';

// Review A1: a journal written before the frame engine was removed can still
// hold a scheduled `effects_engine_tick`. The current registry has no handler
// for it, so the engine throws `Unsupported script`. The host drops tasks for
// that one named retired script (on load and in runDue) with a log line; any
// other unknown script still fails loudly.
test('review A1: a due task for a removed handler does not block later due tasks', async () => {
  const { LightingHost } = await import('../../src/runtime/host.ts');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  const now = Date.parse('2026-10-26T12:00:00Z');
  const initial: Snapshot = {
    state: { 'sensor.ls_overrides': { state: '1', attributes: {}, last_updated: 'r1' } },
    areas: {}, members: [], now: '2026-10-26T12:00:00Z',
    scheduled: [
      { script: 'effects_engine_tick', args: {}, due: now - 2 },
      { script: 'later', args: {}, due: now - 1 },
    ],
  };
  const program = (request: Parameters<typeof execute>[0]) => execute(request, {
    ...handlers,
    later: ctx => { ctx.put('sensor.later_ran', 'yes'); return null; },
  });
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, program, autoTimers: false, now: () => now,
    transport: { send: async () => {}, close: async () => {} } });
  let error: unknown;
  try { await host.runDue(); } catch (caught) { error = caught; }
  const after = host.snapshot();
  await host.close();
  assert.equal(after.state['sensor.later_ran']?.state, 'yes',
    `the later task never ran; runDue ${error === undefined ? 'returned' : `threw ${String(error)}`}; scheduled left: ${JSON.stringify((after.scheduled ?? []).map(t => t.script))}`);
});

test('review A1: the retired task is dropped with a log line and never reaches the program', async () => {
  const { LightingHost } = await import('../../src/runtime/host.ts');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  const now = Date.parse('2026-10-26T12:00:00Z');
  const initial: Snapshot = {
    state: { 'sensor.ls_overrides': { state: '1', attributes: {}, last_updated: 'r1' } },
    areas: {}, members: [], now: '2026-10-26T12:00:00Z',
    scheduled: [{ script: 'effects_engine_tick', args: {}, due: now + 60_000 }],
  };
  const reports: string[] = [], seen: string[] = [];
  const program = (request: Parameters<typeof execute>[0]) => { seen.push(request.script); return execute(request, handlers); };
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, program, autoTimers: false, now: () => now,
    report: message => reports.push(message), transport: { send: async () => {}, close: async () => {} } });
  const after = host.snapshot();
  await host.close();
  assert.deepEqual(after.scheduled, [], 'dropped on load, before it is due');
  assert.deepEqual(seen, []);
  assert.ok(reports.some(line => line.includes('effects_engine_tick')), `no log line named the dropped task: ${JSON.stringify(reports)}`);
});

test('review A1: a due task for any other unknown script still fails loudly', async () => {
  const { LightingHost } = await import('../../src/runtime/host.ts');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  const now = Date.parse('2026-10-26T12:00:00Z');
  const initial: Snapshot = {
    state: { 'sensor.ls_overrides': { state: '1', attributes: {}, last_updated: 'r1' } },
    areas: {}, members: [], now: '2026-10-26T12:00:00Z',
    scheduled: [{ script: 'no_such_handler', args: {}, due: now - 1 }],
  };
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, program: request => execute(request, handlers),
    autoTimers: false, now: () => now, transport: { send: async () => {}, close: async () => {} } });
  try {
    await assert.rejects(host.runDue(), /Unsupported script: no_such_handler/);
    assert.deepEqual(host.snapshot().scheduled?.map(task => task.script), ['no_such_handler'], 'kept, not silently dropped');
  } finally { await host.close(); }
});

test('review A1: a retired task that appears after load is dropped by runDue, and the next due task runs', async () => {
  const { LightingHost } = await import('../../src/runtime/host.ts');
  const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
  const now = Date.parse('2026-10-26T12:00:00Z');
  const initial: Snapshot = { state: { 'sensor.ls_overrides': { state: '1', attributes: {}, last_updated: 'r1' } }, areas: {}, members: [], now: '2026-10-26T12:00:00Z' };
  const program = (request: Parameters<typeof execute>[0]) => execute(request, {
    ...handlers,
    later: ctx => { ctx.put('sensor.later_ran', 'yes'); return null; },
  });
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, program, autoTimers: false, now: () => now,
    transport: { send: async () => {}, close: async () => {} } });
  try {
    await host.update(state => { state.scheduled = [{ script: 'effects_engine_tick', args: {}, due: now - 2 }, { script: 'later', args: {}, due: now - 1 }]; });
    await host.runDue();
    const after = host.snapshot();
    assert.equal(after.state['sensor.later_ran']?.state, 'yes');
    assert.deepEqual(after.scheduled, []);
  } finally { await host.close(); }
});
