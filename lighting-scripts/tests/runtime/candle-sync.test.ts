import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { groupingHandlers } from '../../src/domain/grouping.ts';
import type { Snapshot, JsonObject } from '../../src/runtime/context.ts';
const at = '2026-10-26T12:00:00Z';
function initial(): Snapshot {
  const effect = { kind: 'effect', effect: 'Candle' };
  return { now: at, areas: { 'light.lamp': 'studio', 'light.departed': 'studio' }, members: ['light.lamp'],
    identifiers: { 'light.a': [['mqtt', 'zigbee2mqtt_0xaaaa']], 'light.b': [['mqtt', 'zigbee2mqtt_0xbbbb']] },
    catalog: { members: { 'light.lamp': ['light.a'], 'light.departed': ['light.b'] } }, state: {
      'sensor.ls_effects_runtime': { state: '1', attributes: { assignments: { 'light.lamp': { area: 'studio', on: true, brightness: effect, color: effect } } } },
      'sensor.ls_overrides': { state: '0', attributes: {} },
      'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
      'light.lamp': { state: 'on', attributes: {} }, 'light.a': { state: 'on', attributes: {} },
    } };
}
async function driver(snapshot = initial()) {
  const path = '../../src/domain/candle-sync.ts';
  const port = await import(path).catch(() => ({}));
  assert.equal(typeof port.candleSyncHandlers?.effects_candle_sync, 'function', 'Candle reconciliation state machine exists');
  const handlers = { ...groupingHandlers, ...port.candleSyncHandlers, effects_catalog: ctx => ctx.catalog, ls_apply: (ctx, args) => { ctx.fire('repair', args); return null; } };
  return { snapshot, run(script: string, args: JsonObject = {}) { const result = execute({ script, args, snapshot: this.snapshot }, handlers); this.snapshot = result.snapshot; return result; } };
}
const pending = d => d.snapshot.state['sensor.ls_effects_runtime'].attributes.candle_pending;
const change = (d, key, value) => { d.snapshot.state['sensor.ls_effects_runtime'].attributes[key] = value; };

test('Candle waits for publish completion, matching response and fresh actual membership', async () => {
  const d = await driver();
  const start = d.run('effects_candle_sync');
  assert.equal(pending(d).stage, 'publishing');
  assert.equal(start.calls.filter(c => c.service === 'mqtt.publish').length, 1);
  const token = pending(d).token;
  change(d, 'candle_response', { transaction: token, status: 'ok' });
  assert.equal(d.run('effects_candle_sync_resume').calls.length, 0, 'response before publish ACK cannot start another operation');
  d.snapshot.now = '2026-10-26T12:00:02Z';
  d.run('effects_candle_sync_published', { token, host_output_success: true });
  assert.equal(pending(d).stage, 'membership');
  change(d, 'candle_group', { exists: true, members: [], observed_at: Date.parse(at) / 1000 - 1 });
  assert.equal(d.run('effects_candle_sync_resume').calls.length, 0);
  change(d, 'candle_group', { exists: true, members: [], observed_at: Date.parse(d.snapshot.now) / 1000 });
  const next = d.run('effects_candle_sync_resume');
  const request = next.calls.find(c => c.service === 'mqtt.publish');
  assert.equal(request.data.topic, 'zigbee2mqtt/bridge/request/group/members/add');
  assert.equal(JSON.parse(request.data.payload).device, '0xaaaa');
  assert.notEqual(pending(d).token, token);
  assert.equal(d.run('effects_candle_sync_timeout', { token, stage: 'membership' }).calls.length, 0);
});

test('departures are removed before additions and repaired only after both confirmations', async () => {
  const state = initial();
  state.state['sensor.ls_effects_runtime'].attributes.candle_group = { exists: true, members: [{ ieee_address: '0xbbbb', endpoint: 1 }], observed_at: Date.parse(at) / 1000 };
  const d = await driver(state);
  const start = d.run('effects_candle_sync');
  assert.equal(start.calls.find(c => c.service === 'mqtt.publish').data.topic, 'zigbee2mqtt/bridge/request/group/members/remove');
  const token = pending(d).token;
  d.run('effects_candle_sync_published', { token, host_output_success: true });
  change(d, 'candle_response', { transaction: token, status: 'ok' });
  assert.equal(d.run('effects_candle_sync_resume').events.length, 0);
  d.snapshot.now = '2026-10-26T12:00:01Z';
  change(d, 'candle_group', { exists: true, members: [], observed_at: Date.parse(d.snapshot.now) / 1000 });
  const confirmed = d.run('effects_candle_sync_resume');
  assert.deepEqual(confirmed.events, [{ event: 'repair', data: { reason: 'manual', lights: ['light.departed'] } }]);
  assert.equal(confirmed.calls.find(c => c.service === 'mqtt.publish').data.topic, 'zigbee2mqtt/bridge/request/group/members/add');
});

