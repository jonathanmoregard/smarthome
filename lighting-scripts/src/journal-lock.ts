/**
 * One port per journal: two would each trust what the other sent. The lock is `<journal>.lock`, naming its owner by
 * process id, the boot it runs in and the process's start time, so a process id reused after the owner ended, or
 * after a reboot, is not taken for the owner.
 *
 * The lock is whole from the moment it exists: its text is written to a file of this process's own and linked into
 * place, which fails when a lock is there. A lock that does not read (an older port's, or a damaged one) is never
 * taken for left over: it is read again for a while, then the start stops naming it. A left-over lock is taken over
 * by moving it aside under a name of this process's own, which only one taker can do, then linking anew.
 */
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Who holds a lock: the process, the boot it runs in and when the process started in that boot. */
export type LockOwner = { pid: number; boot: string; start: string };

/** A lock's text: the owner's process id, boot and start time, one line. */
export function lockText(owner: LockOwner): string {
  return `${owner.pid} ${owner.boot} ${owner.start}\n`;
}

/** The lock's text and owner, read again while it does not read; none when it is gone. */
async function readLock(lock: string): Promise<{ text: string; owner: LockOwner } | undefined> {
  for (let waited = 0; ; waited += REREAD_MS) {
    const text = await readFile(lock, 'utf8').catch((error: unknown) => {
      if (codeOf(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (text === undefined) return undefined;
    const owner = parseOwner(text);
    if (owner !== undefined) return { text, owner };
    if (waited >= UNREADABLE_WAIT_MS) {
      throw new Error(`The journal lock ${lock} does not read as a port's lock; if no port runs on the journal, remove it.`);
    }
    await new Promise(resolve => setTimeout(resolve, REREAD_MS));
  }
}

function parseOwner(text: string): LockOwner | undefined {
  const match = /^(\d+) (\S+) (\d+)\n$/.exec(text);
  if (match === null) return undefined;
  const [, pid, boot, start] = match;
  return pid === undefined || boot === undefined || start === undefined ? undefined : { pid: Number(pid), boot, start };
}

const BOOT_ID = '/proc/sys/kernel/random/boot_id';

/** How often a start links, finds a left-over lock and takes it over, before giving up: each round another won. */
const TAKE_TRIES = 5;

/** How long, and how often, a lock that does not read is read again before the start stops naming it. */
const UNREADABLE_WAIT_MS = 2000, REREAD_MS = 50;

/** Whether the lock's owner still runs: the same boot, and its process id names the process that started then. */
async function alive(owner: LockOwner): Promise<boolean> {
  const now = await ownerOf(owner.pid);
  return now !== undefined && now.boot === owner.boot && now.start === owner.start;
}

/** The process's owner record, from `/proc`: none when it is not running. */
export async function ownerOf(pid: number): Promise<LockOwner | undefined> {
  const [boot, stat] = await Promise.all([readFile(BOOT_ID, 'utf8').catch(() => 'unknown'), readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined)]);
  // The command name is in parentheses and may hold anything; field 22, the start time, is the 20th after it.
  const start = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return start === undefined || start === '' ? undefined : { pid, boot: boot.trim(), start };
}

/**
 * Take the journal for this process. A lock whose owner runs stops this start; one whose owner has ended is taken
 * over. The answer gives the lock back.
 */
export async function lockJournal(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`, own = await ownerOf(process.pid);
  if (own === undefined) throw new Error('This process cannot read its own start time from /proc');
  const text = lockText(own);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < TAKE_TRIES; tries++) {
    if (await linked(lock, text)) {
      return async () => { if (await readFile(lock, 'utf8').catch(() => undefined) === text) await unlink(lock).catch(() => undefined); };
    }
    const found = await readLock(lock);
    if (found === undefined) continue; // Gone meanwhile: link again.
    if (await alive(found.owner)) {
      throw new Error(`The journal ${path} is held by process ${found.owner.pid}: another port runs on it. Stop that one first.`);
    }
    await takeOver(lock, found.text);
  }
  throw new Error(`The journal lock ${lock} changed hands ${TAKE_TRIES} times while this port started; start it again.`);
}

/** Link a file holding `text` into place as the lock: false when a lock is there. */
async function linked(lock: string, text: string): Promise<boolean> {
  const own = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(own, text, { mode: 0o600 });
  try {
    await link(own, lock);
    return true;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(own).catch(() => undefined);
  }
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/**
 * Move a left-over lock aside, under a name only this process uses. When what was moved is not the lock judged left
 * over (another start took it over and linked its own meanwhile), it is put back.
 */
async function takeOver(lock: string, stale: string): Promise<void> {
  const aside = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await rename(lock, aside);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return; // Another start moved it first.
    throw error;
  }
  if (await readFile(aside, 'utf8') !== stale) await link(aside, lock).catch(() => undefined);
  await unlink(aside);
}
