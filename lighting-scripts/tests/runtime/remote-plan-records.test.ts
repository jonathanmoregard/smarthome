import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { resultCodecs } from '../../src/parse/results.ts';
import { ParseError } from '../../src/runtime/parse.ts';
import { SARA_MODE } from '../../src/domain/types/overlay.ts';

/*
 * Review round 2, items 3, 4 and 8: what `ls_remote_plan` answers, as the
 * port holds it and as its JSON edge reads it back.
 *
 * - A mode record is only ever Sara mode switched on (`sara_toggle`, the one
 *   producer; switching it off is a `clear`), so its target and value are
 *   those literals and nothing else decodes.
 * - A clear names overlay keys.
 * - An input record's key is its source's key (`channels:<source>`), derived,
 *   so a record whose key names anything else does not decode.
 *
 * The decoder is the JSON edge for an answer to `ls_remote_plan` (a stub); the
 * real handler is typed, and the bytes it writes are pinned in
 * `remote-record-wire.test.ts`.
 */

const decode = resultCodecs.ls_remote_plan.decode;
const envelope = { input_revision: 'revision', received_at: 0, request_id: 'remote:0' };
const set = (record: JsonObject): JsonObject => ({ op: 'set', records: [record], via: 'remote', ...envelope });
const INPUT = { kind: 'input', key: 'channels:r', source: 'r', scope: 'room', target: 'studio', value: {} };
const refused = (pattern: RegExp) => (error: unknown) => error instanceof ParseError && pattern.test(error.message);

test('a Sara mode record decodes, and leaves as the same document', () => {
  const document = set({ kind: 'mode', target: 'sara', value: 'on' });
  const plan = decode?.(document, 'ls_remote_plan');
  assert.ok(plan !== undefined);
  assert.deepEqual(resultCodecs.ls_remote_plan.encode(plan), document);
});

test('a mode record for anything but Sara mode switched on is refused', () => {
  // Break: the decoder reads target and value as any text, so a mode no producer writes decodes.
  for (const [record, pattern] of [
    [{ kind: 'mode', target: 'house', value: 'on' }, /records\.0\.target must be "sara", got "house"/],
    [{ kind: 'mode', target: 'sara', value: 'off' }, /records\.0\.value must be "on", got "off"/],
    [{ kind: 'mode', target: 'sara', value: 'maybe' }, /records\.0\.value must be "on", got "maybe"/],
  ] as const) {
    assert.throws(() => decode?.(set(record), 'ls_remote_plan'), refused(pattern), JSON.stringify(record));
  }
});

test('a clear decodes its keys as overlay keys, and leaves as their saved text', () => {
  // Break: the keys stay text, so the plan holds 'mode:sara' where it names Sara mode.
  const document = { op: 'clear', keys: ['mode:sara'], via: 'remote', ...envelope };
  const plan = decode?.(document, 'ls_remote_plan');
  assert.ok(plan?.op === 'clear');
  assert.deepEqual(plan.keys, [SARA_MODE]);
  assert.deepEqual(resultCodecs.ls_remote_plan.encode(plan), document);
});

test('an input record decodes with no key of its own, and leaves with its source key in place', () => {
  // Break: the record keeps a key independent of its source, so the domain value carries it.
  const plan = decode?.(set(INPUT), 'ls_remote_plan');
  assert.ok(plan?.op === 'set');
  assert.deepEqual(plan.records, [{ kind: 'input', source: 'r', scope: 'room', target: 'studio', value: {} }]);
  const encoded = resultCodecs.ls_remote_plan.encode(plan);
  assert.deepEqual(encoded, set(INPUT));
  assert.equal(JSON.stringify(encoded), JSON.stringify(set(INPUT)));
});

test("an input record whose key is not its source's key is refused", () => {
  // Break: key and source are read independently, so `block:x` with source `r` decodes.
  for (const key of ['block:x', 'channels:other', 'mode:sara', 'channels:ui:r']) {
    const message = `ls_remote_plan.records.0.key must be "channels:r", the key of its source, got ${JSON.stringify(key)}`;
    assert.throws(() => decode?.(set({ ...INPUT, key }), 'ls_remote_plan'),
      (error: unknown) => error instanceof ParseError && error.message === message, key);
  }
});
