import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/domain-imports.mjs` keeps the layers importing downward: `src/domain/` imports only from itself, and
 * `src/adapter/` never imports the host (`src/host.ts`, `main.ts`, `live.ts`, `rpc.ts`). Type references written
 * `import('…')` count as imports.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/domain-imports.mjs', import.meta.url));

function run(tree: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'domain-imports-'));
  try {
    for (const [name, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true });
  }
}

test('a domain file importing outside src/domain fails', () => {
  // Break: the guard stops reading a domain file's imports, or allows a sibling folder.
  const result = run({ 'src/domain/a.ts': "import { x } from '../adapter/x.ts';\nexport const a = x;\n", 'src/adapter/x.ts': 'export const x = 1;\n' });
  assert.equal(result.status, 1);
  assert.match(result.output, /src\/domain\/a\.ts imports \.\.\/adapter\/x\.ts/);
});

test('a domain file importing inside src/domain passes', () => {
  // Break: the guard flags the domain's own imports.
  const result = run({ 'src/domain/a.ts': "import { b } from './types/b.ts';\nexport const a = b;\n", 'src/domain/types/b.ts': 'export const b = 1;\n' });
  assert.equal(result.status, 0, result.output);
});

test('an import() type reference counts as an import', () => {
  // Amendment 5.3. Break: `import('…')` in a type position slips past the guard.
  const result = run({ 'src/domain/a.ts': "export type A = import('../adapter/x.ts').X;\n", 'src/adapter/x.ts': 'export type X = number;\n' });
  assert.equal(result.status, 1);
  assert.match(result.output, /src\/domain\/a\.ts imports \.\.\/adapter\/x\.ts/);
});

test('an adapter file importing the host fails; importing the domain passes', () => {
  // Break: the adapter reaches up into the host, so the host is no longer a wrapper the adapter can run without.
  for (const host of ['host', 'main', 'live', 'rpc']) {
    const result = run({ 'src/adapter/a.ts': `import type { H } from '../${host}.ts';\nexport type A = H;\n`, [`src/${host}.ts`]: 'export type H = 1;\n' });
    assert.equal(result.status, 1, host);
    assert.match(result.output, new RegExp(`src/adapter/a\\.ts imports \\.\\./${host}\\.ts: the adapter never imports the host`));
  }
  const fine = run({ 'src/adapter/codecs/a.ts': "import { d } from '../../domain/d.ts';\nexport const a = d;\n", 'src/domain/d.ts': 'export const d = 1;\n' });
  assert.equal(fine.status, 0, fine.output);
});
