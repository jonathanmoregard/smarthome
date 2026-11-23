import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/json-edges.mjs` counts JSON types and lenient accessors in
 * src/domain. Review round 3, item 4: it read src/domain
 * with a flat `readdir`, so src/domain/types was never counted. It runs here
 * against a fixture whose only JSON sits in `src/domain/types/bag.ts`.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/json-edges.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('./fixtures/json-edges/', import.meta.url));

test('json-edges reads src/domain recursively: a JSON type under src/domain/types counts', () => {
  // Break: the domain directory is read flat, so a subdirectory's files are never counted.
  const result = spawnSync(process.execPath, [SCRIPT, '--root', ROOT], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  // Two: the import names `JsonValue`, and so does the field.
  assert.match(result.stdout, /^types\/bag\.ts\s+2\s/m);
  assert.match(result.stderr, /JsonObject\/Value: 2 exceeds the ceiling of 0/);
});
