import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The dev watcher (`scripts/dev.mjs`) on a throwaway root: a stub compiler that takes a moment, and a stub host that
 * logs its start and each SIGTERM, then takes a second to shut down, as the port's host does.
 */

const DEV = fileURLToPath(new URL('../../scripts/dev.mjs', import.meta.url));

const HOST = `
import { appendFileSync } from 'node:fs';
const log = process.env.DEV_TEST_LOG;
appendFileSync(log, process.pid + ' start\\n');
process.on('SIGTERM', () => { appendFileSync(log, process.pid + ' term\\n'); setTimeout(() => process.exit(0), 1000); });
setInterval(() => {}, 1000);
`;

const TSC = `setTimeout(() => process.exit(0), 300);\n`;

async function root(): Promise<{ dir: string; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dev-watcher-test-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'node_modules/typescript/bin'), { recursive: true });
  await writeFile(join(dir, 'src/main.ts'), HOST);
  await writeFile(join(dir, 'node_modules/typescript/bin/tsc'), TSC);
  const log = join(dir, 'host.log');
  await writeFile(log, '');
  return { dir, log };
}

const lines = async (log: string) => (await readFile(log, 'utf8')).split('\n').filter(line => line !== '');

async function until(what: string, check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a stop during a rebuild signals the old host once and starts no new one', async () => {
  // Break: the rebuild has already sent the old host SIGTERM and waits for it to exit; the stop then sends it a second
  // one (its shutdown is cut short), and once it exits the rebuild spawns a new host that no stop ever reaches.
  const { dir, log } = await root();
  const dev = spawn(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(DEV)}).then(m => m.develop(${JSON.stringify(dir + '/')}))`],
  { cwd: dir, env: { ...process.env, DEV_TEST_LOG: log }, stdio: 'ignore' });
  const exited = new Promise<void>(resolve => dev.once('exit', () => resolve()));
  try {
    await until('the first host', async () => (await lines(log)).some(line => line.endsWith(' start')));
    await writeFile(join(dir, 'src/changed.ts'), 'export {};\n');
    await until('the rebuild to stop the old host', async () => (await lines(log)).some(line => line.endsWith(' term')));
    dev.kill('SIGTERM');
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000))]);
    // Let a host spawned late by the rebuild log its start.
    await new Promise(resolve => setTimeout(resolve, 500));
    const seen = await lines(log);
    assert.ok(gone, `the watcher did not exit within 5 s of its stop: ${seen.join('; ')}`);
    assert.equal(seen.filter(line => line.endsWith(' start')).length, 1, seen.join('; '));
    assert.equal(seen.filter(line => line.endsWith(' term')).length, 1, seen.join('; '));
  } finally {
    dev.kill('SIGKILL');
    // A host the watcher left behind would keep the test runner alive.
    for (const line of await lines(log)) {
      try { process.kill(Number(line.split(' ')[0]), 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});
