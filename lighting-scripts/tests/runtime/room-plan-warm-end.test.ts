import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonValue, Snapshot } from '../../src/runtime/context.ts';

// `ls_room_plan` reads the warm end as
// `(state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0])|list`
// (reference/live/scripts/ls_room_plan.json): Jinja's `or`, so Home Assistant's
// null (no colour) or any other falsy value takes the default, and only then
// `|list`. The plan must not raise on them; the default is what reaches the
// gradient plan and the resolver.

const now = '2026-10-26T12:00:00.000Z';

function snapshot(warmEnd: JsonValue | undefined): Snapshot {
  return { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio' },
    catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' }, multicast: [], effects: {} },
    state: {
      'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: now },
      'light.candle_test_rgb_warm_end': { state: 'on', attributes: warmEnd === undefined ? {} : { rgb_color: warmEnd } },
      'light.lamp': { state: 'on', attributes: {} },
    } };
}

function warmEndsSent(warmEnd: JsonValue | undefined): JsonValue[] {
  const seen: JsonValue[] = [];
  execute({ script: 'ls_room_plan', args: { room: 'studio' }, snapshot: snapshot(warmEnd) }, handlers, {
    beforeScript: (name, args) => {
      if (name === 'effects_gradient_plan' || name === 'effects_resolve') seen.push(args.warm_end ?? 'missing');
    },
  });
  return seen;
}

for (const [label, warmEnd] of [['null', null], ['absent', undefined], ['[]', []], ['{}', {}], ['0', 0], ['""', '']] as const) {
  test(`ls_room_plan: a ${label} warm end takes the default 255,126,0`, () => {
    assert.deepEqual(warmEndsSent(warmEnd), [[255, 126, 0], [255, 126, 0]]);
  });
}

test('ls_room_plan: a set warm end is carried as its list', () => {
  assert.deepEqual(warmEndsSent([200, 100, 10]), [[200, 100, 10], [200, 100, 10]]);
});
