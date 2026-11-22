import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixSource, ownership, scan } from '../../scripts/item-order.mjs';

/**
 * `scripts/item-order.mjs` holds the reading order of PR #39 comment
 * 4657187381, the TypeScript twin of klaffat's `item_order_lint.rs`: types
 * first, each with its own code; a callee below a caller; a single-use
 * helper inside its caller's block; public entry points first; tables after
 * their types. These cases mirror the Rust test's where they apply.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/item-order.mjs', import.meta.url));

interface Scope { name: string; found: string[]; manual: string[] }

function found(source: string, name = 'f.ts'): string[] {
  const scopes: Scope[] = scan(name, source);
  return scopes.flatMap(scope => [...scope.found, ...scope.manual]);
}

function fixed(source: string, name = 'f.ts'): string {
  const result: { text: string; problems: string[] } = fixSource(name, source);
  assert.deepEqual(result.problems, []);
  return result.text;
}

test('rule 1 puts a type and its code before free functions', () => {
  // Break: types are not judged against free functions, or a type's owned
  // function is read as free.
  assert.deepEqual(found('export function f() {}\ninterface S {}\nexport function sName(s: S): string { return ""; }\n'), [
    'rule 1: interface S comes after function f',
    'rule 1: function sName belongs with type S but comes after function f',
  ]);
  assert.deepEqual(found('interface S {}\ninterface T {}\nfunction sName(s: S): string { return ""; }\n'), [
    'rule 1: function sName is separated from the rest of type S',
  ]);
  assert.deepEqual(found('function sName(s: S): string { return ""; }\ninterface S {}\n'), [
    'rule 1: function sName comes before the definition of S',
  ]);
});

test('rule 1 keeps a type\'s helpers with the type', () => {
  // Break: a free function only the type's code calls is not a helper.
  assert.deepEqual(found('class S { m() { return help(); } }\nexport function f() {}\nfunction help() { return 1; }\n'), [
    'rule 1: function help belongs with type S but comes after function f',
  ]);
  assert.deepEqual(found('class S { m() { return help(); } }\nfunction help() { return 1; }\nexport function f() {}\n'), []);
  // An owned function's helper sits in the group too, below the owned functions.
  assert.deepEqual(found([
    'interface S { n: number }',
    'export function parseS(v: unknown): S { return { n: count(v) }; }',
    'export function sText(s: S): string { return String(s.n); }',
    'function count(v: unknown): number { return Number(v); }',
    'export function free(): void {}',
    '',
  ].join('\n')), []);
});

test('an owned function sits with its type even when free functions below call it', () => {
  // Break: a free caller counts for an owned function, as `Type::m` from
  // module scope would in Rust, so rule 2 pulls the parser below `run`.
  assert.deepEqual(found([
    'interface S { n: number }',
    'export function parseS(v: unknown): S { return { n: Number(v) }; }',
    'export function run(): number { return parseS(1).n; }',
    '',
  ].join('\n')), []);
});

test('a function is owned by the one file-local type its signature names', () => {
  // Break: ownership reads the body, counts imported types, or treats two
  // local types as owning.
  assert.deepEqual(ownership('f.ts', [
    'import type { Json } from "./json.ts";',
    'interface A { a: number }',
    'interface B { b: number }',
    'export function parseA(v: Json): A { return { a: 1 }; }',
    'function aText(a: A): string { const b: B = { b: 1 }; return String(a.a + b.b); }',
    'export function both(a: A): B { return { b: a.a }; }',
    'export function neither(v: Json): string { return String(v); }',
    '',
  ].join('\n')), { parseA: 'A', aText: 'A', both: undefined, neither: undefined });
});

test('rule 2 puts a callee below a caller', () => {
  // Break: rule 2 ignores order, or counts recursion as a constraint.
  assert.deepEqual(found('function helper() {}\nexport function mainOne() { helper(); }\n'), [
    'rule 2: function helper comes before every caller (function mainOne)',
  ]);
  // A diamond: one caller above is enough.
  assert.deepEqual(found('export function a() { c(); }\nfunction c() {}\nexport function b() { c(); }\n'), []);
  // Mutual recursion is not an ordering constraint.
  assert.deepEqual(found('export function a() { b(); }\nfunction b() { a(); }\n'), []);
});

test('rule 3 lays a tree out depth first', () => {
  // Break: a single-use helper may drift away from its caller.
  assert.deepEqual(found('export function a() { x(); }\nexport function b() {}\nfunction x() {}\n'), [
    'rule 3: function x is called only by function a, but function b sits between them',
  ]);
  assert.deepEqual(found('export function a() { x(); }\nfunction x() { y(); }\nfunction y() {}\nexport function b() {}\n'), []);
});

test('rule 4 puts public entry points first', () => {
  // Break: rule 4 is skipped, or `export { .. }` lists and default exports are not public.
  assert.deepEqual(found('function unused() {}\nexport function api() {}\n'), [
    'rule 4: public function api comes after function unused, which nothing here calls',
  ]);
  assert.deepEqual(found('function unused() {}\nfunction api() {}\nexport { api };\n'), [
    'rule 4: public function api comes after function unused, which nothing here calls',
  ]);
  assert.deepEqual(found('function unused() {}\nexport default function api() {}\n'), [
    'rule 4: public function api comes after function unused, which nothing here calls',
  ]);
  assert.deepEqual(found('export function api() {}\nfunction unused() {}\n'), []);
});

test('rule 5 puts a type before a fixed item that names it', () => {
  // Break: tables are not judged, or a same-named type of another module counts.
  assert.deepEqual(found('const C: S = { n: 1 };\ninterface S { n: number }\n'), [
    'rule 5: const C names type S before its definition',
  ]);
  assert.deepEqual(found('interface S { n: number }\nconst C: S = { n: 1 };\n'), []);
  assert.deepEqual(found('import type * as other from "./other.ts";\nconst C: other.S = { n: 1 };\ninterface S { n: number }\n'), []);
});

test('a type derived from a value is pinned below that value', () => {
  // Break: a derived type is moved above its const, or read as an ordinary
  // movable type and its const as a rule 5 breach.
  assert.deepEqual(found([
    'const BLOCKS = ["day", "night"] as const;',
    'type Block = (typeof BLOCKS)[number];',
    'const DEFAULT: Block = "night";',
    'export function blockText(block: Block): string { return block; }',
    '',
  ].join('\n')), []);
  assert.deepEqual(found('type Block = (typeof BLOCKS)[number];\nconst BLOCKS = ["day"] as const;\n'), [
    'rule 5: type Block reads const BLOCKS before its definition',
  ]);
});

test('the fix leaves a fixed item for a person to place', () => {
  // Break: rule 5 breaches are counted as fixable, so the fixer would try to move a const.
  const [scope]: Scope[] = scan('f.ts', 'const C: S = { n: 1 };\ninterface S { n: number }\n');
  assert.deepEqual(scope?.found, []);
  assert.deepEqual(scope?.manual, ['rule 5: const C names type S before its definition']);
});

test('the rules hold inside a class body', () => {
  // Break: class bodies are not scopes, or `this.m()`, `C.m()` and `this.m` are not calls.
  assert.deepEqual(found('class S {\n  private helper() {}\n  run() { this.helper(); }\n}\n'), [
    'rule 2: method helper comes before every caller (method run)',
  ]);
  assert.deepEqual(found('class S {\n  private static helper() {}\n  run() { S.helper(); }\n}\n'), [
    'rule 2: method helper comes before every caller (method run)',
  ]);
  assert.deepEqual(found('class S {\n  private helper(n: number) { return n; }\n  run(xs: number[]) { return xs.map(this.helper); }\n}\n'), [
    'rule 2: method helper comes before every caller (method run)',
  ]);
  // The constructor is a public entry point.
  assert.deepEqual(found('class S {\n  private unused() {}\n  constructor() {}\n}\n'), [
    'rule 4: public constructor comes after method unused, which nothing here calls',
  ]);
});

test('a variable named like a function is not a call', () => {
  // Break: calls are matched by name, not by the checker's symbol.
  assert.deepEqual(found('export function request() {}\nexport function a(request: number): number { const x = request; return x; }\n'), []);
});

test('a field initialised by a function, and a function passed as a callback, are calls', () => {
  // Break: only `f(..)` counts, so a shorthand field or `xs.map(f)` escapes rule 2.
  assert.deepEqual(found('function port(): number { return 1; }\nexport function a() { return { port: port() }; }\n'), [
    'rule 2: function port comes before every caller (function a)',
  ]);
  assert.deepEqual(found('function port(): number { return 1; }\nexport function a() { return { port }; }\n'), [
    'rule 2: function port comes before every caller (function a)',
  ]);
  assert.deepEqual(found('function double(n: number) { return 2 * n; }\nexport function a(xs: number[]) { return xs.map(double); }\n'), [
    'rule 2: function double comes before every caller (function a)',
  ]);
});

test('a fixed arrow function is a caller', () => {
  // Break: a const arrow's body is not read, so what it calls may sit above it.
  assert.deepEqual(found('function helper() { return 1; }\nexport const run = () => helper();\n'), [
    'rule 2: function helper comes before every caller (const run)',
  ]);
  assert.deepEqual(found('export const run = () => helper();\nfunction helper() { return 1; }\n'), []);
});

test('the fix moves items with their comments', () => {
  // Break: a moved item loses its comment, or the const moves.
  const source = 'import { b } from "./b.ts";\n\n// Helper.\nfunction helper() {}\n\nconst C = 1;\n\n/** Entry. */\nexport function run() {\n  helper();\n}\n';
  assert.equal(fixed(source),
    'import { b } from "./b.ts";\n\n/** Entry. */\nexport function run() {\n  helper();\n}\n\nconst C = 1;\n\n// Helper.\nfunction helper() {}\n');
});

