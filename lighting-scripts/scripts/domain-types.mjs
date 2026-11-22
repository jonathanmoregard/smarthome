// Guard: the domain speaks in domain types, not in plain `string` and `number`.
//
// Spec v3 rule 0.3: a closed set is a labelled sum type, a numeric range is a
// range type and an identifier is a branded id. Plain `string`/`number` in an
// exported `src/domain` signature is allowed only where the allowlist says why
// the value really is open (spec v3 section 3.4).
//
// What counts as a site, read with the TypeScript compiler API (no regex):
// every `string` or `number` keyword in
// - an exported function's type parameters, parameters and return type;
// - an exported variable's type annotation, or the signature of the function it
//   is initialised with;
// - an exported type alias or interface, members and heritage included;
// - and, transitively, every type alias, interface, class or enum declared
//   under `src/` that one of those names. A plain field one type away is as
//   much part of the signature as a plain parameter, wherever the type is
//   declared (a parse result in `src/parse`, a runtime type in `src/runtime`).
//   Following is by name: an interface is read whole even when it is reached
//   through `Pick<...>`.
// - the inferred return type of any of those functions written without one:
//   a plain `string`/`number` in it is a site at the function, followed into
//   unions, arrays, tuples and anonymous objects, with named types followed to
//   their declarations as above.
// Function bodies and unexported declarations nothing exported reaches are not
// sites: the guard reads what a signature says, or what the checker says it returns.
//
// `domain-types.allow.json` holds two kinds of entry:
// - `allow`: `{ file, symbol, reason }`. Covers the sites of one symbol (and
//   everything under it: `Lamp` covers `Lamp.level`). The reason is required.
//   An entry that covers no site fails, so it cannot linger and later excuse
//   a new site under its name.
// - `ceilings`: `{ file, ceiling, reason }`. A ratchet, not a permission: the
//   file holds exactly that many sites no `allow` entry covers. A rise fails,
//   and so does a fall until the ceiling is lowered to the new count, so slack
//   never absorbs a later rise.
//
// Usage: node scripts/domain-types.mjs [--root <dir>] [--allow <file>] [--list]
// `--list` prints every uncovered site, not only those in files over their ceiling.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, option, project, ts } from './ts-project.mjs';

const { root, program, checker, name: relativeName, under, resolved } = project();
const ALLOW = resolve(option('--allow') ?? join(root, 'domain-types.allow.json'));
const LIST = process.argv.includes('--list');
const inSrc = under('src');
const inDomain = under('src/domain');

const FOLLOWED = new Set([
  ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration,
]);

/** Every site found, keyed by file and position so a type reached twice counts once. */
const sites = new Map();
const visited = new Set();

function follow(nameNode) {
  const symbol = resolved(checker.getSymbolAtLocation(nameNode));
  for (const declaration of symbol?.declarations ?? []) {
    if (FOLLOWED.has(declaration.kind) && inSrc(declaration.getSourceFile().fileName)) scanDeclaration(declaration);
  }
}

const nameText = name => name === undefined ? undefined : ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();

function scanDeclaration(declaration) {
  if (visited.has(declaration)) return;
  visited.add(declaration);
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) scanSignature(declaration, declaration);
  else if (ts.isVariableDeclaration(declaration)) {
    const init = declaration.initializer;
    if (declaration.type !== undefined) scanType(declaration.type, declaration);
    else if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) scanSignature(init, declaration);
  } else if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    ts.forEachChild(declaration, child => scanType(child, declaration));
  } else if (ts.isClassDeclaration(declaration)) {
    for (const member of declaration.members) {
      const hidden = ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected);
      if (hidden !== 0 || (member.name !== undefined && ts.isPrivateIdentifier(member.name))) continue;
      if (ts.isPropertyDeclaration(member)) scanType(member.type, declaration);
      else if (ts.isFunctionLike(member)) scanSignature(member, declaration);
    }
  }
}

function scanSignature(fn, top) {
  for (const parameter of fn.typeParameters ?? []) scanType(parameter, top);
  for (const parameter of fn.parameters) scanType(parameter.type, top);
  if (fn.type !== undefined) scanType(fn.type, top);
  else {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (signature !== undefined) scanInferred(checker.getReturnTypeOfSignature(signature), fn, top, ['return'], new Set());
  }
}

