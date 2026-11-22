import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/domain-imports.mjs` keeps the new architecture apart from the old
 * script-shaped code: `src/domain/` imports only from itself, nothing in
 * `src/domain/` or `src/adapter/` imports from `src/legacy/` unless the list
 * names it a bridge, and `src/legacy/` holds only the files the list names.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/domain-imports.mjs', import.meta.url));

interface Legacy { files: string[]; bridges: string[] }

function run(tree: Record<string, string>, legacy: Legacy = { files: [], bridges: [] }): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'domain-imports-'));
  try {
    for (const [name, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    const list = join(root, 'legacy-files.json');
    writeFileSync(list, JSON.stringify(legacy));
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--legacy', list], { encoding: 'utf8' });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true });
  }
}

test('a domain file importing outside src/domain fails', () => {
  // Break: the guard stops reading a domain file's imports, or allows a sibling folder.
  const result = run({ 'src/domain/a.ts': "import { x } from '../runtime/x.ts';\nexport const a = x;\n", 'src/runtime/x.ts': 'export const x = 1;\n' });
  assert.equal(result.status, 1);
  assert.match(result.output, /src\/domain\/a\.ts imports \.\.\/runtime\/x\.ts/);
});

test('a domain file importing inside src/domain passes', () => {
  // Break: the guard refuses the domain's own folders.
  const result = run({ 'src/domain/a.ts': "import type { Id } from './types/ids.ts';\nexport type A = Id;\n", 'src/domain/types/ids.ts': 'export type Id = string;\n' });
  assert.equal(result.status, 0, result.output);
});

test('a domain file importing from src/legacy fails', () => {
  // Break: the legacy folder is treated like any other one under src.
  const result = run({ 'src/domain/a.ts': "import { x } from '../legacy/domain/x.ts';\nexport const a = x;\n", 'src/legacy/domain/x.ts': 'export const x = 1;\n' }, { files: ['src/legacy/domain/x.ts'], bridges: [] });
  assert.equal(result.status, 1);
  assert.match(result.output, /src\/domain\/a\.ts imports \.\.\/legacy\/domain\/x\.ts/);
});

test('an adapter file importing from src/legacy fails unless the list names it a bridge', () => {
  // Break: the bridge list is ignored, or applies to everyone.
  const tree = { 'src/adapter/b.ts': "import { x } from '../legacy/domain/x.ts';\nexport const b = x;\n", 'src/legacy/domain/x.ts': 'export const x = 1;\n' };
  const closed = run(tree, { files: ['src/legacy/domain/x.ts'], bridges: [] });
  assert.equal(closed.status, 1);
  assert.match(closed.output, /src\/adapter\/b\.ts imports \.\.\/legacy\/domain\/x\.ts/);
  const open = run(tree, { files: ['src/legacy/domain/x.ts'], bridges: ['src/adapter/b.ts'] });
  assert.equal(open.status, 0, open.output);
});

test('a legacy file the list does not name fails', () => {
  // Break: new code is allowed to land in src/legacy.
  const result = run({ 'src/legacy/domain/new.ts': 'export const n = 1;\n' }, { files: [], bridges: [] });
  assert.equal(result.status, 1);
  assert.match(result.output, /src\/legacy\/domain\/new\.ts is not in legacy-files\.json/);
});

test('legacy code may import anything', () => {
  // Break: the legacy folder is held to the domain rule.
  const result = run({ 'src/legacy/domain/x.ts': "import { y } from '../../runtime/y.ts';\nexport const x = y;\n", 'src/runtime/y.ts': 'export const y = 1;\n' }, { files: ['src/legacy/domain/x.ts'], bridges: [] });
  assert.equal(result.status, 0, result.output);
});
