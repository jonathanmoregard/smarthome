import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';
async function driver() {
  const path = '../../src/domain/automations.ts';
  const port = await import(path).catch(() => ({}));
  assert.equal(typeof port.automationHandlers?.['automation.effects_native_light_controls'], 'function');
  const ctx = context(port.automationHandlers), invoked = [];
  const dispatch = ctx.run.bind(ctx);
  ctx.run = (name, args = {}) => {
    if (name.startsWith('automation.')) return dispatch(name, args);
    invoked.push({ name, args });
    if (name === 'effects_native_plan') return { power: [{ area: 'studio' }], records: [{ kind: 'level', target: 'light.a', value: 70 }] };
    return {};
  };
  return { ctx, invoked };
}
test('MQTT native controls use runtime topic mapping and preserve ordered script outputs', async () => {
  const { ctx, invoked } = await driver();
  ctx.catalog = { ui_rows: [{ source: 'light.custom', topics: { power: 'house/v1/effect_preview/new_alias/set/power' } }] };
  ctx.run('automation.effects_native_light_controls', { trigger: { topic: 'house/v1/effect_preview/new_alias/set/brightness', payload: '87' } });
  assert.deepEqual(invoked, [{ name: 'effects_set', args: { source: 'light.custom', attribute: 'brightness', value: 87 } }]);
  assert.deepEqual(ctx.calls, [{ service: 'script.turn_on', data: {}, target: { entity_id: 'script.effects_ui_sync' } }]);
  ctx.run('automation.effects_native_light_controls', { trigger: { topic: 'house/v1/effect_preview/unknown/set/brightness', payload: '87' } });
  assert.equal(invoked.length, 1);
});
test('writer preserves event data and explicit who, recovery only requests dirty online work', async () => {
  const { ctx, invoked } = await driver();
  ctx.run('automation.lighting_schedule_override_store_writer', { trigger: { event: { data: { op: 'clear_all', who: '' }, context: { user_id: 'person' } } } });
  assert.deepEqual(invoked, [{ name: 'ls_commit', args: { data: { op: 'clear_all', who: 'person' } } }]);
  ctx.put('sensor.ls_overrides', '1', { full_version: 1, pending_rooms: { studio: 2 } });
  ctx.put('sensor.ls_effects_runtime', '1', { handled_full: 1, handled_rooms: { studio: 1 } });
  ctx.run('automation.lighting_recover_pending_output', {}); assert.equal(ctx.calls.length, 0);
  ctx.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on');
  ctx.run('automation.lighting_recover_pending_output', {});
  assert.deepEqual(ctx.calls[0], { service: 'script.turn_on', data: {}, target: { entity_id: 'script.ls_render' } });
});
test('remote adapters preserve generic room topology and exact preset payload', async () => {
  const { ctx, invoked } = await driver();
  ctx.run('automation.remote_center', { room: 'new_room', trigger: { payload: 'off' } });
  ctx.run('automation.remote_directions', { room: 'new_room', trigger: { id: 'up' } });
  ctx.run('automation.remote_preset', { room: 'new_room', trigger: { payload_json: { action: 'color_temperature_move', action_color_temperature: 285 } } });
  assert.deepEqual(invoked, [
    { name: 'ls_remote_gesture_new_room', args: { command: 'power' } },
    { name: 'ls_remote_gesture_new_room', args: { command: 'up' } },
    { name: 'ls_remote_gesture_new_room', args: { command: 'preset', payload: { action: 'color_temperature_move', action_color_temperature: 285 } } },
  ]);
});
test('expiry boundaries, user mirror and valid ranges publish exact override events', async () => {
  const { ctx } = await driver();
  ctx.put('sensor.ls_overrides', '1', { overrides: { expired: { when: new Date(Date.parse(ctx.now) - 60000).toISOString() }, fresh: { when: new Date(Date.parse(ctx.now) - 59000).toISOString() }, numeric: { when: Date.parse(ctx.now) / 1000 - 60 }, bad: { when: 'invalid' } } });
  ctx.put('input_boolean.ls_ovr_after_on', 'on'); ctx.put('input_number.ls_ovr_after_min', '1');
  ctx.run('automation.lighting_schedule_end_overrides', { trigger: { id: 'after' } });
  assert.deepEqual(ctx.events[0], { event: 'ls_override', data: { op: 'clear', keys: ['expired'], via: 'rule_after' } });
  ctx.run('automation.lighting_schedule_sara_mode_switch', { trigger: { id: 'on', to_state: { context: { user_id: null } } } });
  assert.equal(ctx.events.length, 1);
  ctx.run('automation.lighting_schedule_sara_mode_switch', { trigger: { id: 'on', to_state: { context: { user_id: 'person' } } } });
  assert.deepEqual(ctx.events[1].data, { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who: 'person' });
  for (const [key, value] of Object.entries({ bright_min: '50', bright_max: '100', cosy_min: '0', cosy_max: '40' })) ctx.put(`input_number.ls_range_${key}`, value);
  ctx.run('automation.switch_lamps_validate_house_defaults', {});
  assert.deepEqual(ctx.events[2].data, { op: 'range_defaults', ranges: { bright: [50, 100], cosy: [0, 40] }, via: 'schedule-ui' });
  ctx.put('input_number.ls_range_bright_min', '101'); ctx.run('automation.switch_lamps_validate_house_defaults', {}); assert.equal(ctx.events.length, 3);
});
test('native app capture preserves power first and channel record order', async () => {
  const { ctx, invoked } = await driver();
  ctx.run('automation.lighting_schedule_lamp_change_detector', { trigger: { event: { data: { service: 'turn_on', service_data: { entity_id: 'light.a', brightness: 70 } }, context: { user_id: 'person' } } } });
  assert.deepEqual(invoked.map(i => i.name), ['effects_catalog', 'ls_apply', 'effects_native_plan']);
  assert.deepEqual(ctx.events.map(e => e.data.op), ['power', 'set']);
  assert.deepEqual(ctx.events[0].data, { op: 'power', area: 'studio', on: true, via: 'app', who: 'person' });
});
test('Candle group observations store fresh actual state before resuming waiting operation', async () => {
  const { ctx, invoked } = await driver(); ctx.put('sensor.ls_effects_runtime', '1');
  ctx.run('automation.effects_candle_group_state', { trigger: { id: 'groups', payload_json: [{ friendly_name: 'fx_candle_active', id: 1100, members: [{ ieee_address: '0xa', endpoint: 1 }] }] } });
  assert.deepEqual(ctx.calls[0].data.attributes, { candle_group: { exists: true, id: 1100, members: [{ ieee_address: '0xa', endpoint: 1 }], observed_at: Date.parse(ctx.now) / 1000 } });
  assert.deepEqual(invoked, [{ name: 'effects_candle_sync_resume', args: {} }]);
  ctx.run('automation.effects_candle_group_state', { trigger: { id: 'response', payload_json: { transaction: 'unrelated', status: 'ok' } } }); assert.equal(ctx.calls.length, 1);
});
test('lifecycle does not restart the typed engine while its continuation is pending', async () => {
  const { ctx, invoked } = await driver();
  ctx.put('script.effects_engine', 'off');
  ctx.put('sensor.ls_effects_runtime', '1', { assignments: { 'light.a': { on: true } } });
  ctx.schedule('effects_engine_tick', {}, 200);
  ctx.run('automation.effects_lifecycle', {});
  assert.equal(invoked.length, 0);
  ctx.scheduled = [];
  ctx.run('automation.effects_lifecycle', {});
  assert.deepEqual(invoked, [{ name: 'ls_apply', args: { reason: 'config' } }]);
});
