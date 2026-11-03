// Guard: JSON belongs at the edges, not in the domain.
//
// `JsonObject`/`JsonValue` is the INPUT to parsing, never the result. A parser
// that returns the unparsed type has not parsed anything, and a domain type
// written `interface X extends JsonObject` is a validated bag: it inherits the
// index signature, so every field stays JsonValue-assignable, arbitrary keys
// stay legal, and invalid states stay representable.
//
// The legitimate JSON edges are the HA transport, the parity harness RPC and
// on-disk state -- under src/runtime, src/parse or src/live.ts. src/domain is
// not an edge, and inter-handler calls are not an edge either.
//
// Read this honestly: these counts cover src/domain ONLY, so moving a parser
// into src/parse lowers them without deleting a single `JsonObject`. That is
// the intended mechanism for criteria 4 through 8 -- the parse layer is the
// declared boundary and is EXPECTED to grow as the domain empties -- but it
// means a falling total here is evidence about where JSON lives, not about how
// much of it there is. Two things therefore do not count as progress: moving a
// parser to src/parse and leaving its call sites in the domain (the accessor
// and type counts stay put, correctly), and relocating domain logic that was
// never a parser just to get it out of this directory.
//
// Ceilings ratchet DOWN only. Raising one is the regression this guard exists
// to catch, so a raise must be argued in the commit message, never done to make
// a build pass.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOMAIN = join(ROOT, 'src/domain');

/**
 * Ceilings for src/domain. Baseline measured 2026-11-03 before any rework was
 * `442 / 9 / 293 / 62`.
 *
 * `lenientAccessors` 293 -> 282 after the runtime catalog was parsed once at
 * the edge: eleven `object(...)`, `strings(...)` and `num(...)` calls existed
 * only to re-dissolve the catalog document at each read site.
 *
 * `validatedBags` 9 -> 0 with criterion 3: every `interface X extends
 * JsonObject` became a type alias, so arbitrary keys are now illegal (TS2353)
 * and the fields no longer inherit an index signature. Type-level only, erased
 * at runtime.
 *
 * `jsonTypes` 442 -> 431 as a mechanical consequence of that same change: the
 * twelve debagged declarations contained eleven literal `JsonObject` tokens,
 * which the regex counts. No *read* became typed here, so the drop overstates
 * criterion 3's reach. The remaining 431 are dominated by handler arguments,
 * handler return types and entity-state reads, and move with criteria 4
 * through 8. A criterion that reduces accessors without reducing types is still
 * making real progress, so the four ratchet independently.
 *
 * Criterion 4 cleared the four leaf modules — `scale`, `gradient`, `blocks`,
 * `frames` — to zero on every count, which is why they no longer appear in the
 * table at all. `jsonTypes 431 -> 414`, `lenientAccessors 282 -> 277`,
 * `rawJsonReturns 62 -> 60`. The parsers they used to hold now live in
 * `src/parse/`, and `isObject`/`object` moved to `src/runtime/parse.ts`. Note
 * that moving a *definition* out of `src/domain` does not move these counts:
 * the regexes count call sites and signatures, so the 277 remaining accessor
 * calls are still in domain code and only fall as each module gets properly
 * parsed in criteria 5 through 8.
 *
 * Criterion 5's typing pass is the kind that IS real elimination, and it shows
 * in the accessor column: giving `profile`/`sample`/`interpolate` real return
 * types took `schedule.ts` from 64 lenient calls to 48 and from 7 raw-JSON
 * returns to 4 without relocating a single function.
 * `jsonTypes 414 -> 410`, `lenientAccessors 277 -> 261`,
 * `rawJsonReturns 60 -> 57`.
 */
const CEILINGS = {
  jsonTypes: 410,
  validatedBags: 0,
  lenientAccessors: 261,
  rawJsonReturns: 57,
};

/** Comments may legitimately name these types while explaining why they are gone. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PATTERNS = {
  jsonTypes: /\bJson(?:Object|Value)\b/g,
  validatedBags: /\binterface\s+\w+\s+extends\s+Json(?:Object|Value)\b/g,
  lenientAccessors: /(?<![A-Za-z0-9_$.])(?:object|values|list|num|jinjaMappingGet|String)\s*\(/g,
  rawJsonReturns: /\)\s*:\s*Json(?:Object|Value)\b/g,
};

const count = (text, pattern) => (text.match(pattern) ?? []).length;

const files = (await readdir(DOMAIN)).filter(name => name.endsWith('.ts')).sort();
const totals = Object.fromEntries(Object.keys(PATTERNS).map(key => [key, 0]));
const rows = [];

for (const name of files) {
  const text = stripComments(await readFile(join(DOMAIN, name), 'utf8'));
  const row = { name };
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    row[key] = count(text, pattern);
    totals[key] += row[key];
  }
  rows.push(row);
}

const COLUMNS = [
  ['jsonTypes', 'JsonObject/Value'],
  ['validatedBags', 'extends Json'],
  ['lenientAccessors', 'lenient calls'],
  ['rawJsonReturns', 'raw JSON returns'],
];

rows.sort((a, b) => b.jsonTypes - a.jsonTypes);
const width = Math.max(...files.map(name => name.length), 8);
console.log('src/domain — JSON at the edges\n');
console.log(`${'file'.padEnd(width)}  ${COLUMNS.map(([, label]) => label.padStart(16)).join('  ')}`);
for (const row of rows) {
  if (!COLUMNS.some(([key]) => row[key] > 0)) continue;
  console.log(`${row.name.padEnd(width)}  ${COLUMNS.map(([key]) => String(row[key]).padStart(16)).join('  ')}`);
}
console.log(`${'TOTAL'.padEnd(width)}  ${COLUMNS.map(([key]) => String(totals[key]).padStart(16)).join('  ')}`);
console.log(`${'ceiling'.padEnd(width)}  ${COLUMNS.map(([key]) => String(CEILINGS[key]).padStart(16)).join('  ')}`);

const over = COLUMNS.filter(([key]) => totals[key] > CEILINGS[key]);
const slack = COLUMNS.filter(([key]) => totals[key] < CEILINGS[key]);

if (over.length > 0) {
  console.error('\nFAIL: JSON moved back into the domain.');
  for (const [key, label] of over) {
    console.error(`  ${label}: ${totals[key]} exceeds the ceiling of ${CEILINGS[key]}`);
  }
  console.error('Parse at the edge and hand the domain a real type. Do not raise the ceiling.');
  process.exit(1);
}

// Progress does NOT fail the build. A red check mid-refactor invites someone to
// "fix" it by reverting the improvement, and it breaks the edit-then-check loop.
// The ratchet is applied deliberately at commit time, prompted by this notice.
if (slack.length > 0) {
  console.log('\nProgress made. Ratchet these ceilings down in scripts/json-edges.mjs before committing:');
  for (const [key, label] of slack) {
    console.log(`  ${label}: ${CEILINGS[key]} -> ${totals[key]}`);
  }
} else {
  console.log('\nOK: every count sits exactly at its ceiling.');
}
