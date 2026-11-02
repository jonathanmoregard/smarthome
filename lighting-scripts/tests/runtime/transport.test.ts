import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { Snapshot } from '../../src/runtime/context.ts';

const revision = '2026-10-26T12:00:00+01:00';
const assignment = (area: string) => ({
  area, on: true, brightness: { kind: 'effect', effect: 'Candle' },
  color: { kind: 'constant', value: { kelvin: 3000 } },
});

test('effects release removes selected assignments and reapplies the remainder', () => {
  const first = assignment('first'), second = assignment('second');
  const snapshot: Snapshot = {
    now: revision, areas: {}, members: [], catalog: { members: {} },
    state: {
      'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: revision },
      'sensor.ls_effects_runtime': { state: '0', attributes: {
        assignments: { 'light.first': first, 'light.second': second },
        targets: { 'light.first': first, 'light.second': second },
        revision, generation: 'old', plan_order: 1,
      } },
    },
  };

  const result = execute({ script: 'effects_release', args: { targets: ['light.first'] }, snapshot }, handlers);

  assert.deepEqual(result.snapshot.state['sensor.ls_effects_runtime'].attributes.assignments, { 'light.second': second });
  assert.deepEqual(result.snapshot.state['sensor.ls_effects_runtime'].attributes.targets, { 'light.second': second });
  assert.equal(result.calls.at(-1)?.service, 'script.turn_on');
});
