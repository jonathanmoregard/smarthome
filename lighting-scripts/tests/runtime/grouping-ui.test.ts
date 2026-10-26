import assert from 'node:assert/strict';
import test from 'node:test';
import { context } from './gestures-context.ts';

async function load() {
  const modulePath = '../../src/domain/ui-state.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.uiHandlers?.effects_ui_sync, 'function', 'UI mirror exists');
  return context(port.uiHandlers);
}
function row(source: string, members = [source]) {
  return { source, proxy: 'light.ep_test', members, store: '', topics: Object.fromEntries(['availability', 'power', 'effect', 'brightness', 'temperature', 'rgb'].map(k => [k, `test/${k}`])) };
}

test('UI mirror uses logical room level and Sara color in ordered dry output', async () => {
  const ctx = await load();
  ctx.catalog = { ui_rows: [row('light.studio_all', ['light.a', 'light.b'])] };
  ctx.areas = { 'light.a': 'studio', 'light.b': 'studio' };
  ctx.put('light.studio_all', 'on', { brightness: 20, color_mode: 'color_temp', color_temp_kelvin: 3000 });
  ctx.put('sensor.ls_effects_runtime', '2', { targets: { 'room:studio': { level: 123, color: { kind: 'constant', value: { rgb: [255, 105, 180] } } } } });
  assert.deepEqual(ctx.run('effects_ui_sync', { dry_run: true, force: true }), { messages: [
    { topic: 'test/availability', payload: 'online' }, { topic: 'test/power', payload: 'ON' },
    { topic: 'test/effect', payload: 'Normal Light' }, { topic: 'test/brightness', payload: '123' }, { topic: 'test/rgb', payload: '255,105,180' },
  ] });
  assert.deepEqual(ctx.calls, []);
});

test('UI mirror suppresses unchanged messages and mixed effect ownership is blank', async () => {
  const ctx = await load();
  ctx.catalog = { ui_rows: [row('light.group', ['light.a', 'light.b'])] };
  ctx.put('light.group', 'on', { brightness: 20, color_mode: 'rgb', rgb_color: [1, 2, 3] });
  ctx.put('light.ep_test', 'on', { effect: '', brightness: 20, color_mode: 'rgb', rgb_color: [1, 2, 3] });
  ctx.put('sensor.ls_effects_runtime', '2', { targets: { 'light.a': { brightness: { kind: 'effect', effect: 'Candle' }, level: 10 }, 'light.b': { color: { kind: 'effect', effect: 'Colour loop' }, level: 30 } } });
  assert.deepEqual(ctx.run('effects_ui_sync', { dry_run: true }), { messages: [] });
});

test('range save validates physical devices, rejects boolean ranges, and emits only the config event', async () => {
  const ctx = await load();
  ctx.put('switch.new_lamp', 'off'); ctx.areas['switch.new_lamp'] = 'studio'; ctx.devices = { physical_device: ['switch.new_lamp'] };
  assert.deepEqual(ctx.run('ls_range_save', { entity: 'switch.new_lamp', profile: 'custom', minimum: true, maximum: 80, dry_run: true }), {
    valid: false, errors: ['Enter both ends of Own Range: 0–100%, with From no higher than Through.'], entity: 'switch.new_lamp', config: { profile: 'custom' },
  });
  const result = ctx.run('ls_range_save', { entity: 'switch.new_lamp', profile: 'custom', minimum: 30, maximum: 60 });
  assert.equal(result.valid, true);
  assert.deepEqual(ctx.events, [{ event: 'ls_override', data: { op: 'range_set', entity: 'switch.new_lamp', profile: 'custom', min: 30, max: 60, via: 'schedule-ui' } }]);
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.get('switch.new_lamp'), 'off');
});
