import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LightingHost } from '../../src/runtime/host.ts';
import { execute } from '../../src/runtime/engine.ts';
import type { Snapshot } from '../../src/runtime/context.ts';

test('slow registry refresh preserves consumed timers, new continuations, catalog edits and newer HA events', async () => {
  const now = Date.parse('2026-10-26T12:00:00Z'), directory = await mkdtemp(join(tmpdir(), 'lighting-refresh-'));
  let release!: (snapshot: Snapshot) => void, captured!: Snapshot, sends = 0;
  const initial: Snapshot = { now: new Date(now).toISOString(), state: { 'light.existing': { state: 'on', attributes: {}, last_updated: '2026-10-26T12:00:00Z' } }, areas: {}, members: [], catalog: { marker: 'old' }, scheduled: [{ script: 'tick', args: {}, due: now }] };
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, now: () => now, autoTimers: false,
    transport: { send: async () => { sends++; }, close: async () => {} },
    program: request => execute(request, {
      tick: ctx => { ctx.emit('mqtt.publish', { topic: 'fixture/set', payload: '{}' }); return null; },
      later: ctx => { ctx.schedule('tick', {}, 1000); return null; },
    }),
  });
  try {
    const refresh = host.refresh(previous => { captured = previous; return new Promise(resolve => { release = resolve; }); });
    await host.runDue(); await host.drain();
    await host.dispatch('later');
    await host.update(state => { state.catalog = { marker: 'new' }; });
    await host.ingestState('light.new', { state: 'on', attributes: {}, last_updated: '2026-10-26T12:00:01Z' });
    await host.ingestState('light.existing', { state: 'off', attributes: {}, last_updated: '2026-10-26T12:00:01Z' });
    release({ ...captured, areas: { 'light.new': 'new-room' } }); await refresh;
    await host.runDue(); await host.drain();
    assert.deepEqual({ sends, catalog: host.snapshot().catalog, pending: host.snapshot().scheduled?.length,
      newState: host.snapshot().state['light.new']?.state, area: host.snapshot().areas['light.new'] },
    { sends: 1, catalog: { marker: 'new' }, pending: 1, newState: 'on', area: 'new-room' });
    assert.equal(host.snapshot().state['light.existing']?.state, 'off');
    const older = host.refresh(previous => { captured = previous; return new Promise(resolve => { release = resolve; }); });
    await host.refresh(async previous => ({ ...previous, areas: { 'light.new': 'latest-room' } }));
    release({ ...captured, areas: { 'light.new': 'stale-room' } }); await older;
    assert.equal(host.snapshot().areas['light.new'], 'latest-room');
  } finally { await host.close(); }
});
