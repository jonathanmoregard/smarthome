// Guard: a value that is not text is not joined into text.
//
// An id, an entity name or a mapping key built from `String(x)`, `${x}` or
// `'...' + x` reads whatever `x` happens to be: a lamp in no room names the
// entity `sensor.ls_cache_null`, a saved selection of 5 names the instance
// `key:5`. The rule is parse, don't validate: the edge parses the value into
// text (or a no-value case) and only text is joined.
//
// A site, read with the TypeScript compiler API in src/parse, src/domain and
// src/handlers (src/runtime is the adapter, which writes wire text):
// - a call to the global `String(x)`;
// - a template hole `${x}` (a tagged template hands `x` to its tag, not a join);
// - a `+` whose result is a string, or a `+=` onto a string, for each operand;
// where the checker's type of `x` is not assignable to string, number or
// bigint, member by member (a brand, a literal union and a type parameter
// bounded by string are text). So a JSON value, a boolean, an object,
// `unknown`, `any`, and text that may be null or undefined are sites.
//
// `stringified.kept.json` lists every site kept on purpose:
// `{ file, within, text, sites, reason }`, where `within` is the function the
// site is in (a named function or method, or the variable or property an
// arrow or function expression is bound to; `(module)` at the top level),
// `text` is the site's source text and `sites` how many sites the entry
// covers. The reason is required. A site no entry keeps fails, and so does an
// entry that covers a different number of sites than it says: a fall asks for
// the entry to be lowered or removed, so a fixed site's entry cannot later
// keep a new one. The column's ceiling is the kept total.
//
// Usage: node scripts/stringified.mjs [--root <dir>] [--kept <file>] [--list] [--json]
// `--list` prints every site; `--json` prints `{ sites }` instead of the report.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, option, project, ts } from './ts-project.mjs';

const { root, program, checker, name, under } = project();
const KEPT = resolve(option('--kept') === undefined ? join(root, 'stringified.kept.json') : option('--kept'));
const SCOPES = ['src/parse', 'src/domain', 'src/handlers'].map(under);
const inScope = file => SCOPES.some(scope => scope(file));

const TEXT = [checker.getStringType(), checker.getNumberType(), checker.getBigIntType()];
const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

function measure(source) {
  const found = [];
  const site = (node, text, value) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({
      file: name(source.fileName), line: line + 1, within: within(node), text: oneLine(text),
      type: checker.typeToString(checker.getTypeAtLocation(value)),
    });
  };
  const visit = node => {
    if (ts.isCallExpression(node) && isGlobalString(node.expression) && node.arguments.length > 0) {
      const [value] = node.arguments;
      if (!isText(checker.getTypeAtLocation(value))) site(node, node.getText(source), value);
    } else if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
      for (const span of node.templateSpans) {
        if (!isText(checker.getTypeAtLocation(span.expression))) site(span.expression, `\${${span.expression.getText(source)}}`, span.expression);
      }
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const operands = operator === ts.SyntaxKind.PlusToken && isStringResult(node) ? [node.left, node.right]
        : operator === ts.SyntaxKind.PlusEqualsToken && isStringResult(node.left) ? [node.right] : [];
      for (const operand of operands) {
        if (!isText(checker.getTypeAtLocation(operand))) site(node, node.getText(source), operand);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
const isStringResult = node => (checker.getTypeAtLocation(node).flags & ts.TypeFlags.StringLike) !== 0;

/** The function a site is in: its own name, or the name it is bound to; `(module)` at the top level. */
function within(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current)) break;
    if (!ts.isFunctionLike(current)) continue;
    const own = nameOf(current.name);
    if (own !== undefined) return own;
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      const bound = nameOf(parent.name);
      if (bound !== undefined) return bound;
    }
  }
  return '(module)';
}

const nameOf = node => node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node))
  ? node.text : undefined;

function isGlobalString(callee) {
  if (!ts.isIdentifier(callee) || callee.text !== 'String') return false;
  const symbol = checker.getSymbolAtLocation(callee);
  const declarations = symbol === undefined || symbol.declarations === undefined ? [] : symbol.declarations;
  // The global is declared in the default library (and augmented by @types/node); a local shadow is not.
  return declarations.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
}

const oneLine = text => text.replace(/\s+/g, ' ');

/** Is every member of the type text, a number or a bigint? */
function isText(type) {
  if ((type.flags & UNTYPED) !== 0) return false;
  if (type.isUnion()) return type.types.every(isText);
  return TEXT.some(target => checker.isTypeAssignableTo(type, target));
}

const sites = [...program.getSourceFiles()]
  .filter(source => inScope(source.fileName))
  .sort((a, b) => a.fileName.localeCompare(b.fileName))
  .flatMap(measure);

let kept;
try {
  kept = JSON.parse(readFileSync(KEPT, 'utf8')).kept;
} catch (error) {
  fail(`cannot read ${KEPT}: ${error.message}`);
}
if (!Array.isArray(kept)) fail(`${KEPT} needs a "kept" list`);
const keyOf = entry => `${entry.file} ${entry.within} ${entry.text}`;
const entries = new Map();
for (const entry of kept) {
  for (const field of ['file', 'within', 'text', 'reason']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') fail(`${KEPT}: every kept entry needs a ${field} (${JSON.stringify(entry)})`);
  }
  if (!Number.isInteger(entry.sites) || entry.sites < 1) fail(`${KEPT}: ${keyOf(entry)} needs a whole-number sites count of at least 1`);
  if (entries.has(keyOf(entry))) fail(`${KEPT}: ${keyOf(entry)} is listed twice`);
  entries.set(keyOf(entry), entry);
}

const covered = new Map([...entries.keys()].map(key => [key, 0]));
const unkept = [];
for (const found of sites) {
  const key = keyOf(found);
  if (covered.has(key)) covered.set(key, covered.get(key) + 1);
  else unkept.push(found);
}
const miscounted = [...entries.values()].filter(entry => covered.get(keyOf(entry)) !== entry.sites);
const keptTotal = [...entries.values()].reduce((total, entry) => total + entry.sites, 0);
const describe = found => `${found.file}:${found.line} ${found.within} ${found.text}  (${found.type})`;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ sites }));
} else {
  console.log('src/parse, src/domain, src/handlers — values that are not text joined into text\n');
  if (process.argv.includes('--list')) for (const found of sites) console.log(`  ${describe(found)}`);
  console.log(`stringified: ${sites.length} site(s), ${keptTotal} kept`);
}

if (unkept.length > 0 || miscounted.length > 0) {
  if (unkept.length > 0) {
    console.error('\nFAIL: a value that is not text is joined into text. Parse it to text (or a no-value case) at the edge, or keep it with a reason in stringified.kept.json:');
    for (const found of unkept) console.error(`  ${describe(found)}`);
  }
  if (miscounted.length > 0) {
    console.error('\nFAIL: a kept entry covers a different number of sites than it says. Lower or remove it when sites were fixed; a rise is a new site:');
    for (const entry of miscounted) console.error(`  ${keyOf(entry)}: covers ${covered.get(keyOf(entry))} site(s), not ${entry.sites}`);
  }
  process.exit(1);
}
if (!process.argv.includes('--json')) console.log('\nOK: every site is kept, with a reason, at its count.');
