// Guard: the words spec v3 wants gone from the domain, counted over src/domain.
//
// Spec v3 rule 0.1: the domain holds state types, pure updates and derivations;
// no plans, generators, effects, Home Assistant names or carried documents.
// Rule 0.3: ids, ranges and closed sets are built once in src/parse, so the
// domain never re-checks, defaults or casts. Each column below counts one sign
// that a file is not there yet. Ceilings live in `domain-words.ceilings.json`
// and ratchet DOWN only. Each count must equal its ceiling: a rise fails, and
// so does a fall until the ceiling is lowered to the new count. A ceiling is a
// house-wide total, so slack left by a fall would absorb a later rise in
// another file. Raising a ceiling is the regression this guard exists to
// catch; argue any raise in the commit message.
//
// Columns are read with the TypeScript compiler API (comments are never code),
// except `haNames`, which is a text match over each string or template literal.
// - generators: `function*`.
// - yields: `yield` and `yield*`.
// - planTypes: a `Plan<...>` type reference.
// - effectKinds: an object literal's `kind:` set to an effect kind
//   ('service', 'event', 'script', 'state', 'schedule').
// - haNames: a literal holding a Home Assistant name: `<ha domain>.<object>`
//   (or the bare `<ha domain>.` a template builds on), a helper domain on its
//   own (`input_number`), or a script or event name (`ls_...`, `effects_...`).
//   Import paths are not literals here.
// - parseRuntimeImports: an import or re-export from src/parse or src/runtime.
// - viewReads: a property read on a `HouseView`, whatever the variable is called:
//   `view.x`, `view['x']`, and each name destructured from one (`const { x } = view`,
//   or a destructured HouseView parameter).
// - carriedTypes: a type reference to a carried document type
//   (`Verbatim`, `OpaqueMap`, `StoredFact`, `StoredValue`, `Assembled`, `AssembledMap`),
//   directly or through a project type alias that renames or contains one.
// - casts: `x as T` or `<T>x`; `as const` is not a cast.
// - nonNull: postfix `!`.
// - nullish: `??` and `??=`.
// - typeofs: a runtime `typeof x` test; `typeof x` in a type is not one.
// - literalIncludes: `.includes(` on an array literal, or on a const bound to one.
// - brandConstructors: a call to a function declared in src/parse/ids.ts, or a
//   cast to a type that holds one declared under src/domain/types (a brand or
//   a range), as the checker resolves it, so a local alias is seen through.
//
// Usage: node scripts/domain-words.mjs [--root <dir>] [--ceilings <file>] [--files] [--json]
// `--files` adds the per-file table; `--json` prints `{ totals, files }` instead of tables.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fail, option, project, ts } from './ts-project.mjs';

const { root, program, checker, name, under, resolved } = project();
const CEILINGS = resolve(option('--ceilings') ?? join(root, 'domain-words.ceilings.json'));
const inDomain = under('src/domain');
const inDomainTypes = under('src/domain/types');
const inSource = under('src');
const isParseIds = file => resolve(file) === join(root, 'src', 'parse', 'ids.ts');
const inParseOrRuntime = file => [join(root, 'src', 'parse'), join(root, 'src', 'runtime')].some(dir => resolve(file).startsWith(dir + sep));

const COLUMNS = {
  generators: 'function*',
  yields: 'yield',
  planTypes: 'Plan<',
  effectKinds: "kind: 'service' etc.",
  haNames: 'Home Assistant names',
  parseRuntimeImports: '../parse, ../runtime imports',
  viewReads: 'view. reads',
  carriedTypes: 'carried types',
  casts: 'as (not as const)',
  nonNull: 'postfix !',
  nullish: '??',
  typeofs: 'typeof',
  literalIncludes: '.includes( on a literal array',
  brandConstructors: 'brand constructors',
};

const EFFECT_KINDS = new Set(['service', 'event', 'script', 'state', 'schedule']);
const CARRIED = new Set(['Verbatim', 'OpaqueMap', 'StoredFact', 'StoredValue', 'Assembled', 'AssembledMap']);
const HA_DOMAINS = [
  'automation', 'binary_sensor', 'homeassistant', 'input_boolean', 'input_datetime', 'input_number', 'input_select',
  'input_text', 'light', 'mqtt', 'person', 'scene', 'script', 'select', 'sensor', 'sun', 'switch', 'timer', 'variable', 'zone',
];
const HA_NAME = new RegExp([
  `(?<![A-Za-z0-9_])(?:${HA_DOMAINS.join('|')})\\.(?=[a-z0-9_$]|$)`,
  '^(?:binary_sensor|input_(?:boolean|datetime|number|select|text))$',
  '(?<![A-Za-z0-9_])(?:ls|effects)_[a-z0-9_]*',
].join('|'));
/** Stands in for a template's `${...}` so `script.${name}` reads as `script.$`. */
const HOLE = '$';

