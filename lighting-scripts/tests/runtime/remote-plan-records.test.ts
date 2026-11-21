import assert from 'node:assert/strict';
import test from 'node:test';
import { resultCodecs } from '../../src/parse/results.ts';
import { SARA_MODE } from '../../src/domain/types/overlay.ts';

/*
 * Review round 2, item 4: what `ls_remote_plan` answers, as the port holds it
 * and as its JSON edge reads it back. A clear names overlay keys.
 *
 * The decoder is the JSON edge for an answer to `ls_remote_plan` (a stub); the
 * real handler is typed, and the bytes it writes are pinned in
 * `remote-record-wire.test.ts`.
 */

const decode = resultCodecs.ls_remote_plan.decode;
const envelope = { input_revision: 'revision', received_at: 0, request_id: 'remote:0' };

test('a clear decodes its keys as overlay keys, and leaves as their saved text', () => {
  // Break: the keys stay text, so the plan holds 'mode:sara' where it names Sara mode.
  const document = { op: 'clear', keys: ['mode:sara'], via: 'remote', ...envelope };
  const plan = decode?.(document, 'ls_remote_plan');
  assert.ok(plan?.op === 'clear');
  assert.deepEqual(plan.keys, [SARA_MODE]);
  assert.deepEqual(resultCodecs.ls_remote_plan.encode(plan), document);
});
