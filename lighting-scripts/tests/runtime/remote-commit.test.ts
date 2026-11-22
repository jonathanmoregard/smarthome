import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedPowerSwitch, remoteCommit } from '../../src/domain/controller.ts';
import type { RemotePlan } from '../../src/domain/remote-input.ts';

/**
 * The pure parts of `ls_remote_command`: the record a plan is committed as,
 * and what an accepted plan switches. The loop that plans, commits and
 * retries is driven end to end in `remote-command-loop.test.ts`.
 */

const command = { source: 'remote', area: 'studio', command: 'toggle', dryRun: false };
const envelope = { input_revision: 'r1', received_at: 1, request_id: 'remote:1' };
const noop: RemotePlan = { op: 'noop', ...envelope };
const powerOn: RemotePlan = { op: 'power', area: 'studio', on: true, targets: ['light.a', 'switch.b'], via: 'remote', ...envelope };
const powerOff: RemotePlan = { ...powerOn, on: false };
const reset: RemotePlan = { op: 'clear_room', area: 'studio', via: 'remote', ...envelope };

test('a plan is committed against the revision it was planned at, in the captured key order', () => {
  const data = remoteCommit(reset, command);
  assert.deepEqual(data, { ...reset, expected_revision: 'r1', area: 'studio', via: 'remote', source: 'remote' });
  assert.deepEqual(Object.keys(data), ['op', 'area', 'via', 'input_revision', 'received_at', 'request_id', 'expected_revision', 'source']);
});

test('an accepted power-on switches the targets on and renders them; a power-off only switches them off', () => {
  assert.deepEqual(acceptedPowerSwitch(powerOn), { tag: 'on_then_render', targets: ['light.a', 'switch.b'] });
  assert.deepEqual(acceptedPowerSwitch(powerOff), { tag: 'off', targets: ['light.a', 'switch.b'] });
});

test('any other accepted plan switches nothing', () => {
  assert.equal(acceptedPowerSwitch(reset), undefined);
  assert.equal(acceptedPowerSwitch(noop), undefined);
});
