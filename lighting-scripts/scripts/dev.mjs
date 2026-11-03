import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function compileCandidate(root, output) {
  await mkdir(output, { recursive: true });
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '--outDir', output, '--noEmitOnError'], { cwd: root, stdio: 'inherit' });
    child.once('error', () => resolveResult(false));
    child.once('exit', code => resolveResult(code === 0));
  });
}
export async function develop(root = fileURLToPath(new URL('../', import.meta.url))) {
  const builds = await mkdtemp(join(tmpdir(), 'smarthome-dev-'));
  let child, building = false, requested = true, stopped = false, sequence = 0, timer;
  const build = async () => {
    if (building || stopped) return;
    building = true;
    try {
      while (requested && !stopped) {
        requested = false;
        const output = join(builds, String(++sequence));
        if (!await compileCandidate(root, output)) { console.error('Compile failed; last working program remains active.'); continue; }
        if (stopped) break;
        if (child) child.send({ type: 'reload', directory: output });
        else {
          child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts', '--program', output, ...process.argv.slice(2)], { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
          child.once('exit', code => { if (!stopped) { stopped = true; watcher.close(); process.exitCode = code ?? 1; } });
        }
      }
    } finally { building = false; }
  };
  const watcher = watch(join(root, 'src'), { recursive: true }, () => {
    requested = true; clearTimeout(timer); timer = setTimeout(() => { void build(); }, 40);
  });
  const stop = () => { stopped = true; clearTimeout(timer); watcher.close(); child?.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await build();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await develop();