const isModuleSpecifier = node => {
  const parent = node.parent;
  return (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
    || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
};

const unwrap = node => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
};

const isAsConst = node => ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'const';

function measure(source) {
  const row = Object.fromEntries(Object.keys(COLUMNS).map(column => [column, 0]));
  const visit = node => {
    if (ts.isFunctionLike(node) && node.asteriskToken !== undefined) row.generators++;
    else if (ts.isYieldExpression(node)) row.yields++;
    else if (ts.isTypeReferenceNode(node)) {
      const typeName = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
      if (typeName === 'Plan') row.planTypes++;
      if (namesCarriedType(node)) row.carriedTypes++;
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'kind'
      && ts.isStringLiteralLike(node.initializer) && EFFECT_KINDS.has(node.initializer.text)) row.effectKinds++;
    else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
      && inParseOrRuntime(resolve(dirname(source.fileName), node.moduleSpecifier.text))) row.parseRuntimeImports++;
    else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isHouseView(node.expression)) row.viewReads++;
    // `const { rooms } = view` and a destructured HouseView parameter: one read per name taken.
    else if (ts.isObjectBindingPattern(node) && isHouseView(node)) row.viewReads += node.elements.length;
    else if (ts.isNonNullExpression(node)) row.nonNull++;
    else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) row.nullish++;
    else if (ts.isTypeOfExpression(node)) row.typeofs++;
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'includes') {
        const receiver = unwrap(callee.expression);
        if (ts.isArrayLiteralExpression(receiver) || ts.isIdentifier(receiver) && boundToArrayLiteral(receiver)) row.literalIncludes++;
      }
      const target = resolved(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee));
      if ((target?.declarations ?? []).some(declaration => isParseIds(declaration.getSourceFile().fileName))) row.brandConstructors++;
    }
    if ((ts.isAsExpression(node) && !isAsConst(node)) || ts.isTypeAssertionExpression(node)) {
      row.casts++;
      if (namesDomainType(node.type)) row.brandConstructors++;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && !isModuleSpecifier(node) && HA_NAME.test(literalText(node))) row.haNames++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return row;
}

/**
 * Does this type reference name a carried document type? Directly, or through
 * a type alias the checker resolves it to, followed through the syntax that
 * only renames or contains (another reference and its type arguments, a
 * union, an intersection, an array, a tuple, parentheses, `readonly`). A
 * named object type is not carried, though a field of it may be: that field
 * is counted where it is written.
 */
function namesCarriedType(reference, seen = new Set()) {
  const typeName = ts.isIdentifier(reference.typeName) ? reference.typeName.text : reference.typeName.right.text;
  const symbol = resolved(checker.getSymbolAtLocation(reference.typeName));
  if (CARRIED.has(symbol === undefined ? typeName : symbol.name)) return true;
  if (symbol === undefined || seen.has(symbol)) return false;
  seen.add(symbol);
  return declarationsOf(symbol).some(declaration => ts.isTypeAliasDeclaration(declaration)
    && inSource(declaration.getSourceFile().fileName) && carriedWithin(declaration.type, seen));
}

/** A symbol's declarations; none for no symbol. */
const declarationsOf = symbol => symbol === undefined || symbol.declarations === undefined ? [] : symbol.declarations;
const declaredInDomainTypes = symbol => declarationsOf(symbol).some(declaration => inDomainTypes(declaration.getSourceFile().fileName));

function carriedWithin(node, seen) {
  if (ts.isTypeReferenceNode(node)) {
    return namesCarriedType(node, seen) || (node.typeArguments !== undefined && node.typeArguments.some(argument => carriedWithin(argument, seen)));
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.some(member => carriedWithin(member, seen));
  if (ts.isArrayTypeNode(node)) return carriedWithin(node.elementType, seen);
  if (ts.isTupleTypeNode(node)) return node.elements.some(element => carriedWithin(element, seen));
  if (ts.isNamedTupleMember(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node) || ts.isParenthesizedTypeNode(node)
    || ts.isTypeOperatorNode(node)) return carriedWithin(node.type, seen);
  return false;
}
const namesDomainType = typeNode => holdsDomainType(checker.getTypeFromTypeNode(typeNode), new Set());

function isHouseView(expression) {
  const type = checker.getTypeAtLocation(expression);
  return type.aliasSymbol?.name === 'HouseView' || type.getSymbol()?.name === 'HouseView';
}
function boundToArrayLiteral(identifier) {
  const symbol = resolved(checker.getSymbolAtLocation(identifier));
  const declaration = symbol?.valueDeclaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration)
    && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    && declaration.initializer !== undefined && ts.isArrayLiteralExpression(unwrap(declaration.initializer));
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(HOLE);
}