test('timeout or failed publish retains safety gate and a bounded retry deadline', async () => {
  for (const failedPublish of [true, false]) {
    const d = await driver(); d.run('effects_candle_sync'); const token = pending(d).token;
    d.run('effects_candle_sync_published', { token, host_output_success: !failedPublish });
    if (!failedPublish) { d.snapshot.now = '2026-10-26T12:00:10Z'; d.run('effects_candle_sync_timeout', { token, stage: 'response' }); }
    const attrs = d.snapshot.state['sensor.ls_effects_runtime'].attributes;
    assert.equal(attrs.candle_syncing, true);
    assert.equal(attrs.candle_pending, null);
    assert.equal(attrs.candle_retry_at, Date.parse(d.snapshot.now) / 1000 + 30);
    assert.equal(d.run('effects_candle_sync').calls.length, 0);
  }
});

test('current exact membership unpauses and clears errors without bridge writes', async () => {
  const state = initial();
  Object.assign(state.state['sensor.ls_effects_runtime'].attributes, { candle_error: 'old failure', candle_group: { exists: true, members: [{ ieee_address: '0xaaaa', endpoint: 1 }], observed_at: Date.parse(at) / 1000 } });
  const d = await driver(state), result = d.run('effects_candle_sync');
  assert.equal(result.calls.filter(c => c.service === 'mqtt.publish').length, 0);
  assert.equal(result.calls[1].service, 'persistent_notification.dismiss');
  assert.equal(d.snapshot.state['sensor.ls_effects_runtime'].attributes.candle_syncing, false);
});

test('the native repeat.index < 100 bound stops before operation 100', async () => {
  const d = await driver(); d.run('effects_candle_sync');
  const state = pending(d); state.iteration = 99;
  change(d, 'candle_response', { transaction: state.token, status: 'ok' });
  change(d, 'candle_group', { exists: true, members: [], observed_at: Date.parse(at) / 1000 });
  const result = d.run('effects_candle_sync_published', { token: state.token, host_output_success: true });
  assert.equal(result.calls.filter(c => c.service === 'mqtt.publish').length, 0);
  assert.equal(d.snapshot.state['sensor.ls_effects_runtime'].attributes.candle_error, 'Membership reconciliation interrupted');
});

test('negative response and missing membership both retain the failed request', async () => {
  for (const status of ['error', 'ok']) {
    const d = await driver(); d.run('effects_candle_sync');
    const { token, request } = pending(d);
    d.run('effects_candle_sync_published', { token, host_output_success: true });
    change(d, 'candle_response', { transaction: 'candle:unrelated', status });
    assert.equal(d.run('effects_candle_sync_resume').calls.length, 0);
    change(d, 'candle_response', { transaction: token, status });
    d.run('effects_candle_sync_resume');
    if (status === 'ok') {
      assert.equal(pending(d).stage, 'membership');
      assert.equal(d.run('effects_candle_sync_timeout', { token, stage: 'response' }).calls.length, 0);
      d.snapshot.now = '2026-10-26T12:00:10Z';
      d.run('effects_candle_sync_timeout', { token, stage: 'membership' });
    }
    assert.deepEqual(d.snapshot.state['sensor.ls_effects_runtime'].attributes.candle_error, request);
    assert.equal(pending(d), null);
  }
});

test('response timeout is anchored to MQTT completion, not subsequent helper acknowledgement', async () => {
  const d = await driver(); d.run('effects_candle_sync'); const token = pending(d).token;
  d.snapshot.now = '2026-10-26T12:00:05Z';
  d.run('effects_candle_sync_published', { token, host_output_success: true, host_completed_at: '2026-10-26T12:00:04Z' });
  const timer = d.snapshot.scheduled.find(task => task.script === 'effects_candle_sync_timeout');
  assert.equal(timer.args.host_timer_deadline, Date.parse('2026-10-26T12:00:14Z'));
  assert.equal(timer.due, Date.parse('2026-10-26T12:00:14Z'));
  change(d, 'candle_response', { transaction: token, status: 'ok' });
  d.run('effects_candle_sync_resume');
  const membership = d.snapshot.scheduled.find(task => task.args.stage === 'membership');
  assert.equal(membership.args.host_timer_deadline, Date.parse('2026-10-26T12:00:15Z'));
});
