import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteCommandStart, remoteCommandStep } from '../../src/domain/controller.ts';
import type { RemoteCommandPhase } from '../../src/domain/controller.ts';
import type { RemotePlanResult } from '../../src/domain/remote-input.ts';

const input = { source: 'remote', area: 'studio', command: 'toggle' };
const envelope = { input_revision: 'r1', received_at: 1, request_id: 'remote:1' };
const noop: RemotePlanResult = { op: 'noop', ...envelope };
const powerOn: RemotePlanResult = { op: 'power', area: 'studio', on: true, targets: ['light.a', 'switch.b'], via: 'remote', ...envelope };
const powerOff: RemotePlanResult = { ...powerOn, on: false };
const reset: RemotePlanResult = { op: 'clear_room', area: 'studio', via: 'remote', ...envelope };
const planning = (attempt: number): RemoteCommandPhase => ({ tag: 'planning', input, dryRun: false, attempt });
const committing = (attempt: number, plan: RemotePlanResult): RemoteCommandPhase => ({ tag: 'committing', input, attempt, plan });

test('a command opens by asking ls_remote_plan', () => {
  const phase = remoteCommandStart({ ...input, dryRun: false });
  assert.deepEqual(remoteCommandStep(phase, { tag: 'start' }), [planning(0), [{ tag: 'plan', input }]]);
});

test('a dry run answers the first plan and commits nothing', () => {
  const [phase] = remoteCommandStep(remoteCommandStart({ ...input, dryRun: true }), { tag: 'start' });
  assert.deepEqual(remoteCommandStep(phase, { tag: 'planned', result: powerOn }), [{ tag: 'done', answer: powerOn }, []]);
});

test('a noop plan is accepted without a commit', () => {
  assert.deepEqual(remoteCommandStep(planning(0), { tag: 'planned', result: noop }), [{ tag: 'done', answer: null }, []]);
});

test('any other plan is committed against the revision it was planned at, in the captured key order', () => {
  const [phase, cmds] = remoteCommandStep(planning(3), { tag: 'planned', result: reset });
  assert.deepEqual(phase, committing(3, reset));
  assert.deepEqual(cmds, [{ tag: 'commit', data: { ...reset, expected_revision: 'r1', area: 'studio', via: 'remote', source: 'remote' } }]);
  const commit = cmds[0];
  assert.ok(commit !== undefined && commit.tag === 'commit');
  assert.deepEqual(Object.keys(commit.data), ['op', 'area', 'via', 'input_revision', 'received_at', 'request_id', 'expected_revision', 'source']);
});

test('a rejected commit plans again, until the thousandth', () => {
  assert.deepEqual(remoteCommandStep(committing(0, reset), { tag: 'committed', accepted: false }), [planning(1), [{ tag: 'plan', input }]]);
  assert.deepEqual(remoteCommandStep(committing(998, reset), { tag: 'committed', accepted: false }), [planning(999), [{ tag: 'plan', input }]]);
  assert.deepEqual(remoteCommandStep(committing(999, reset), { tag: 'committed', accepted: false }), [{ tag: 'exhausted' }, []]);
});

test('an accepted power-on switches the targets on, then applies them as a lamp-on render', () => {
  assert.deepEqual(remoteCommandStep(committing(0, powerOn), { tag: 'committed', accepted: true }), [{ tag: 'done', answer: null }, [
    { tag: 'effect', effect: { kind: 'service', service: 'homeassistant.turn_on', data: {}, target: { entity_id: ['light.a', 'switch.b'] } } },
    { tag: 'effect', effect: { kind: 'script', name: 'ls_apply', args: { reason: 'lamp_on', lights: ['light.a', 'switch.b'] } } },
  ]]);
});

test('an accepted power-off only switches the targets off; any other accepted plan does nothing more', () => {
  assert.deepEqual(remoteCommandStep(committing(0, powerOff), { tag: 'committed', accepted: true }), [{ tag: 'done', answer: null }, [
    { tag: 'effect', effect: { kind: 'service', service: 'homeassistant.turn_off', data: {}, target: { entity_id: ['light.a', 'switch.b'] } } },
  ]]);
  assert.deepEqual(remoteCommandStep(committing(0, reset), { tag: 'committed', accepted: true }), [{ tag: 'done', answer: null }, []]);
});

test('a message the phase does not expect is a defect, not a silent stall', () => {
  assert.throws(() => remoteCommandStep(planning(0), { tag: 'committed', accepted: true }), /ls_remote_command.*planning.*committed/);
});
