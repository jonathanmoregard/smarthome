import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lockJournal, lockText, ownerOf } from '../../src/journal-lock.ts';
import type { LockOwner } from '../../src/journal-lock.ts';

/**
 * One port per journal (M5 carry-over): two ports sharing a journal would each trust what the other sent, and both
 * would drive the same rooms. The lock is a file next to the journal naming its owner: process id, boot, start time.
 */
const journal = async () => join(await mkdtemp(join(tmpdir(), 'lighting-lock-')), 'journal.json');

/** The id of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.once('exit', resolve));
  assert.ok(child.pid !== undefined);
  return child.pid;
}

const me = async (): Promise<LockOwner> => {
  const owner = await ownerOf(process.pid);
  assert.ok(owner !== undefined);
  return owner;
};

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
  await writeFile(`${path}.lock`, lockText({ ...await me(), pid: await deadPid() }));
  const release = await lockJournal(path);
  assert.equal(await readFile(`${path}.lock`, 'utf8'), lockText(await me()));
  await release();
});

test('a released lock lets the next port start', async () => {
  const path = await journal();
  await (await lockJournal(path))();
  const again = await lockJournal(path);
  await again();
});

test('starts racing for one journal: exactly one takes it', async () => {
  // Review finding 3. Break: the lock is created empty and its id written after, so a racing start reads no owner,
  // takes the lock for left over, and two ports run on the journal.
  const path = await journal();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => lockJournal(path)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('starts racing for a left-over lock: exactly one takes it over', async () => {
  // Review finding 3. Break: two starts each remove the left-over lock, one removing the other's fresh one.
  const path = await journal();
  await writeFile(`${path}.lock`, lockText({ ...await me(), pid: await deadPid() }));
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => lockJournal(path)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('an empty lock is not left over: it is read again, and a port that finishes writing it keeps it', async () => {
  // Review finding 3. Break: an empty or partial lock reads as no owner and is taken over while its owner writes it.
  const path = await journal();
  await writeFile(`${path}.lock`, '');
  setTimeout(() => void me().then(owner => writeFile(`${path}.lock`, lockText(owner))), 100);
  await assert.rejects(lockJournal(path), /is held by process/);
});

test('a lock that never reads stops the start, naming it, and is left as it is', async () => {
  // Break: a damaged lock, or an older port's, is taken for left over, and the port runs beside its owner.
  const path = await journal();
  await writeFile(`${path}.lock`, '12');
  await assert.rejects(lockJournal(path), /journal\.json\.lock does not read as a port's lock/);
  assert.equal(await readFile(`${path}.lock`, 'utf8'), '12');
});

test('a lock naming a running process that is not its owner is left over: the id was reused', async () => {
  // Review finding 6. Break: after a reboot, or once the owner ended, its process id names another process, and every
  // later start is kept out by a port that is gone.
  for (const owner of [{ ...await me(), boot: 'another-boot' }, { ...await me(), start: '1' }]) {
    const path = await journal();
    await writeFile(`${path}.lock`, lockText(owner));
    const release = await lockJournal(path);
    assert.equal(await readFile(`${path}.lock`, 'utf8'), lockText(await me()));
    await release();
  }
});
