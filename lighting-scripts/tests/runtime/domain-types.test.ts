import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/domain-types.mjs` fails when an exported signature in `src/domain`
 * types a value as plain `string` or `number` and no allowlist entry covers the
 * site. It runs here against small fixture trees, each with an allowlist
 * chosen per case.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/domain-types.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/domain-types/', import.meta.url));

function guard(root: string, allow: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', `${FIXTURES}${root}`, '--allow', `${FIXTURES}allow/${allow}.json`], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('a plain string parameter on an exported function fails the guard and names the site', () => {
  // Break: the guard skips parameters, or exits 0 when it finds a site.
  const { status, output } = guard('one-site', 'none');
  assert.equal(status, 1);
  assert.match(output, /src\/domain\/lamp\.ts/);
  assert.match(output, /lampOf\.room/);
});

test('keywords in function bodies and in unexported functions are not signature sites', () => {
  // Break: the guard walks whole files instead of exported signatures, so it
  // would also report `count.times`, `count.return` and the body's `local`.
  const { output } = guard('one-site', 'none');
  assert.match(output, /lampOf\.room/, 'the guard ran and reported the one real site');
  assert.doesNotMatch(output, /count\.times|count\.return|local/);
});

test('an allowlist entry with a reason covers its symbol', () => {
  // Break: allow entries are ignored, or matched by file only.
  assert.equal(guard('one-site', 'by-symbol').status, 0);
});

test('an allowlist entry without a reason is rejected', () => {
  // Break: an entry with an empty reason is accepted, so the allowlist stops
  // saying why each plain type is open.
  const { status, output } = guard('one-site', 'no-reason');
  assert.equal(status, 1);
  assert.match(output, /reason/);
});

test('a file ceiling covers that many sites', () => {
  // Break: the ceiling is compared with `<` instead of `<=`.
  assert.equal(guard('one-site', 'ceiling-1').status, 0);
});

test('a count above its file ceiling fails the guard', () => {
  // Break: ceilings are treated as allow-all for the file.
  const { status, output } = guard('two-sites', 'ceiling-1');
  assert.equal(status, 1);
  assert.match(output, /Lamp\.level/);
});

test('a count below its file ceiling fails and asks for the ceiling to be lowered', () => {
  // Break: a fall passes, so the slack it leaves absorbs a later rise in that file.
  const { status, output } = guard('one-site', 'ceiling-2');
  assert.equal(status, 1);
  assert.match(output, /src\/domain\/lamp\.ts: 2 -> 1/);
  assert.match(output, /[Ll]ower/);
});

test('an exported function with no return annotation is checked on the type it returns', () => {
  // Break: the guard reads only written return types, so `return String(x)` with no
  // annotation, an arrow's inferred return and a returned object's plain field all escape.
  const { status, output } = guard('inferred-return', 'none');
  assert.equal(status, 1);
  assert.match(output, /src\/domain\/lamp\.ts.*lampName\.return\s+string/);
  assert.match(output, /src\/domain\/lamp\.ts.*roomOf\.return\s+string/);
  assert.match(output, /src\/domain\/lamp\.ts.*lampView\.return\.level\s+number/);
  assert.doesNotMatch(output, /brandedRoom|literalKind|namedLamp/);
});

test('types reached through an exported signature are checked, wherever they are declared', () => {
  // Break: the guard stops at the exported declaration, so a plain field one
  // type away (here in an unexported domain type, and in a parse type) is missed.
  const { status, output } = guard('transitive', 'none');
  assert.equal(status, 1);
  assert.match(output, /src\/domain\/room\.ts.*Lamp\.level/);
  assert.match(output, /src\/parse\/remote\.ts.*Remote\.device/);
});
