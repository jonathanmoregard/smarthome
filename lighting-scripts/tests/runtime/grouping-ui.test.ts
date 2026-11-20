import assert from 'node:assert/strict';
import test from 'node:test';
import { context, setCatalog } from './gestures-context.ts';

async function load() {
  const modulePath = '../../src/handlers/ui-state.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.uiHandlers?.effects_ui_sync, 'function', 'UI mirror exists');
  return context({ ...port.uiHandlers, effects_catalog: ctx => ctx.rawCatalog() });
}
function row(source: string, members = [source]) {
  return { source, proxy: 'light.ep_test', members, store: '', topics: Object.fromEntries(['availability', 'power', 'effect', 'brightness', 'temperature', 'rgb'].map(k => [k, `test/${k}`])) };
}

test('UI mirror uses logical room level and Sara color in ordered dry output', async () => {
  const ctx = await load();
  setCatalog(ctx, { ui_rows: [row('light.studio_all', ['light.a', 'light.b'])] });
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
  setCatalog(ctx, { ui_rows: [row('light.group', ['light.a', 'light.b'])] });
  ctx.put('light.group', 'on', { brightness: 20, color_mode: 'rgb', rgb_color: [1, 2, 3] });
  ctx.put('light.ep_test', 'on', { effect: '', brightness: 20, color_mode: 'rgb', rgb_color: [1, 2, 3] });
  ctx.put('sensor.ls_effects_runtime', '2', { targets: { 'light.a': { brightness: { kind: 'effect', effect: 'Candle' }, level: 10 }, 'light.b': { color: { kind: 'effect', effect: 'Colour loop' }, level: 30 } } });
  assert.deepEqual(ctx.run('effects_ui_sync', { dry_run: true }), { messages: [] });
});

test('UI force accepts only a real optional boolean', async () => {
  const ctx = await load();
  setCatalog(ctx, { ui_rows: [row('light.group')] });
  ctx.put('light.group', 'on', { brightness: 20 });
  for (const force of [null, [], {}, 0, '', 'false']) {
    assert.throws(() => ctx.run('effects_ui_sync', { dry_run: true, force }), /must be true or false/,
      `force ${JSON.stringify(force)} must be rejected, not coerced`);
  }
});

test('UI catalog and row fields distinguish absence from malformed present values', async () => {
  const ctx = await load();
  setCatalog(ctx, { ui_rows: [{ ...row('light.group'), store: null }] });
  ctx.put('light.group', 'on');
  assert.throws(() => ctx.run('effects_ui_sync', { dry_run: true }), /store.*string/);

  setCatalog(ctx, { ui_discovery: [], ui_choices: null });
  assert.throws(() => ctx.run('effects_ui_catalog'), /ui_choices.*array/);
});

test('stored UI profiles read effect_channels and effect leniently', async () => {
  const ctx = await load();
  setCatalog(ctx, { ui_rows: [{ ...row('light.group'), store: 'input_text.profile' }] });
  ctx.put('light.group', 'on');
  // A null `effect_channels` is Jinja-falsy: no effect channels, so the effect is never read (review 2, R2).
  ctx.put('input_text.profile', JSON.stringify({ effect_channels: null, effect: null }));
  const result = ctx.run('effects_ui_sync', { dry_run: true, force: true }) as { messages: { topic: string; payload: string }[] };
  assert.equal(result.messages.find(message => message.topic === 'test/effect')?.payload, 'Normal Light');
  // A null `effect` with truthy channels is a saved value: it takes the 'Normal light' default.
  ctx.put('input_text.profile', JSON.stringify({ effect_channels: ['color'], effect: null }));
  const lenient = ctx.run('effects_ui_sync', { dry_run: true, force: true }) as { messages: { topic: string; payload: string }[] };
  assert.equal(lenient.messages.find(message => message.topic === 'test/effect')?.payload, 'Normal Light');
});

test('range save reads an explicit null bound as the saved one and rejects malformed typed fields', async () => {
  const ctx = await load();
  ctx.put('switch.new_lamp', 'off');
  ctx.areas['switch.new_lamp'] = 'studio';
  ctx.devices = { physical_device: ['switch.new_lamp'] };
  ctx.put('sensor.ls_overrides', '0', { switch_ranges: { 'switch.new_lamp': { profile: 'custom', min: 30, max: 60 } } });
  // Captured `minimum if minimum is defined and minimum is not none else saved.get('min')`.
  const explicitNull = ctx.run('ls_range_save', { entity: 'switch.new_lamp', profile: 'custom', minimum: null, maximum: 60, dry_run: true });
  assert.equal(explicitNull.valid, true);
  assert.deepEqual(explicitNull.config, { profile: 'custom', min: 30, max: 60 });
  assert.throws(() => ctx.run('ls_range_save', { entity: null, dry_run: true }), /entity.*string/);
  assert.throws(() => ctx.run('ls_range_save', { entity: 'switch.new_lamp', profile: null, dry_run: true }), /profile.*string/);
  assert.throws(() => ctx.run('ls_range_save', { entity: 'switch.new_lamp', dry_run: [] }), /dry_run.*true or false/);
});

