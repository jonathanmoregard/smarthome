import assert from 'node:assert/strict';
import test from 'node:test';
import { drive } from '../../src/runtime/effects.ts';

// A counter that asks for a number until the sum reaches a limit, logging as it goes.
type Phase = { tag: 'adding'; sum: number } | { tag: 'done'; sum: number };
type Msg = { tag: 'start' } | { tag: 'got'; n: number };
type Cmd = { tag: 'log'; text: string } | { tag: 'ask' };
const step = (phase: Phase, msg: Msg): [Phase, Cmd[]] => {
  if (phase.tag === 'done') throw new Error('done takes nothing');
  const sum = phase.sum + (msg.tag === 'got' ? msg.n : 0);
  return sum >= 5 ? [{ tag: 'done', sum }, [{ tag: 'log', text: `done ${sum}` }]] : [{ tag: 'adding', sum }, [{ tag: 'log', text: `at ${sum}` }, { tag: 'ask' }]];
};

test('drive performs each step\'s commands in order and feeds the last reply back', () => {
  const log: string[] = [];
  const answer = drive(step, { tag: 'adding', sum: 0 }, { tag: 'start' }, cmd => {
    if (cmd.tag === 'log') { log.push(cmd.text); return undefined; }
    return { tag: 'got', n: 2 };
  }, phase => phase.tag === 'done' ? { value: phase.sum } : undefined);
  assert.equal(answer, 6);
  assert.deepEqual(log, ['at 0', 'at 2', 'at 4', 'done 6']);
});

test('a step that is not terminal and asks for nothing is a stall, not a loop', () => {
  assert.throws(() => drive(step, { tag: 'adding', sum: 0 }, { tag: 'start' }, () => undefined, () => undefined), /stalled.*adding/);
});
