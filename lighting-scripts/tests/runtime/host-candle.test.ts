import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LightingHost } from '../../src/runtime/host.ts';
import { execute } from '../../src/runtime/engine.ts';
import { groupingHandlers } from '../../src/domain/grouping.ts';
import { candleSyncHandlers } from '../../src/domain/candle-sync.ts';
import type { Snapshot } from '../../src/runtime/context.ts';

test('Candle publish continuation waits for sink completion and receives failure without replaying the mutation', async () => {
  let now = Date.parse('2026-10-26T12:00:00Z'), release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const effect = { kind: 'effect', effect: 'Candle' };
  const initial: Snapshot = { now: new Date(now).toISOString(), members: ['light.lamp'], areas: { 'light.lamp': 'studio' }, identifiers: { 'light.a': [['mqtt', 'zigbee2mqtt_0xaaaa']] }, catalog: { members: { 'light.lamp': ['light.a'] } }, state: {
    'sensor.ls_effects_runtime': { state: '1', attributes: { assignments: { 'light.lamp': { area: 'studio', on: true, brightness: effect, color: effect } } } },
    'sensor.ls_overrides': { state: '0', attributes: {} }, 'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.lamp': { state: 'on', attributes: {} }, 'light.a': { state: 'on', attributes: {} },
  } };
  const directory = await mkdtemp(join(tmpdir(), 'lighting-candle-host-'));
  let mqtt = 0;
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, autoTimers: false, now: () => now,
    program: request => execute(request, { ...groupingHandlers, ...candleSyncHandlers, effects_catalog: ctx => ctx.catalog! }),
    transport: { send: async call => { if (call.service === 'mqtt.publish') { mqtt++; await gate; throw new Error('publish acknowledgement lost'); } }, close: async () => {} } });
  await host.dispatch('effects_candle_sync'); now += 20_000; await host.runDue();
  assert.equal(host.snapshot().state['sensor.ls_effects_runtime']!.attributes.candle_pending.stage, 'publishing');
  release(); await host.drain(); await host.runDue(); await host.drain();
  const runtime = host.snapshot().state['sensor.ls_effects_runtime']!.attributes;
  assert.equal(runtime.candle_pending, null);
  assert.equal(runtime.candle_syncing, true);
  assert.equal(mqtt, 1);
  assert.ok(runtime.candle_retry_at >= now / 1000 + 30);
  await host.close();
});