test('range save reads a Jinja-falsy supported_color_modes as no modes: not an on/off lamp', async () => {
  const ctx = await load();
  ctx.put('light.new_lamp', 'off', { supported_color_modes: false });
  ctx.areas['light.new_lamp'] = 'studio';
  ctx.devices = { physical_device: ['light.new_lamp'] };
  const result = ctx.run('ls_range_save', { entity: 'light.new_lamp', dry_run: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('Choose an on/off lamp; dimmable lamps use the normal lighting settings.'));
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

test('range save keeps Own Range only for two numbers 0..100 with From not above Through', async () => {
  // Break: the Own Range check (now `ownRange` at the parse edge) admits a reversed, out-of-range or
  // non-numeric pair, refuses equal or edge ends, or stops falling back to the saved end.
  const ctx = await load();
  ctx.put('switch.new_lamp', 'off'); ctx.areas['switch.new_lamp'] = 'studio'; ctx.devices = { physical_device: ['switch.new_lamp'] };
  const save = (minimum: unknown, maximum: unknown) => ctx.run('ls_range_save', { entity: 'switch.new_lamp', profile: 'custom', minimum, maximum, dry_run: true }).config;
  for (const [low, high] of [[60, 30], [-1, 50], [10, 101], ['10', 50], [10, false], [null, 50]]) assert.deepEqual(save(low, high), { profile: 'custom' }, `${low}..${high}`);
  assert.deepEqual(save(0, 100), { profile: 'custom', min: 0, max: 100 });
  assert.deepEqual(save(40, 40), { profile: 'custom', min: 40, max: 40 });
  assert.deepEqual(save(12.5, 80), { profile: 'custom', min: 12.5, max: 80 });
  ctx.put('sensor.ls_overrides', '1', { switch_ranges: { 'switch.new_lamp': { profile: 'custom', min: 20, max: 70 } } });
  assert.deepEqual(save(null, 50), { profile: 'custom', min: 20, max: 50 });
});

test('a constant colour with a non-numeric kelvin wins over its rgb and mirrors the lamp\'s own rgb', async () => {
  // `'kelvin' in display` takes the colour-temperature branch before the number
  // test, replacing the lamp's kelvin and leaving its rgb. A colour view that
  // dropped the non-numeric kelvin would publish the display's rgb (9,9,9) or
  // the lamp's 3000 K instead.
  const ctx = await load();
  setCatalog(ctx, { ui_rows: [row('light.group')] });
  ctx.put('light.group', 'on', { brightness: 20, color_mode: 'rgb', rgb_color: [1, 2, 3], color_temp_kelvin: 3000 });
  ctx.put('sensor.ls_effects_runtime', '2', { targets: { 'light.group': { color: { kind: 'constant', value: { kelvin: '2700', rgb: [9, 9, 9] } } } } });
  assert.deepEqual(ctx.run('effects_ui_sync', { dry_run: true, force: true }).messages.slice(3), [
    { topic: 'test/brightness', payload: '20' }, { topic: 'test/rgb', payload: '1,2,3' },
  ]);
});

test('UI discovery republishes the stored config with effect_list replaced in place', async () => {
  // The payload is `{...config, effect_list}` serialised: an existing key keeps its position.
  const ctx = await load();
  setCatalog(ctx, { ui_choices: ['Normal Light', 'Breathe'], ui_discovery: [
    { entity: 'light.ep_a', config: { unique_id: 'ep_a', effect_list: ['old'], name: 'A' } },
    { entity: 'light.ep_b', config: { name: 'B' } },
  ] });
  ctx.put('light.ep_b', 'on', { effect_list: ['Normal Light', 'Breathe'] });
  ctx.run('effects_ui_catalog');
  assert.deepEqual(ctx.calls.map(c => [c.data.topic, c.data.payload]), [
    ['homeassistant/light/ep_a/config', '{"unique_id":"ep_a","effect_list":["Normal Light","Breathe"],"name":"A"}'],
  ]);
});
