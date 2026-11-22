import assert from 'node:assert/strict';
import test from 'node:test';
import { controlEffects } from '../../src/handlers/native-controls.ts';
import type { ControlPlan } from '../../src/domain/native-controls.ts';

const plan = (fields: Partial<ControlPlan>): ControlPlan => ({ valid: true, errors: [], events: [], commands: [], records: [], ...fields });

test('a control plan fires its override events first, then performs its commands in order', () => {
  const effects = [...controlEffects(plan({
    events: [{ op: 'power', area: 'studio', on: true, via: 'effects-house' }],
    commands: [
      { action: 'light.turn_on', target: { entity_id: 'light.a' }, data: { brightness: 10 } },
      { action: 'script.ls_store', data: { store: 'input_text.ls_lamp_a', effect: 'Candle' }, target: {} },
    ],
  }))];
  assert.deepEqual(effects, [
    { kind: 'event', event: 'ls_override', data: { op: 'power', area: 'studio', on: true, via: 'effects-house' } },
    { kind: 'service', service: 'light.turn_on', data: { brightness: 10 }, target: { entity_id: 'light.a' } },
    { kind: 'script', name: 'ls_store', args: { store: 'input_text.ls_lamp_a', effect: 'Candle' } },
  ]);
});

test('an invalid plan performs nothing and raises its errors, joined', () => {
  assert.throws(() => [...controlEffects(plan({ valid: false, errors: ['bad one.', 'bad two.'] }))], /^Error: bad one\. bad two\.$/);
});
