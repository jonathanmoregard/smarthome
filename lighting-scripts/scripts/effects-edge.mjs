// Guard: decisions are pure, effects happen at the edge.
//
// A lighting decision reads typed input and returns a value or yields a
// `Plan` of `Effect`s; only `src/runtime/effects.ts` performs them. Six counts,
// all comment-stripped, each ratcheting DOWN only:
//
// 1. `ScriptContext` named in `src/domain`.
// 2. `ctx.` in `src/domain`: any read or effect through the live context.
// 3. A `function*` in `src/domain` whose signature names `HouseView`. The view
//    is live, so a read after a `yield` would look pure and not be; a
//    generator takes a snapshot, never the view.
// 4. `.emit(`, `.fire(`, `.put(`, `.schedule(` anywhere in `src` except
//    `src/runtime/effects.ts` (the interpreter) and `src/runtime/engine.ts`
//    (the context those calls land on; its internal `this.put(` applies an
//    emitted helper write and is the implementation, not a caller).
// 5. Lines over 150 characters anywhere in `src`.
//
// Final state (refactor U8): every ceiling is 0.
//
// Ceilings measured 2026-11-19 at 1489f72, before U0:
// domainScriptContext 49, domainCtx 236, houseViewGenerators 0,
// effectCalls 39, longLines 144.
//
// U1 (parse readers and the pure readers retyped to HouseView, switchPlan on
// the areas map): domainScriptContext 49 -> 32, domainCtx 236 -> 190.
//
// U2 (gestures reducer): domainCtx 190 -> 181, effectCalls 39 -> 32.
//
// Raising a ceiling is the regression this guard exists to catch; argue any
// raise in the commit message.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(ROOT, 'src');

const CEILINGS = {
  domainScriptContext: 32,
  domainCtx: 181,
  houseViewGenerators: 0,
  effectCalls: 32,
  longLines: 144,
};

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;
const EFFECT_EDGE = new Set(['src/runtime/effects.ts', 'src/runtime/engine.ts']);

const totals = Object.fromEntries(Object.keys(CEILINGS).map(key => [key, 0]));
const rows = [];
for (const path of await walk(SRC)) {
  const name = relative(ROOT, path);
  const raw = await readFile(path, 'utf8');
  const text = stripComments(raw);
  const domain = name.startsWith('src/domain/');
  const row = {
    name,
    domainScriptContext: domain ? count(text, /\bScriptContext\b/g) : 0,
    domainCtx: domain ? count(text, /(?<![A-Za-z0-9_$.])ctx\./g) : 0,
    houseViewGenerators: domain ? count(text, /function\s*\*\s*\w*\s*(?:<[^>]*>)?\s*\([^)]*\bHouseView\b/g) : 0,
    effectCalls: EFFECT_EDGE.has(name) ? 0 : count(text, /\.(?:emit|fire|put|schedule)\(/g),
    longLines: raw.split('\n').filter(line => line.length > 150).length,
  };
  for (const key of Object.keys(CEILINGS)) totals[key] += row[key];
  rows.push(row);
}

const COLUMNS = Object.keys(CEILINGS);
const width = Math.max(...rows.map(row => row.name.length), 8);
console.log('src — effects at the edge\n');
console.log(`${'file'.padEnd(width)}  ${COLUMNS.map(key => key.padStart(19)).join('  ')}`);
for (const row of rows) {
  if (!COLUMNS.some(key => row[key] > 0)) continue;
  console.log(`${row.name.padEnd(width)}  ${COLUMNS.map(key => String(row[key]).padStart(19)).join('  ')}`);
}
console.log(`${'TOTAL'.padEnd(width)}  ${COLUMNS.map(key => String(totals[key]).padStart(19)).join('  ')}`);
console.log(`${'ceiling'.padEnd(width)}  ${COLUMNS.map(key => String(CEILINGS[key]).padStart(19)).join('  ')}`);

const over = COLUMNS.filter(key => totals[key] > CEILINGS[key]);
const slack = COLUMNS.filter(key => totals[key] < CEILINGS[key]);
if (over.length > 0) {
  console.error('\nFAIL: an effect or a live read moved back into a decision.');
  for (const key of over) console.error(`  ${key}: ${totals[key]} exceeds the ceiling of ${CEILINGS[key]}`);
  console.error('Yield an Effect from a plan and perform it at the edge. Do not raise the ceiling.');
  process.exit(1);
}
if (slack.length > 0) {
  console.log('\nProgress made. Ratchet these ceilings down in scripts/effects-edge.mjs before committing:');
  for (const key of slack) console.log(`  ${key}: ${CEILINGS[key]} -> ${totals[key]}`);
} else {
  console.log('\nOK: every count sits exactly at its ceiling.');
}
