import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/stringified.mjs` finds, in src/parse, src/domain and src/handlers,
 * every value that is not text joined into text: a `String(x)` call, a
 * template `${x}` or a `+`/`+=` string join, where the checker's type of `x`
 * is not assignable to string, number or bigint (so a JSON value, a boolean,
 * an object, `unknown`, or text that may be null or absent). Each site must be
 * fixed or kept, with a reason, in the kept list. It runs here against a
 * hand-counted fixture (`fixtures/stringified/src`); the expected sites below
 * are counted by hand from those files, not by the script.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/stringified.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('./fixtures/stringified/', import.meta.url));

function guard(kept: string, ...flags: string[]): { status: number | null; stdout: string; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', ROOT, '--kept', `${ROOT}kept/${kept}.json`, ...flags], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

interface Site { file: string; line: number; within: string; text: string; type: string }

let measured: Site[] | undefined;
function sites(): Site[] {
  if (measured === undefined) {
    const { stdout } = guard('exact', '--json');
    measured = (JSON.parse(stdout) as { sites: Site[] }).sites;
  }
  return measured;
}
const keyOf = (site: Pick<Site, 'file' | 'within' | 'text'>): string => `${site.file} ${site.within} ${site.text}`;

const EXPECTED: [file: string, within: string, text: string, counted: string][] = [
  ['src/domain/sample.ts', 'stringifiedCall', 'String(value)', 'String() of a JSON value'],
  ['src/domain/sample.ts', 'stringifiedCall', 'String(flag)', 'String() of a boolean'],
  ['src/domain/sample.ts', 'stringifiedHole', '${area}', 'a template hole holding a room that may be null'],
  ['src/domain/sample.ts', 'stringifiedHole', '${label}', 'a template hole holding text that may be absent'],
  ['src/domain/sample.ts', 'stringifiedHole', '${entry}', 'a template hole holding an object'],
  ['src/domain/sample.ts', 'concatenated', "'key:' + value", 'a `+` joining text and an unknown'],
  ['src/domain/sample.ts', 'appended', 'out += flag', 'a `+=` appending a boolean that may be absent'],
  ['src/domain/sample.ts', 'generic', 'String(other)', 'String() of an unknown beside a type parameter bounded by string'],
  ['src/parse/sample.ts', 'instance', 'String(selection)', 'the parse layer is in scope'],
  ['src/handlers/sample.ts', 'cacheEntities', '${target.area}', 'the handlers are in scope; the site is named by the const the arrow is bound to'],
];

for (const [file, within, text, counted] of EXPECTED) {
  test(`stringified finds ${file} ${within} ${text}: ${counted}`, () => {
    // Break: the matcher for this syntax or type is missing.
    assert.ok(sites().some(site => keyOf(site) === keyOf({ file, within, text })), keyOf({ file, within, text }));
  });
}

test('stringified finds nothing else: text, ids, literal unions, numbers, narrowed values, tagged templates, a local String, comments and src/runtime are not sites', () => {
  // Break: a text-typed value (a brand, a literal union, a bounded type
  // parameter, a narrowed JSON value) is counted, or comments, tagged
  // templates, a shadowing local `String` or an out-of-scope file are read.
  assert.deepEqual(sites().map(keyOf).sort(), EXPECTED.map(([file, within, text]) => keyOf({ file, within, text })).sort());
});

test('each site carries its line and the type the checker gives the value', () => {
  // Break: the report loses where a site is or why it counts.
  const hole = sites().find(site => site.text === '${target.area}');
  assert.equal(hole?.line, 7);
  assert.match(String(hole?.type), /null/);
});

test('every site kept, each with a reason, passes and reports the count', () => {
  // Break: a kept site still fails the build.
  const { status, output } = guard('exact');
  assert.equal(status, 0, output);
  assert.match(output, /stringified: 10 site\(s\), 10 kept/);
});

test('a site no entry keeps fails, naming its file, line and text', () => {
  // Break: a new stringified value passes because the guard only counts.
  const { status, output } = guard('one-missing');
  assert.equal(status, 1);
  assert.match(output, /src\/handlers\/sample\.ts:7 cacheEntities \$\{target\.area\}/);
});

test('a kept entry that covers no site fails, so it cannot excuse a later one', () => {
  // Break: a fixed site's entry lingers and silently keeps its replacement.
  const { status, output } = guard('stale');
  assert.equal(status, 1);
  assert.match(output, /src\/domain\/sample\.ts text String\(room\).*covers 0 site\(s\), not 1/);
});

test('a kept entry whose site count is wrong fails: a fall asks for the count to be lowered', () => {
  // Break: an entry keeps any number of identical sites, so a second copy passes unseen.
  const { status, output } = guard('miscount');
  assert.equal(status, 1);
  assert.match(output, /src\/parse\/sample\.ts instance String\(selection\).*covers 1 site\(s\), not 2/);
});

test('a kept entry without a reason fails', () => {
  // Break: a site is kept with no stated reason.
  const { status, output } = guard('no-reason');
  assert.equal(status, 1);
  assert.match(output, /reason/);
});