function scanType(node, top) {
  if (node === undefined) return;
  if (node.kind === ts.SyntaxKind.StringKeyword || node.kind === ts.SyntaxKind.NumberKeyword) {
    const source = node.getSourceFile();
    const file = relativeName(source.fileName);
    sites.set(`${file}:${node.pos}`, {
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      symbol: symbolPath(node, top),
      keyword: node.kind === ts.SyntaxKind.StringKeyword ? 'string' : 'number',
    });
    return;
  }
  // `typeof x` names a value's type; it holds no keyword of its own.
  if (ts.isTypeQueryNode(node)) return;
  if (ts.isTypeReferenceNode(node)) follow(node.typeName);
  if (ts.isExpressionWithTypeArguments(node)) follow(node.expression);
  ts.forEachChild(node, child => scanType(child, top));
}

/** `Lamp.level`, `lampOf.room`, `controlTopic.return.alias`: the top-level name, then the members down to the site. */
function symbolPath(node, top) {
  const parts = [];
  for (let child = node, parent = node.parent; parent !== undefined && child !== top; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent) && parent.type === child) parts.push('return');
    else if (ts.isParameter(child)) parts.push(ts.isIdentifier(child.name) ? child.name.text : '{}');
    else if (ts.isPropertySignature(child) || ts.isPropertyDeclaration(child) || ts.isMethodSignature(child)
      || ts.isMethodDeclaration(child) || ts.isGetAccessor(child) || ts.isSetAccessor(child)) parts.push(nameText(child.name));
    else if (ts.isIndexSignatureDeclaration(child)) parts.push('[key]');
    else if (ts.isTypeParameterDeclaration(child)) parts.push(child.name.text);
  }
  const topName = ts.isVariableDeclaration(top) ? nameText(top.name) : nameText(top.name) ?? 'default';
  return [topName, ...parts.reverse()].join('.');
}

/**
 * A plain `string`/`number` in a type the checker inferred: the return type of
 * a function with no annotation. There is no keyword to point at, so the site
 * is the function, with the path down to the plain member (`lampView.return.level`).
 * A named type is followed to its declaration, as a written reference is; a
 * branded id is an intersection and a literal is a closed set, so neither is plain.
 */
function scanInferred(type, fn, top, path, seen) {
  if (seen.has(type)) return;
  seen.add(type);
  if ((type.flags & (ts.TypeFlags.String | ts.TypeFlags.Number)) !== 0) {
    const source = fn.getSourceFile();
    const file = relativeName(source.fileName);
    const at = fn.name ?? fn;
    sites.set(`${file}:${at.pos}:${path.join('.')}`, {
      file,
      line: source.getLineAndCharacterOfPosition(at.getStart()).line + 1,
      symbol: [symbolPath(fn, top), ...path].join('.'),
      keyword: (type.flags & ts.TypeFlags.String) !== 0 ? 'string' : 'number',
    });
    return;
  }
  if (type.isUnion()) {
    for (const member of type.types) scanInferred(member, fn, top, path, seen);
    return;
  }
  if (type.isIntersection()) return;
  const named = type.aliasSymbol ?? ((type.flags & ts.TypeFlags.Object) !== 0
    && (type.objectFlags & (ts.ObjectFlags.Anonymous | ts.ObjectFlags.ObjectLiteral)) === 0 ? type.getSymbol() : undefined);
  const declared = (named?.declarations ?? []).filter(declaration => FOLLOWED.has(declaration.kind));
  if (declared.length > 0) {
    for (const declaration of declared) if (inSrc(declaration.getSourceFile().fileName)) scanDeclaration(declaration);
    return;
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const element of checker.getTypeArguments(type)) scanInferred(element, fn, top, [...path, '[]'], seen);
    return;
  }
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    for (const property of checker.getPropertiesOfType(type)) {
      scanInferred(checker.getTypeOfSymbol(property), fn, top, [...path, property.name], seen);
    }
  }
}

for (const source of program.getSourceFiles()) {
  if (!inDomain(source.fileName)) continue;
  const module = checker.getSymbolAtLocation(source);
  if (module === undefined) continue;
  for (const exported of checker.getExportsOfModule(module)) {
    for (const declaration of resolved(exported)?.declarations ?? []) {
      if (inSrc(declaration.getSourceFile().fileName)) scanDeclaration(declaration);
    }
  }
}

// --- The allowlist ---------------------------------------------------------

