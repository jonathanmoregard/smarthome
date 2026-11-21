import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Snapshot } from '../../src/runtime/context.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';

// Review 2, R1: the deleted software candle (b00e10a) scheduled
// `effects_candle_sync_timeout` and `effects_candle_sync_published`. A journal
// written before that deletion can still hold one; the host must drop it like
// `effects_engine_tick` instead of throwing `Unsupported script` in every
// runDue and blocking the tasks due after it.
for (const retired of ['effects_candle_sync_timeout', 'effects_candle_sync_published']) {
  test(`review2 R1: a due ${retired} task does not block later due tasks`, async () => {
    const { LightingHost } = await import('../../src/runtime/host.ts');
    const directory = await mkdtemp(join(tmpdir(), 'lighting-host-'));
    const now = Date.parse('2026-10-26T12:00:00Z');
    const initial: Snapshot = {
      state: { 'sensor.ls_overrides': { state: '1', attributes: {}, last_updated: 'r1' } },
      areas: {}, members: [], now: '2026-10-26T12:00:00Z',
      scheduled: [
        { script: retired, args: { token: 't1' }, due: now - 2 },
        { script: 'later', args: {}, due: now - 1 },
      ],
    };
    const program = (request: Parameters<typeof execute>[0]) => execute(request, {
      ...handlers,
      later: ctx => { ctx.put('sensor.later_ran', 'yes'); return null; },
    });
    const reports: string[] = [];
    const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, program, autoTimers: false, now: () => now,
      report: message => reports.push(message), transport: { send: async () => {}, close: async () => {} } });
    let error: unknown;
    try { await host.runDue(); } catch (caught) { error = caught; }
    const after = host.snapshot();
    await host.close();
    assert.equal(after.state['sensor.later_ran']?.state, 'yes',
      `the later task never ran; runDue ${error === undefined ? 'returned' : `threw ${String(error)}`}`);
    assert.deepEqual(after.scheduled, []);
    assert.ok(reports.some(line => line.includes(retired)), `no log line named the dropped task: ${JSON.stringify(reports)}`);
  });
}
