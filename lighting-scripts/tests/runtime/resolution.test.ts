import assert from 'node:assert/strict';
import test from 'node:test';

// A changed interpolation branch or JS Math.round replacing Python round breaks these literals.
test('scale preserves low anchors, clamps tails, and rounds RGB halves to even', async () => {
  const modulePath = '../../src/domain/scale.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.scaleValue, 'function', 'the pure scale implementation is available');
  const day = { brightness: 220, color: { rgb: [10, 21, 30] } };
  const cosy = { brightness: 20, color: { rgb: [1, 2, 3] } };
  assert.deepEqual(port.scaleValue(day, cosy, 0.5), { brightness: 120, color: { rgb: [6, 12, 16] }, position: 0.5 });
  assert.deepEqual(port.scaleValue(day, cosy, -9), { brightness: 20, color: { rgb: [255, 126, 0] }, position: -2 });
});

test('new invalid channel cancels its old effect without replacing the other channel', async () => {
  const modulePath = '../../src/domain/resolution.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.resolveEffects, 'function', 'the pure resolver is available');
  const result = port.resolveEffects({
    base: { lamp: { area: 'living', period: 'cosy', brightness: 110, color: { kelvin: 2200 } } },
    catalog: { effects: { Pulse: { channels: ['brightness'] } } },
    overrides: {
      old: { kind: 'channels', scope: 'lamp', target: 'lamp', value: { channels: { brightness: { kind: 'effect', effect: 'Pulse', instance: 'pulse', updated: 1 } } } },
      newer: { kind: 'channels', scope: 'lamp', target: 'lamp', value: { channels: { brightness: { kind: 'constant', value: true, updated: 2 } } } },
    },
  });
  assert.deepEqual(result.targets.lamp.brightness, { kind: 'constant', value: 110, updated: 2, origin: 'invalid_source' });
  assert.deepEqual(result.targets.lamp.color, { kind: 'constant', value: { kelvin: 2200 }, updated: -1 });
  assert.deepEqual(result.assignments, {});
});

test('malformed cached gradient is rebuilt while a valid cached curve retains its values', async () => {
  const modulePath = '../../src/domain/gradient.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.planGradients, 'function', 'the gradient planner is available');
  const base = { lamp: { day: { brightness: 220, color: { kelvin: 4000 } }, cosy: { brightness: 110, color: { kelvin: 2200 } } } };
  const first = port.planGradients({ base });
  assert.deepEqual(first.gradients.lamp.curve.brightness, { floor: 76.5, lower: 110, middle: 110, upper: 35 });
  assert.deepEqual(port.sampleGradient(first.gradients.lamp.curve, 0.5), { brightness: 165, color: { kelvin: 3100 }, position: 0.5 });
  const broken = structuredClone(first.gradients);
  broken.lamp.curve.colors.middle.start = 'bad';
  assert.deepEqual(port.planGradients({ base, cached: broken }), first);
  assert.deepEqual(port.planGradients({ base, cached: first.gradients }), first);
});

test('room input uses its logical level across lamp profiles and down never brightens a dim Night', async () => {
  const { resolveEffects } = await import('../../src/domain/resolution.ts');
  const item = { area: 'living', period: 'night', brightness: 3, color: { kelvin: 2200 }, day: { brightness: 220, color: { kelvin: 4000 } }, cosy: { brightness: 110, color: { kelvin: 2200 } } };
  const args = { base: { 'room:living': { ...item, is_room: true }, lamp: { ...item, day: { brightness: 180, color: { kelvin: 4000 } }, cosy: { brightness: 90, color: { kelvin: 2200 } } } }, catalog: { effects: {} }, overrides: { remote: { kind: 'input', scope: 'room', target: 'living', when: '2026-10-26T23:35:00+01:00', value: { adjustment: { steps: -1, lower: -20, upper: 20, last: 'down', anchor: 'current', updated: 1 } } } } };
  const result = resolveEffects(args);
  assert.equal(result.targets['room:living']!.level, 3);
  assert.equal(result.targets.lamp!.level, 3);
  args.overrides.remote.value.adjustment = { ...args.overrides.remote.value.adjustment, steps: 1, last: 'up' };
  const raised = resolveEffects(args);
  assert.equal(raised.targets['room:living']!.level, 76.5);
  assert.equal(raised.targets.lamp!.brightness.position, raised.targets['room:living']!.brightness.position);
});

test('nonfinite and boolean channel claims are invalid, while Candle stays on its designated lamp', async () => {
  const { resolveEffects } = await import('../../src/domain/resolution.ts');
  const item = { area: 'living', period: 'cosy', brightness: 110, color: { kelvin: 2200 } };
  for (const value of [NaN, Infinity, -Infinity, true]) {
    const result = resolveEffects({ base: { lamp: item }, catalog: {}, overrides: { invalid: { kind: 'channels', scope: 'lamp', target: 'lamp', value: { channels: { brightness: { kind: 'constant', value } } } } } });
    assert.equal(result.targets.lamp!.brightness.origin, 'invalid_source');
    assert.equal(result.targets.lamp!.level, 110);
  }
  const result = resolveEffects({ base: { lamp: item, 'light.living_room_yellow_retro_lamp': item }, catalog: { effects: { Candle: { channels: ['brightness'] } } }, overrides: { candle: { kind: 'channels', scope: 'room', target: 'living', value: { channels: { brightness: { kind: 'effect', effect: 'Candle', instance: 'shared' } } } } } });
  assert.equal(result.targets.lamp!.brightness.kind, 'constant');
  assert.equal(result.targets['light.living_room_yellow_retro_lamp']!.brightness.instance, 'shared');
});

test('explicit null input bounds are rejected instead of being replaced with defaults', async () => {
  const { resolveEffects } = await import('../../src/domain/resolution.ts');
  const item = { area: 'living', period: 'day', brightness: 220, color: { kelvin: 4000 }, day: { brightness: 220, color: { kelvin: 4000 } }, cosy: { brightness: 110, color: { kelvin: 2200 } } };
  const result = resolveEffects({ base: { lamp: item }, catalog: {}, overrides: { remote: { kind: 'input', scope: 'room', target: 'living', value: { step_range: null, adjustment: { steps: -5, lower: -20, upper: 20, updated: 1 } } } } });
  assert.equal(result.targets.lamp!.level, 220);
  assert.equal(result.targets.lamp!.owners.brightness, 'base');
});

test('record timestamps retain microseconds so newest remote snapshots win within a millisecond', async () => {
  const { latestRemoteKey, recordTimestamp } = await import('../../src/domain/resolution.ts');
  assert.equal(recordTimestamp('2026-10-26T12:00:00.000001+01:00'), 1793012400.000001);
  assert.equal(latestRemoteKey({ z: { kind: 'input', scope: 'room', target: 'living', when: '2026-10-26T12:00:00.000001+01:00' }, a: { kind: 'input', scope: 'room', target: 'living', when: '2026-10-26T12:00:00.000002+01:00' } }, 'living'), 'a');
});
