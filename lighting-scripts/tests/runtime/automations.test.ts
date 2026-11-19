import assert from 'node:assert/strict';
import test from 'node:test';
import { context, setCatalog } from './gestures-context.ts';
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
  setCatalog(ctx, { ui_rows: [{ source: 'light.custom', topics: { power: 'house/v1/effect_preview/new_alias/set/power' } }] });
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
test('writer uses Jinja or semantics for empty-container who values', async () => {
  const { ctx, invoked } = await driver();
  ctx.run('automation.lighting_schedule_override_store_writer', {
    trigger: { event: { data: { op: 'clear_all', who: {} }, context: { user_id: 'person' } } },
  });
  assert.deepEqual(invoked, [{ name: 'ls_commit', args: { data: { op: 'clear_all', who: 'person' } } }]);
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
test('lamp capture ignores contexts owned by running scripts', async () => {
  const { ctx, invoked } = await driver();
  ctx.state['script.running'] = {
    state: 'on', attributes: {}, context: { id: 'script-call' },
  };
  ctx.run('automation.lighting_schedule_lamp_change_detector', {
    trigger: { event: { data: { service: 'turn_on', service_data: { entity_id: 'light.a', brightness: 70 } },
      context: { id: 'script-call', user_id: 'person' } } },
  });
  assert.deepEqual(invoked, []);
  assert.deepEqual(ctx.events, []);
});
test('end-overrides never expires a stored record that is not a mapping, even at a zero limit', async () => {
  // The age test reads `when` only off a mapping record. A lenient record view
  // would read a missing `when` as "now", and age 0 >= limit 0 would expire it.
  const { ctx } = await driver();
  ctx.put('sensor.ls_overrides', '1', { overrides: { list: ['x'], text: 'x', nil: null, fresh: { when: ctx.now } } });
  ctx.put('input_boolean.ls_ovr_after_on', 'on'); ctx.put('input_number.ls_ovr_after_min', '0');
  ctx.run('automation.lighting_schedule_end_overrides', { trigger: { id: 'after' } });
  assert.deepEqual(ctx.events, [{ event: 'ls_override', data: { op: 'clear', keys: ['fresh'], via: 'rule_after' } }]);
});
test('writer forwards the event data with who replaced in place, keys in stored order', async () => {
  // `{...data, who}` keeps an existing `who` at its position; the bytes are compared.
  const { ctx, invoked } = await driver();
  ctx.run('automation.lighting_schedule_override_store_writer', {
    trigger: { event: { data: { who: 'ann', op: 'clear', keys: [{ nested: 1 }] }, context: { user_id: 'person' } } },
  });
  assert.equal(JSON.stringify(invoked), JSON.stringify([{ name: 'ls_commit', args: { data: { who: 'ann', op: 'clear', keys: [{ nested: 1 }] } } }]));
});
test('lamp capture raises on non-list records only after the power events were fired', async () => {
  const { ctx } = await driver();
  ctx.run = (orig => (name, args = {}) => name === 'effects_native_plan'
    ? { power: [{ area: 'studio' }, 'bare'], records: 'not a list' } : name.startsWith('automation.') ? orig(name, args) : {})(ctx.run);
  assert.throws(() => ctx.run('automation.lighting_schedule_lamp_change_detector', {
    trigger: { event: { data: { service: 'turn_on' }, context: { user_id: 'person' } } } }), /schedule list/);
  assert.deepEqual(ctx.events.map(e => e.data.area), ['studio', '']);
});
