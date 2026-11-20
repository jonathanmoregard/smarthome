import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/domain-words.mjs` counts, over `src/domain`, the words spec v3
 * section 5.1 wants gone from the domain, and fails when a count rises above
 * its ceiling. It runs here against a hand-counted fixture
 * (`fixtures/domain-words/src/domain/sample.ts`); the expected counts below are
 * counted by hand from that file, not by the script.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/domain-words.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('./fixtures/domain-words/', import.meta.url));

function guard(ceilings: string, ...flags: string[]): { status: number | null; stdout: string; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', ROOT, '--ceilings', `${ROOT}ceilings/${ceilings}.json`, ...flags], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

let measured: Record<string, number> | undefined;
function totals(): Record<string, number> {
  if (measured === undefined) {
    const { stdout } = guard('exact', '--json');
    measured = (JSON.parse(stdout) as { totals: Record<string, number> }).totals;
  }
  return measured;
}

const COLUMNS: [column: string, count: number, counted: string][] = [
  ['generators', 1, '`function* turnOn`; the `function*` in the comment is not code'],
  ['yields', 2, 'the two `yield`s in `turnOn`'],
  ['planTypes', 1, 'the `Plan<null>` return type; the import specifier is not a use'],
  ['effectKinds', 2, "`kind: 'service'` and `kind: 'script'` object literals"],
  ['haNames', 4, "'light.example' twice, 'light.turn_on' and 'ls_commit'; import paths and plain words are not names"],
  ['parseRuntimeImports', 3, 'two `../runtime` imports and one `../parse` import; `./types/ids.ts` is the domain'],
  ['viewReads', 2, '`view.get` and `view.attr` on the HouseView'],
  ['carriedTypes', 1, 'the `Verbatim` parameter; the import specifier is not a use'],
  ['casts', 2, '`state as string` and `raw as RoomId`; `as const` is not a cast'],
  ['nonNull', 1, '`room!`'],
  ['nullish', 1, 'the one `??`'],
  ['typeofs', 1, 'the runtime `typeof value`; `typeof COLOURS` in a type is not a test'],
  ['literalIncludes', 2, "`['a', 'b'].includes` and `COLOURS.includes` (a const array literal); `names.includes` is not literal"],
  ['brandConstructors', 2, 'the `roomId(...)` call into src/parse/ids.ts and the `as RoomId` cast to a domain type'],
];

for (const [column, count, counted] of COLUMNS) {
  test(`domain-words counts ${column}: ${counted}`, () => {
    // Break: the column's matcher misses its syntax, or counts comments, import
    // specifiers or the look-alikes named in the title.
    assert.equal(totals()[column], count);
  });
}

test('domain-words reports no column beyond the ones it was asked for', () => {
  // Break: a column is added or renamed without its ceiling, so it is never enforced.
  assert.deepEqual(Object.keys(totals()).sort(), COLUMNS.map(([column]) => column).sort());
});

test('counts at their ceilings pass', () => {
  // Break: the ceiling comparison is `<` instead of `<=`.
  assert.equal(guard('exact').status, 0);
});

test('a count above its ceiling fails and names the column', () => {
  // Break: a rise is reported but does not fail the build.
  const { status, output } = guard('nullish-0');
  assert.equal(status, 1);
  assert.match(output, /nullish: 1 exceeds the ceiling of 0/);
});

test('a count below its ceiling passes and asks for the ceiling to be lowered', () => {
  // Break: a fall fails the build, or passes silently so the ceiling never ratchets.
  const { status, output } = guard('casts-5');
  assert.equal(status, 0);
  assert.match(output, /casts: 5 -> 2/);
});