test('a file\'s top comment stays at the top', () => {
  // Break: the file comment travels with the first item.
  assert.equal(fixed('/** The file. */\n\nfunction helper() {}\nexport function run() { helper(); }\n'),
    '/** The file. */\n\nexport function run() { helper(); }\nfunction helper() {}\n');
});

test('the fix lays out types, their code, then free functions depth first', () => {
  // Break: the canonical order differs from the Rust fixer's.
  const source = [
    'export function run(): void { bind(); log(); }',
    'function log(): void {}',
    'function bind(): void {}',
    'export interface Session { id: string }',
    'export function sessionText(s: Session): string { return quote(s.id); }',
    'function quote(text: string): string { return text; }',
    'export function parseSession(v: unknown): Session { return { id: String(v) }; }',
    '',
  ].join('\n');
  assert.equal(fixed(source), [
    'export interface Session { id: string }',
    'export function sessionText(s: Session): string { return quote(s.id); }',
    'export function parseSession(v: unknown): Session { return { id: String(v) }; }',
    'function quote(text: string): string { return text; }',
    'export function run(): void { bind(); log(); }',
    'function bind(): void {}',
    'function log(): void {}',
    '',
  ].join('\n'));
});

test('overloads and a get/set pair move as one unit', () => {
  // Break: one overload or accessor half moves without the other.
  assert.equal(fixed([
    'function helper(n: number): number;',
    'function helper(n: string): string;',
    'function helper(n: number | string) { return n; }',
    'export function run() { helper(1); }',
    '',
  ].join('\n')), [
    'export function run() { helper(1); }',
    'function helper(n: number): number;',
    'function helper(n: string): string;',
    'function helper(n: number | string) { return n; }',
    '',
  ].join('\n'));
  assert.equal(fixed([
    'class S {',
    '  private n = 0;',
    '  private get value() { return this.n; }',
    '  private set value(v: number) { this.n = v; }',
    '  run() { this.value = this.value + 1; }',
    '}',
    '',
  ].join('\n')), [
    'class S {',
    '  private n = 0;',
    '  run() { this.value = this.value + 1; }',
    '  private get value() { return this.n; }',
    '  private set value(v: number) { this.n = v; }',
    '}',
    '',
  ].join('\n'));
});

