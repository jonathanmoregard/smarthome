import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lockJournal } from '../../src/main.ts';

/**
 * One port per journal (M5 carry-over): two ports sharing a journal would each trust what the other sent, and both
 * would drive the same rooms. The lock is a file next to the journal holding its owner's process id.
 */
const journal = async () => join(await mkdtemp(join(tmpdir(), 'lighting-lock-')), 'journal.json');

/** The id of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.once('exit', resolve));
  assert.ok(child.pid !== undefined);
  return child.pid;
}

test('a second port that finds the journal held stops with a clear error, naming the owner', async () => {
  // Break: the second process takes the journal too, and two ports fight over the same rooms.
  const path = await journal();
  const release = await lockJournal(path);
  await assert.rejects(lockJournal(path), new RegExp(`journal\\.json is held by process ${process.pid}`));
  await release();
});

test('a lock its port left behind when it died is taken over', async () => {
  // Break: a crashed port's lock keeps every later start out until someone deletes it by hand.
  const path = await journal();
  await writeFile(`${path}.lock`, `${await deadPid()}\n`);
  const release = await lockJournal(path);
  assert.equal((await readFile(`${path}.lock`, 'utf8')).trim(), String(process.pid));
  await release();
});

test('a released lock lets the next port start', async () => {
  const path = await journal();
  await (await lockJournal(path))();
  const again = await lockJournal(path);
  await again();
});