/**
 * Does the type, as the checker resolves it, hold a type declared under
 * src/domain/types? Resolved, not read off the written name, so a local alias
 * (`type R = RoomId; x as R`) is seen through. The same walk as
 * `tests/runtime/domain-type-casts.test.ts`.
 */
function holdsDomainType(type, seen) {
  if (seen.has(type)) return false;
  seen.add(type);
  // A type parameter is declared where its generic is (`entriesOf`'s `K`), not a type declared there.
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return false;
  if (declaredInDomainTypes(type.aliasSymbol) || declaredInDomainTypes(type.getSymbol())) return true;
  if (type.isUnionOrIntersection()) return type.types.some(member => holdsDomainType(member, seen));
  if (type.aliasTypeArguments !== undefined && type.aliasTypeArguments.some(argument => holdsDomainType(argument, seen))) return true;
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  return checker.getIndexInfosOfType(type).some(info => holdsDomainType(info.keyType, seen) || holdsDomainType(info.type, seen))
    || checker.getPropertiesOfType(type).some(property => holdsDomainType(checker.getTypeOfSymbol(property), seen));
}

const files = {};
const totals = Object.fromEntries(Object.keys(COLUMNS).map(column => [column, 0]));
for (const source of [...program.getSourceFiles()].filter(file => inDomain(file.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))) {
  const row = measure(source);
  files[name(source.fileName)] = row;
  for (const column of Object.keys(COLUMNS)) totals[column] += row[column];
}

let ceilings;
try {
  ceilings = JSON.parse(readFileSync(CEILINGS, 'utf8'));
} catch (error) {
  fail(`cannot read ${CEILINGS}: ${error.message}`);
}
for (const column of Object.keys(COLUMNS)) {
  if (!Number.isInteger(ceilings[column]) || ceilings[column] < 0) fail(`${CEILINGS} needs a whole-number ceiling for ${column}`);
}
for (const column of Object.keys(ceilings)) {
  if (!(column in COLUMNS)) fail(`${CEILINGS} names ${column}, which is not a column`);
}

const over = Object.keys(COLUMNS).filter(column => totals[column] > ceilings[column]);
const slack = Object.keys(COLUMNS).filter(column => totals[column] < ceilings[column]);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ totals, files }));
} else {
  const width = Math.max(...Object.keys(COLUMNS).map(column => column.length));
  const labelWidth = Math.max(...Object.values(COLUMNS).map(label => label.length));
  console.log('src/domain — words the domain should not hold\n');
  console.log(`${'column'.padEnd(width)}  ${'counts'.padEnd(labelWidth)}  ${'total'.padStart(6)}  ${'ceiling'.padStart(7)}`);
  for (const [column, label] of Object.entries(COLUMNS)) {
    console.log(`${column.padEnd(width)}  ${label.padEnd(labelWidth)}  ${String(totals[column]).padStart(6)}  ${String(ceilings[column]).padStart(7)}`);
  }
  if (process.argv.includes('--files')) {
    const keys = Object.keys(COLUMNS), fileWidth = Math.max(...Object.keys(files).map(file => file.length), 4);
    console.log(`\n${'file'.padEnd(fileWidth)}  ${keys.map((_, index) => String(index + 1).padStart(4)).join('')}`);
    for (const [file, row] of Object.entries(files)) {
      console.log(`${file.padEnd(fileWidth)}  ${keys.map(column => String(row[column]).padStart(4)).join('')}`);
    }
    console.log(`(columns 1-${keys.length} in the order above)`);
  }
}

if (over.length > 0) {
  console.error('\nFAIL: a word the domain should not hold rose above its ceiling.');
  for (const column of over) console.error(`  ${column}: ${totals[column]} exceeds the ceiling of ${ceilings[column]}`);
  console.error('Run with --files to see where. Do not raise the ceiling.');
  process.exit(1);
}
if (slack.length > 0) {
  console.error('\nFAIL: a count fell below its ceiling. Progress made: lower these ceilings in domain-words.ceilings.json to the new count:');
  for (const column of slack) console.error(`  ${column}: ${ceilings[column]} -> ${totals[column]}`);
  process.exit(1);
}
// With --json, stdout is the document alone.
if (!process.argv.includes('--json')) console.log('\nOK: every count sits exactly at its ceiling.');