test('a scope that already passes is left alone', () => {
  // Break: the fixer rewrites every scope into canonical order, so a
  // hand-placed diamond is lost.
  const source = 'export function a() { c(); }\nfunction c() {}\nexport function b() { c(); }\n';
  assert.equal(fixed(source), source);
});

test('two items on one line are reported, never rewritten', () => {
  // Break: the fixer splices a line it cannot split.
  const source = 'function helper() {} export function run() { helper(); }\n';
  const result: { text: string; problems: string[] } = fixSource('f.ts', source);
  assert.equal(result.text, source);
  assert.deepEqual(result.problems, ['f.ts: two items share line 1']);
});

test('the fix never moves a class below a statement that uses it at load time', () => {
  // Break: the fixer trusts the canonical order and leaves `new A()` above `class A`.
  const source = 'interface B { n: number }\nclass A {}\nconst a = new A();\nfunction bText(b: B): string { return String(b.n); }\n';
  const result: { text: string; problems: string[] } = fixSource('f.ts', source);
  assert.equal(result.text, source);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? '', /f\.ts: .*load order/);
});

/** A temporary copy of a small tree: `src/<file>` for each entry. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'item-order-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function cli(root: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the lint fails on a tree out of order, names the site, and skips fixture directories', () => {
  // Break: the lint exits 0 on a breach, or reads fixtures that are out of order on purpose.
  const root = tree({
    'src/a.ts': 'function helper() {}\nexport function run() { helper(); }\n',
    'src/fixtures/b.ts': 'function helper() {}\nexport function run() { helper(); }\n',
    'scripts/c.mjs': 'function helper() {}\nfunction run() { helper(); }\nrun();\n',
  });
  try {
    const { status, output } = cli(root);
    assert.equal(status, 1);
    assert.match(output, /src\/a\.ts: rule 2: function helper comes before every caller \(function run\)/);
    assert.match(output, /scripts\/c\.mjs: rule 2: function helper comes before every caller \(function run\)/);
    assert.doesNotMatch(output, /fixtures/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

const BEFORE = 'function helper() {}\n\n/** Entry. */\nexport function run() { helper(); }\n\nclass S {\n  private h() {}\n  m() { this.h(); }\n}\n';

test('the fixer is idempotent and its output passes the lint', () => {
  // Break: a second run still finds something to move, or the rewrite breaks a rule.
  const root = tree({
    'src/a.ts': BEFORE,
  });
  try {
    assert.equal(cli(root, '--fix').status, 0);
    const once = readFileSync(join(root, 'src/a.ts'), 'utf8');
    assert.notEqual(once, BEFORE);
    assert.equal(cli(root, '--fix').status, 0);
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), once);
    assert.equal(cli(root).status, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});