let allowDocument;
try {
  allowDocument = JSON.parse(readFileSync(ALLOW, 'utf8'));
} catch (error) {
  fail(`cannot read ${ALLOW}: ${error.message}`);
}
const allow = allowDocument.allow ?? [];
const ceilingEntries = allowDocument.ceilings ?? [];
const text = value => typeof value === 'string' && value.trim().length > 0;
for (const entry of allow) {
  if (!text(entry.file) || !text(entry.symbol) || !text(entry.reason)) {
    fail(`allow entry ${JSON.stringify(entry)} needs a file, a symbol and a reason`);
  }
}
const ceilings = new Map();
for (const entry of ceilingEntries) {
  if (!text(entry.file) || !Number.isInteger(entry.ceiling) || entry.ceiling < 0 || !text(entry.reason)) {
    fail(`ceiling entry ${JSON.stringify(entry)} needs a file, a whole-number ceiling and a reason`);
  }
  if (ceilings.has(entry.file)) fail(`two ceilings for ${entry.file}`);
  ceilings.set(entry.file, entry.ceiling);
}

const covers = (entry, site) => entry.file === site.file
  && (site.symbol === entry.symbol || site.symbol.startsWith(`${entry.symbol}.`));

const ordered = [...sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const used = new Set();
const uncovered = new Map();
for (const site of ordered) {
  const entry = allow.find(candidate => covers(candidate, site));
  if (entry !== undefined) used.add(entry);
  else uncovered.set(site.file, [...(uncovered.get(site.file) ?? []), site]);
}

// --- Report ----------------------------------------------------------------

const files = [...new Set([...uncovered.keys(), ...ceilings.keys()])].sort();
const width = Math.max(...files.map(file => file.length), 8);
console.log('Plain string/number in exported src/domain signatures (and the types they reach)\n');
console.log(`${'file'.padEnd(width)}  ${'sites'.padStart(7)}  ${'ceiling'.padStart(7)}`);
let total = 0, totalCeiling = 0;
const over = [], slack = [];
for (const file of files) {
  const count = uncovered.get(file)?.length ?? 0, ceiling = ceilings.get(file) ?? 0;
  total += count;
  totalCeiling += ceiling;
  console.log(`${file.padEnd(width)}  ${String(count).padStart(7)}  ${String(ceiling).padStart(7)}`);
  if (count > ceiling) over.push(file);
  else if (count < ceiling) slack.push({ file, ceiling, count });
}
console.log(`${'TOTAL'.padEnd(width)}  ${String(total).padStart(7)}  ${String(totalCeiling).padStart(7)}`);
console.log(`allowed by name: ${ordered.length - total} site(s) under ${allow.length} entr${allow.length === 1 ? 'y' : 'ies'}`);

const describeSite = site => `  ${site.file}:${site.line}  ${site.symbol}  ${site.keyword}`;
if (LIST) {
  console.log('\nUncovered sites:');
  for (const file of files) for (const site of uncovered.get(file) ?? []) console.log(describeSite(site));
}

const stale = allow.filter(entry => !used.has(entry));

if (over.length > 0) {
  console.error('\nFAIL: plain string/number rose above its ceiling.');
  for (const file of over) {
    console.error(`  ${file}: ${uncovered.get(file)?.length ?? 0} exceeds the ceiling of ${ceilings.get(file) ?? 0}`);
    for (const site of uncovered.get(file) ?? []) console.error(describeSite(site));
  }
  console.error('Give the value its domain type (a branded id, a range or a sum type), built in src/parse.');
  console.error('Only a value that really is open gets an allow entry, with its reason. Do not raise a ceiling.');
  process.exit(1);
}
if (slack.length > 0) {
  console.error('\nFAIL: a count fell below its ceiling. Progress made: lower these ceilings in domain-types.allow.json to the new count:');
  for (const { file, ceiling, count } of slack) console.error(`  ${file}: ${ceiling} -> ${count}`);
  process.exit(1);
}
// A stale entry would later excuse a new site under its name, so it fails as slack does.
if (stale.length > 0) {
  console.error('\nFAIL: these allow entries cover no site any more. Progress made: remove them from domain-types.allow.json:');
  for (const entry of stale) console.error(`  ${entry.file}  ${entry.symbol}`);
  process.exit(1);
}
console.log('\nOK: every count sits exactly at its ceiling, and every allow entry covers a site.');
