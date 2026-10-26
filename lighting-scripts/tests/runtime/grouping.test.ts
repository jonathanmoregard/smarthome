import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';
const modulePath = '../../src/domain/grouping.ts';
async function load() {
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.groupingHandlers?.effects_group_plan, 'function', 'group planner exists');
  return port;
}

test('exact payload and verified whole membership are required for multicast', async () => {
  const { groupingHandlers } = await load();
  const ctx = context(groupingHandlers);
  const rows = ['a', 'b', 'c'].map(entity => ({ entity, owner: 'lamp_' + entity, topic: `zigbee2mqtt/${entity}/set`, payload: { brightness: 90 } }));
  const groups = [{ id: 'whole', topic: 'zigbee2mqtt/whole/set', members: ['a', 'b', 'c'], verified: true }];
  assert.deepEqual(ctx.run('effects_group_plan', { rows, groups }), {
    commands: [{ topic: 'zigbee2mqtt/whole/set', members: ['a', 'b', 'c'], owners: ['lamp_a', 'lamp_b', 'lamp_c'], payload: { brightness: 90 }, group: 'whole' }], rejected: [], input_count: 3, endpoint_count: 3, command_count: 1,
  });
  rows[1].payload.brightness = 91;
  assert.equal(ctx.run('effects_group_plan', { rows, groups }).command_count, 3);
  assert.equal(ctx.run('effects_group_plan', { rows: rows.slice(0, 2), groups }).command_count, 2);
});

test('conflicting duplicate endpoints and same-topic membership never leak into multicast', async () => {
  const { groupingHandlers } = await load();
  const ctx = context(groupingHandlers);
  const rows = ['a', 'b', 'c'].map(entity => ({ entity, owner: 'lamp_' + entity, topic: `zigbee2mqtt/${entity}/set`, payload: { brightness: 90 } }));
  const groups = [['a', 'b'], ['b', 'c']].map(members => ({ topic: 'zigbee2mqtt/shared/set', members, verified: true }));
  assert.equal(ctx.run('effects_group_plan', { rows, groups }).command_count, 3);
  rows.push({ ...rows[0], owner: 'different' });
  const plan = ctx.run('effects_group_plan', { rows, groups });
  assert.deepEqual(plan.commands.map(c => c.members), [['b'], ['c']]);
  assert.deepEqual(plan.rejected, [{ entity: 'a', reason: 'conflicting_endpoint_rows' }]);
});

test('Candle readiness needs exact fresh acknowledged membership, power and endpoint state', async () => {
  const { groupingHandlers } = await load();
  const ctx = context(groupingHandlers);
  const assignment = { on: true, area: 'studio', brightness: { kind: 'effect', effect: 'Candle' }, color: { kind: 'effect', effect: 'Candle' } };
  ctx.identifiers = { 'light.a': [['mqtt', 'zigbee2mqtt_0xaaaa']], 'light.b': [['mqtt', 'zigbee2mqtt_0xbbbb']] };
  const actual = { exists: true, observed_at: 10, members: [{ ieee_address: '0xaaaa', endpoint: 1 }] };
  ctx.put('sensor.ls_effects_runtime', 'active', { assignments: { 'light.lamp': assignment }, candle_group: actual });
  ctx.put('sensor.ls_overrides', 'ready', { power: { studio: true } });
  for (const entity of ['light.lamp', 'light.a', 'binary_sensor.zigbee2mqtt_bridge_connection_state']) ctx.put(entity, 'on');
  ctx.put('light.b', 'off');
  ctx.state['binary_sensor.zigbee2mqtt_bridge_connection_state'].last_changed = '1970-01-01T00:00:09Z';
  const catalog = { members: { 'light.lamp': ['light.a', 'light.b'] } };
  let plan = ctx.run('effects_candle_plan', { catalog });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.members, [{ ieee_address: '0xaaaa', endpoint: 1 }]);
  ctx.state['binary_sensor.zigbee2mqtt_bridge_connection_state'].last_changed = '1970-01-01T00:00:11Z';
  assert.equal(ctx.run('effects_candle_plan', { catalog }).ready, false);
  ctx.put('sensor.ls_overrides', 'ready', { power: { studio: false } });
  plan = ctx.run('effects_candle_plan', { catalog });
  assert.deepEqual(plan.members, []);
  assert.deepEqual(plan.remove, [{ ieee_address: '0xaaaa', endpoint: 1 }]);
  assert.equal(plan.ready, false);
});

test('explicit null group ID survives the deployed planner response', async () => {
  const { groupingHandlers } = await load();
  const ctx = context(groupingHandlers);
  const rows = ['a', 'b'].map(entity => ({ entity, owner: 'lamp', topic: `zigbee2mqtt/${entity}/set`, payload: { brightness: 90 } }));
  const result = ctx.run('effects_group_plan', { rows, groups: [{ id: null, topic: 'zigbee2mqtt/both/set', members: ['a', 'b'], verified: true }] });
  assert.equal(result.commands[0].group, null);
  assert.equal(result.command_count, 1);
});
