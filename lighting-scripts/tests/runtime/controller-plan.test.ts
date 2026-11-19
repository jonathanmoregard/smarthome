import assert from 'node:assert/strict';
import test from 'node:test';
import { planAnswer } from '../../src/domain/controller.ts';
import type { ScheduleEnvelope } from '../../src/domain/schedule.ts';
import { recordTimestamp } from '../../src/parse/resolution.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { house } from './house-view.ts';

const NOW = '2026-10-26T12:00:00+01:00';
const REVISION = '2026-10-26T11:00:00+00:00';
const schedule: ScheduleEnvelope = {
  cmds: [], profiles: {}, revision: 'schedule revision', stale_keys: [], sched: {}, schedule_details: {}, mirror: [], sara_mirror: 'off',
};
const parts = (active: Record<string, ReturnType<typeof carry>>, reason = 'tick') => ({
  schedule, base: {}, resolved: { targets: {}, assignments: {} }, gradients: {}, switches: {}, active, reason,
});

test('the plan overwrites the schedule\'s revision and Sara mirror, and stamps its order from now', () => {
  const view = house({ 'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: REVISION }, 'input_boolean.ls_sara_mode_mirror': 'off' });
  const { plan } = planAnswer(view, parts({ 'mode:sara': carry({}) }, 'remote'));
  assert.deepEqual([plan.revision, plan.plan_order, plan.remote, plan.sara_mirror], [REVISION, recordTimestamp(NOW), true, 'on']);
  assert.deepEqual(Object.keys(plan), ['cmds', 'profiles', 'revision', 'stale_keys', 'sched', 'schedule_details', 'mirror', 'sara_mirror',
    'base', 'resolved', 'gradients', 'switches', 'plan_order', 'remote']);
});

test('a Sara mirror already showing the wanted state asks for nothing', () => {
  const view = house({ 'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: REVISION }, 'input_boolean.ls_sara_mode_mirror': 'off' });
  assert.equal(planAnswer(view, parts({})).plan.sara_mirror, null);
});

test('an overrides sensor with no last_updated raises at the revision read', () => {
  assert.throws(() => planAnswer(house({ 'sensor.ls_overrides': '0' }), parts({})), /ls_plan\.revision/);
});
