import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { remotePress } from '../../src/parse/remote-input.ts';
import { pressCommand, pressText, REMOTE_COMMANDS } from '../../src/legacy/domain/remote-input.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { context } from './gestures-context.ts';

/**
 * Review round 3, item 3: a remote's press is a closed set of commands
 * (up/down/left/right/toggle/reset/sara_toggle); any other text does nothing,
 * as the scripts' noop. It is parsed once at the edge into that sum type.
 */

test('each command a remote acts on parses as that command', () => {
  // Break: a command is missing from the set, so its press reads as one that does nothing.
  assert.deepEqual(REMOTE_COMMANDS.map(text => pressCommand(remotePress(text))), [...REMOTE_COMMANDS]);
  assert.deepEqual([...REMOTE_COMMANDS].sort(), ['down', 'left', 'reset', 'right', 'sara_toggle', 'toggle', 'up']);
});

test('any other text is a press that does nothing, kept as its text', () => {
  // Break: an unknown press is matched loosely (case, spaces) or loses its text where it is forwarded.
  for (const text of ['double', 'UP', ' up', '', 'noop']) {
    const press = remotePress(text);
    assert.equal(pressCommand(press), undefined, JSON.stringify(text));
    assert.equal(pressText(press), text);
  }
  assert.equal(pressText(remotePress('left')), 'left');
});

test('ls_remote_command forwards an unknown press to ls_remote_plan as the text it was sent', () => {
  // Break: the forwarded request names the parsed value instead of the bytes the remote sent.
  const planned: JsonObject[] = [];
  const ctx = context({ ...controllerHandlers, ls_remote_plan: (_ctx, args) => {
    planned.push(structuredClone(args));
    return { op: 'noop', input_revision: 'r', received_at: 0, request_id: 'remote:0' };
  } });
  for (const command of ['double', 'up']) ctx.run('ls_remote_command', { source: 'remote', area: 'studio', command });
  assert.deepEqual(planned, [{ source: 'remote', area: 'studio', command: 'double' }, { source: 'remote', area: 'studio', command: 'up' }]);
});
