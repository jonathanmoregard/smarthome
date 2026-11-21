import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { remoteInputHandlers } from '../../src/handlers/remote-input.ts';
import { recordTimestamp } from '../../src/parse/resolution.ts';
import { context } from './gestures-context.ts';

/**
 * A remote's input record leaves the planner as a document: its `key` is the
 * saved key text and its `target` the room, in `ls_remote_plan`'s answer, in
 * `ls_remote_command`'s dry-run answer and in the data it commits. Inside the
 * port the key is an overlay key and the target a room; these pin the bytes.
 */

const NOW = '2026-10-26T12:00:00+01:00';
const STAMP = recordTimestamp(NOW);
const record = {
  kind: 'input', key: 'channels:remote', source: 'remote', scope: 'room', target: 'studio', value: {
    step_range: { min: -20, max: 20 },
    adjustment: { steps: 1, lower: -19, upper: 20, anchor: 'current', updated: STAMP, last: 'up', has_up: true },
  },
};
const answer = { op: 'set', records: [record], via: 'remote', input_revision: NOW, received_at: STAMP, request_id: `remote:${STAMP}` };

function house(commits: JsonObject[] = []) {
  const ctx = context({ ...controllerHandlers, ...remoteInputHandlers,
    ls_commit: (_ctx, args) => { commits.push(structuredClone(args)); return { accepted: true, revision: 'r', committed_at: 0 }; } });
  ctx.now = NOW;
  ctx.areas = { 'light.studio': 'studio' };
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  return ctx;
}

test("ls_remote_plan answers its input record's key as saved text and its target as the room", () => {
  assert.deepEqual(house().run('ls_remote_plan', { source: 'remote', area: 'studio', command: 'up' }), answer);
});

test("ls_remote_command's dry run answers the same document", () => {
  assert.deepEqual(house().run('ls_remote_command', { source: 'remote', area: 'studio', command: 'up', dry_run: true }), answer);
});

test('ls_remote_command commits the record with its key as saved text', () => {
  const commits: JsonObject[] = [];
  house(commits).run('ls_remote_command', { source: 'remote', area: 'studio', command: 'up' });
  assert.deepEqual(commits, [{ data: { ...answer, expected_revision: NOW, area: 'studio', via: 'remote', source: 'remote' } }]);
  const data = commits[0]?.data;
  assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data));
  assert.deepEqual(Object.keys(data), ['op', 'records', 'via', 'input_revision', 'received_at', 'request_id',
    'expected_revision', 'area', 'source']);
});
