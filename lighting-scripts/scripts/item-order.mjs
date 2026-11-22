// Guard: source files read top to bottom, types first, then functions in call
// order (PR #39 review, comment 4657187381). The TypeScript twin of klaffat's
// `crates/klaffat-app/tests/item_order_lint.rs` (the "stepdown rule").
//
// Each scope is judged on its own: a file, and each class body.
//
// 1. Types first, each with its own code. A type declaration (interface, type
//    alias, class) is followed by the functions it owns, then by their
//    helpers, before the next type starts. All type groups come before the
//    remaining free functions.
//    - A function is owned by a file-local type T when T is the only
//      file-local type its written signature names (parameters, type
//      parameters, return type). Two or more, or none: the function is free.
//    - A class also owns its body (its methods), which is a scope of its own.
//    - A helper is a free function only the group's code (the class body, the
//      owned functions, other helpers) calls.
//    - Within a group, rules 2 to 4 order the owned functions as they order a
//      class's methods; only the group's own code counts as their caller, as
//      the Rust lint does not see `Type::m` from module scope.
// 2. Callee below a caller: a function called from the same scope sits below
//    at least one of its callers.
// 3. A single-use helper sits inside its caller's block: if a function has
//    exactly one caller of its own kind (free, owned by the same type, or
//    helper of the same type), everything between the two is something that
//    caller calls.
// 4. Public entry points first: among the functions nothing in the scope
//    calls, the public ones come before the private ones. Public is `export`
//    (with `export { x }` lists and default exports); in a class, not
//    `private`, `protected` or `#`. A constructor is public.
// 5. Tables after their types: a fixed item sits below the definition of
//    every file-local type it names. A type derived from a value
//    (`type Block = (typeof BLOCKS)[number]`) is pinned: it never moves, and
//    sits below every const it reads.
//
// Calls are resolved with the checker's symbols, one file at a time, so
// shadowing is handled: `f(..)`, a function passed as a value (`xs.map(f)`,
// `{ f }`), `this.m(..)`, `this.m` and `C.m(..)`. Type positions are not
// calls. Recursion and call cycles are ignored.
//
// Fixed items never move: imports, `export` lists, top-level `const`/`let`
// and statements, and in a class its properties. A fixed item whose value is
// a function (`const f = () => g()`, an arrow class property) is a caller;
// other fixed items, tables included, are not.
//
// `--fix` (`npm run fix:item-order`) rewrites each scope that breaks rules 1
// to 4 into the canonical order: type groups in their current order (the
// type, its owned functions depth first from the public ones, then its
// helpers), then a depth-first walk from the public roots, then the private
// roots. Fixed items keep their slots; items move as whole lines with their
// comments. A scope that already passes is left alone. A rewrite is kept only
// if the scope then passes and the checker reports no new "used before its
// declaration" error, so a class never moves below a statement that uses it
// at load time. Otherwise, and for rule 5, the scope is reported to be fixed
// by hand.
//
// Usage: node scripts/item-order.mjs [--root <dir>] [--fix] [--owners <file>]
// Reads `src/**/*.ts` and `scripts/*.mjs` under the root, skipping fixtures.
// `--owners <file>` prints which type owns each function of one file.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, ts } from './ts-project.mjs';

/**
 * Checker codes for reading a value before its declaration ran: a
 * block-scoped variable, a class, an enum, and a class property read before
 * its initialiser.
 */
const LOAD_ORDER = new Set([2448, 2449, 2450, 2729]);

/** One file alone: every name the rules resolve is declared in it, so neither imports nor the standard library are loaded. */
const OPTIONS = {
  allowJs: true, checkJs: true, noLib: true, noResolve: true, noEmit: true, types: [],
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
};

/** Directories never read: fixtures are out of order on purpose. */
const SKIPPED = new Set(['fixtures', 'node_modules', '__pycache__']);

const TYPE_KEYWORDS = new Map([
  [ts.SyntaxKind.InterfaceDeclaration, 'interface'], [ts.SyntaxKind.TypeAliasDeclaration, 'type'],
  [ts.SyntaxKind.ClassDeclaration, 'class'], [ts.SyntaxKind.EnumDeclaration, 'enum'],
]);

function main() {
  const given = option('--root');
  const root = resolve(given === undefined ? fileURLToPath(new URL('../', import.meta.url)) : given);
  const files = [...sources(join(root, 'src'), '.ts'), ...sources(join(root, 'scripts'), '.mjs')];
  const owners = option('--owners');
  if (owners !== undefined) printOwners(root, owners);
  else if (process.argv.includes('--fix')) fixFiles(root, files);
  else lintFiles(root, files);
}

function sources(dir, extension) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : sources(path, extension);
    return entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts') ? [path] : [];
  }).sort();
}

function printOwners(root, file) {
  const path = resolve(root, file);
  const owned = ownership(nameOf(root, path), readFileSync(path, 'utf8'));
  for (const [fn, type] of Object.entries(owned)) console.log(`${fn} -> ${type === undefined ? '(free)' : type}`);
}

/** Each top-level function of `text`, with the name of the type that owns it, or `undefined` when it is free. */
export function ownership(name, text) {
  const [file] = scan(name, text);
  return Object.fromEntries(file.units.flatMap(unit => unit.kind !== 'fn' ? [] : [[
    unit.nodes[0].name.text, unit.owner === undefined ? undefined : file.units[unit.owner].typeName,
  ]]));
}

/** Every scope of one source text: the file, then each class body, with its verdict. */
export function scan(name, text) {
  const { source, checker } = compile(name, text);
  const units = fileUnits(source, checker);
  const scopes = [judged(name, headerEnd(source), units)];
  for (const unit of units) {
    const [node] = unit.nodes;
    if (unit.kind === 'type' && ts.isClassDeclaration(node)) {
      scopes.push(judged(`${name}::class ${unit.typeName}`, lineOf(source, node.members.pos), classUnits(source, node, checker)));
    }
  }
  return scopes;
}

/** A program over one in-memory file, for its checker. */
function compile(name, text) {
  const fileName = `/${name}`;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  const host = {
    getSourceFile: requested => requested === fileName ? source : undefined,
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: file => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: requested => requested === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram([fileName], OPTIONS, host);
  return { source, program, checker: program.getTypeChecker() };
}

/**
 * The file's items: overloads merged into one function; each type, function
 * and fixed item with what the rules need (calls, owner, the types it names).
 */
function fileUnits(source, checker) {
  const units = [];
  for (const statement of source.statements) {
    const symbol = declaredSymbol(statement, checker);
    const previous = units.at(-1);
    if (ts.isFunctionDeclaration(statement) && previous !== undefined && previous.kind === 'fn' && symbol !== undefined && previous.symbol === symbol) {
      previous.nodes.push(statement);
    } else units.push(fileUnit(statement, symbol));
  }
  for (const unit of units) span(source, unit);
  const types = new Map(), functions = new Map(), values = new Map();
  units.forEach((unit, at) => {
    if (unit.kind === 'type') {
      if (!types.has(unit.symbol)) types.set(unit.symbol, at);
      unit.group = types.get(unit.symbol);
    } else if (unit.kind === 'fn') functions.set(unit.symbol, [...(functions.get(unit.symbol) ?? []), at]);
    else for (const declared of variableSymbols(unit.nodes[0], checker)) values.set(declared, at);
  });
  markListedExports(source, checker, units);
  for (const unit of units) {
    const [node] = unit.nodes;
    if (unit.kind === 'fn') {
      unit.calls = references(unit.nodes, functions, checker, unit.symbol);
      unit.caller = true;
      unit.owner = owner(unit.nodes, checker, types);
    } else if (unit.kind === 'type' && ts.isClassDeclaration(node)) {
      unit.calls = references(unit.nodes, functions, checker, unit.symbol);
      unit.caller = true;
    } else if (unit.kind === 'type') {
      unit.reads = valueReads(node, checker, values);
      unit.moves = unit.reads.length === 0;
      if (!unit.moves) unit.names = namedTypes(node, checker, types, unit.group);
    } else {
      unit.names = namedTypes(node, checker, types, undefined);
      if (holdsFunction(node)) {
        unit.calls = references(unit.nodes, functions, checker, undefined);
        unit.caller = true;
      }
    }
  }
  return units;
}

function declaredSymbol(statement, checker) {
  const named = ts.isFunctionDeclaration(statement) || TYPE_KEYWORDS.has(statement.kind);
  return named && statement.name !== undefined ? checker.getSymbolAtLocation(statement.name) : undefined;
}

function fileUnit(statement, symbol) {
  const unit = {
    kind: 'fixed', label: fixedLabel(statement), nodes: [statement], symbol, public: exported(statement), moves: false,
    calls: [], caller: false, owner: undefined, group: undefined, typeName: undefined, names: [], reads: [],
  };
  if (symbol === undefined) return unit;
  if (ts.isFunctionDeclaration(statement)) return { ...unit, kind: 'fn', moves: true, label: `function ${statement.name.text}` };
  const keyword = TYPE_KEYWORDS.get(statement.kind);
  if (keyword === undefined) return unit;
  return { ...unit, kind: 'type', moves: true, label: `${keyword} ${statement.name.text}`, typeName: statement.name.text };
}

function fixedLabel(statement) {
  if (!ts.isVariableStatement(statement)) return undefined;
  const flags = statement.declarationList.flags;
  const keyword = (flags & ts.NodeFlags.Const) !== 0 ? 'const' : (flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
  return `${keyword} ${statement.declarationList.declarations[0].name.getText()}`;
}

function exported(statement) {
  return ts.canHaveModifiers(statement)
    && (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** A unit's first line (its code, not its comments) and last line, 1-based. */
function span(source, unit) {
  unit.first = lineOf(source, unit.nodes[0].getStart(source));
  unit.last = lineOf(source, unit.nodes.at(-1).getEnd());
  if (unit.kind === 'fixed' && unit.label === undefined) unit.label = `the statement on line ${unit.first}`;
}

function lineOf(source, position) {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/** The symbols a top-level `const`/`let`/`var` declares, destructured names included. */
function variableSymbols(statement, checker) {
  if (!ts.isVariableStatement(statement)) return [];
  const symbols = [];
  const visit = name => {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol !== undefined) symbols.push(symbol);
    } else for (const element of name.elements) if (!ts.isOmittedExpression(element)) visit(element.name);
  };
  for (const declaration of statement.declarationList.declarations) visit(declaration.name);
  return symbols;
}

/** `export { x }` and `export default x` make `x` public. */
function markListedExports(source, checker, units) {
  const mark = symbol => {
    for (const unit of units) if (symbol !== undefined && unit.symbol === symbol) unit.public = true;
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined
      && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) mark(checker.getExportSpecifierLocalTargetSymbol(element));
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      mark(checker.getSymbolAtLocation(statement.expression));
    }
  }
}

/** The functions of `functions` that `nodes` call or pass as a value, in first-use order. Type positions are skipped. */
function references(nodes, functions, checker, own) {
  const calls = [];
  const visit = node => {
    if (ts.isExpressionWithTypeArguments(node)) return visit(node.expression);
    if (ts.isTypeNode(node)) return undefined;
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol !== undefined && symbol !== own) addNew(calls, functions.get(symbol));
      return undefined;
    }
    return ts.forEachChild(node, visit);
  };
  for (const node of nodes) ts.forEachChild(node, visit);
  return calls;
}

function addNew(list, items) {
  for (const item of items ?? []) if (!list.includes(item)) list.push(item);
}

/** The group of the one file-local type a function's written signature names, or `undefined`. */
function owner(nodes, checker, types) {
  const named = new Set();
  const visit = node => {
    if (ts.isTypeQueryNode(node)) return undefined;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const group = types.get(checker.getSymbolAtLocation(node.typeName));
      if (group !== undefined) named.add(group);
    }
    return ts.forEachChild(node, visit);
  };
  for (const fn of nodes) {
    for (const parameter of fn.typeParameters ?? []) visit(parameter);
    for (const parameter of fn.parameters) if (parameter.type !== undefined) visit(parameter.type);
    if (fn.type !== undefined) visit(fn.type);
  }
  return named.size === 1 ? [...named][0] : undefined;
}

/** The fixed values a type reads through `typeof`: a type that reads one is pinned below it. */
function valueReads(node, checker, values) {
  const reads = [];
  const visit = child => {
    if (ts.isTypeQueryNode(child)) {
      let name = child.exprName;
      while (ts.isQualifiedName(name)) name = name.left;
      addNew(reads, [values.get(checker.getSymbolAtLocation(name))].filter(at => at !== undefined));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return reads;
}

/** The groups of the file-local types `node` names: in a type position, or a class used as a value. */
function namedTypes(node, checker, types, ownGroup) {
  const named = [];
  const visit = (child, inType) => {
    if (ts.isTypeQueryNode(child)) return;
    const typed = inType || ts.isTypeNode(child);
    if (ts.isIdentifier(child)) {
      const symbol = checker.getSymbolAtLocation(child);
      const group = types.get(symbol);
      const meant = typed || (symbol !== undefined && symbol.valueDeclaration !== undefined && ts.isClassDeclaration(symbol.valueDeclaration));
      if (group !== undefined && group !== ownGroup && meant) addNew(named, [group]);
      return;
    }
    ts.forEachChild(child, grand => visit(grand, typed));
  };
  ts.forEachChild(node, child => visit(child, false));
  return named;
}

/** A top-level `const`/`let` whose value is a function: its body is a caller. */
function holdsFunction(statement) {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations
    .some(declaration => declaration.initializer !== undefined && isFunctionValue(declaration.initializer));
}

function isFunctionValue(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** A scope's verdict: what breaks rules 1 to 4, the canonical order if anything does, and the rule 5 breaches only a person can fix. */
function judged(name, opensAfter, units) {
  const graph = callGraph(units);
  const found = violations(units, graph);
  return {
    name, opensAfter, units, found,
    manual: misplacedFixedItems(units),
    order: found.length === 0 ? undefined : canonical(units, graph),
  };
}

/** Call-graph facts the rules and the canonical order share. */
function callGraph(units) {
  const callers = units.map(() => []);
  units.forEach((unit, at) => {
    for (const callee of unit.calls) callers[callee].push(at);
  });
  const reach = units.map((_, at) => reachable(units, at));
  const helperOf = helpers(units, callers, reach);
  const tier = units.map((unit, at) => {
    if (unit.kind !== 'fn') return undefined;
    if (unit.owner !== undefined) return `owned ${unit.owner}`;
    return helperOf[at] === undefined ? 'free' : `helper ${helperOf[at]}`;
  });
  const region = at => tier[at] === undefined ? undefined : tier[at].split(' ')[0];
  // An owned function's callers are its own group's code: the type and its other owned functions.
  const counts = (caller, callee) => region(callee) !== 'owned' || tier[caller] === tier[callee]
    || (units[caller].kind === 'type' && units[caller].group === units[callee].owner);
  const outerCallers = at => callers[at].filter(caller => caller !== at && !reach[at].has(caller) && counts(caller, at));
  // A free function stays a root when only types, owned functions or fixed items call it, as a Rust
  // function called only from `impl` blocks does.
  const blocks = (caller, at) => units[caller].kind === 'fn' && (region(at) === 'owned' || region(caller) !== 'owned');
  return {
    reach, tier,
    group: at => units[at].kind === 'type' ? units[at].group : units[at].owner !== undefined ? units[at].owner : helperOf[at],
    outerCallers,
    isRoot: at => units[at].kind === 'fn' && region(at) !== 'helper' && outerCallers(at).every(caller => !blocks(caller, at)),
  };
}

function reachable(units, from) {
  const seen = new Set();
  const stack = [...units[from].calls];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!seen.has(next)) {
      seen.add(next);
      stack.push(...units[next].calls);
    }
  }
  return seen;
}

/** The group a free function is a helper of: every caller is that group's code or another of its helpers. */
function helpers(units, callers, reach) {
  const helperOf = units.map(() => undefined);
  const groups = [...new Set(units.flatMap(unit => unit.kind === 'type' ? [unit.group] : []))];
  for (const group of groups) {
    const members = new Set(units.flatMap((unit, at) =>
      (unit.kind === 'type' && unit.group === group && unit.caller) || (unit.kind === 'fn' && unit.owner === group) ? [at] : []));
    const helping = new Set([...members].flatMap(member => [...reach[member]])
      .filter(at => units[at].kind === 'fn' && units[at].owner === undefined && helperOf[at] === undefined));
    const outside = () => [...helping].find(at => callers[at].some(caller => !members.has(caller) && !helping.has(caller)));
    for (let stray = outside(); stray !== undefined; stray = outside()) helping.delete(stray);
    for (const at of helping) helperOf[at] = group;
  }
  return helperOf;
}

/** Every rule from 1 to 4 the current order of `units` breaks. */
function violations(units, graph) {
  const found = [];
  const order = units.flatMap((unit, at) => unit.kind === 'fixed' ? [] : [at]);
  const typeName = group => units[group].typeName;

  // Rule 1.
  const firstFree = order.find(at => graph.group(at) === undefined);
  const closed = new Set(), defined = new Set();
  let current;
  for (const at of order) {
    const group = graph.group(at);
    if (group === undefined) continue;
    const { label } = units[at];
    if (firstFree !== undefined && firstFree < at) {
      const belongs = units[at].kind === 'type' ? '' : ` belongs with type ${typeName(group)} but`;
      found.push(`rule 1: ${label}${belongs} comes after ${units[firstFree].label}`);
    }
    if (current !== group) {
      if (current !== undefined) closed.add(current);
      if (closed.has(group)) found.push(`rule 1: ${label} is separated from the rest of type ${typeName(group)}`);
      current = group;
    }
    if (units[at].kind === 'type') defined.add(group);
    else if (!defined.has(group)) found.push(`rule 1: ${label} comes before the definition of ${typeName(group)}`);
  }

  for (const at of order) {
    if (units[at].kind !== 'fn') continue;
    const outer = graph.outerCallers(at);
    // Rule 2.
    if (outer.length > 0 && outer.every(caller => caller > at)) {
      found.push(`rule 2: ${units[at].label} comes before every caller (${outer.map(caller => units[caller].label).join(', ')})`);
      continue;
    }
    // Rule 3.
    const [caller] = outer;
    if (outer.length === 1 && units[caller].kind === 'fn' && graph.tier[caller] === graph.tier[at] && caller < at) {
      const stray = order.find(between => between > caller && between < at && !graph.reach[caller].has(between));
      if (stray !== undefined) {
        found.push(`rule 3: ${units[at].label} is called only by ${units[caller].label}, but ${units[stray].label} sits between them`);
      }
    }
  }

  // Rule 4: within each group's owned functions, and among the free functions.
  const firstPrivate = new Map();
  for (const at of order) {
    if (!graph.isRoot(at)) continue;
    const key = graph.tier[at];
    if (!units[at].public) {
      if (!firstPrivate.has(key)) firstPrivate.set(key, at);
    } else if (firstPrivate.has(key)) {
      found.push(`rule 4: public ${units[at].label} comes after ${units[firstPrivate.get(key)].label}, which nothing here calls`);
    }
  }
  return found;
}

/** Rule 5: a fixed item sits below every type it names, and a pinned type below every value it reads. Neither moves, so a person fixes a breach. */
function misplacedFixedItems(units) {
  const found = [];
  units.forEach((unit, at) => {
    for (const group of unit.names) {
      if (!units.slice(0, at).some(other => other.kind === 'type' && other.group === group)) {
        found.push(`rule 5: ${unit.label} names type ${units[group].typeName} before its definition`);
      }
    }
    for (const read of unit.reads) {
      if (read > at) found.push(`rule 5: ${unit.label} reads ${units[read].label} before its definition`);
    }
  });
  return found;
}

/**
 * The canonical order of the units that move: each type group as it first
 * appears (the type, its owned functions depth first from its public roots,
 * then its helpers), then a depth-first walk from the public roots, then
 * from the private ones.
 */
function canonical(units, graph) {
  const out = [];
  const walk = (at, tier) => {
    if (units[at].kind !== 'fn' || out.includes(at) || graph.tier[at] !== tier) return;
    out.push(at);
    for (const callee of units[at].calls) walk(callee, tier);
  };
  const fromRoots = tier => {
    const roots = units.flatMap((_, at) => graph.tier[at] === tier && graph.isRoot(at) ? [at] : []);
    for (const root of [...roots.filter(at => units[at].public), ...roots.filter(at => !units[at].public)]) walk(root, tier);
    units.forEach((_, at) => walk(at, tier));
  };
  const groups = [...new Set(units.flatMap(unit => unit.kind === 'type' ? [unit.group] : []))];
  for (const group of groups) {
    out.push(...units.flatMap((unit, at) => unit.kind === 'type' && unit.group === group && unit.moves ? [at] : []));
    const owned = `owned ${group}`;
    fromRoots(owned);
    const helper = `helper ${group}`;
    const members = [
      ...units.flatMap((unit, at) => unit.kind === 'type' && unit.group === group ? [at] : []),
      ...out.filter(at => graph.tier[at] === owned),
    ];
    for (const member of members) for (const callee of units[member].calls) walk(callee, helper);
    units.forEach((_, at) => walk(at, helper));
  }
  fromRoots('free');
  return out;
}

/** The last line of the file's leading comment, when a blank line parts it from the first item; 0 otherwise. */
function headerEnd(source) {
  const [first] = source.statements;
  if (first === undefined) return 0;
  const text = source.text;
  const ranges = ts.getLeadingCommentRanges(text, first.getFullStart()) ?? [];
  let end = text.startsWith('#!') ? 1 : 0;
  ranges.forEach((range, at) => {
    const next = at + 1 < ranges.length ? ranges[at + 1].pos : first.getStart(source);
    if (text.slice(range.end, next).split('\n').length > 2) end = lineOf(source, range.end);
  });
  return end;
}

/** A class body's members: overloads and get/set pairs merged; properties fixed. */
function classUnits(source, declaration, checker) {
  const classSymbol = checker.getSymbolAtLocation(declaration.name);
  const units = [];
  for (const member of declaration.members) {
    const symbol = member.name === undefined ? undefined : checker.getSymbolAtLocation(member.name);
    const previous = units.at(-1);
    const same = previous !== undefined && previous.kind === 'fn' && (symbol === undefined
      ? ts.isConstructorDeclaration(member) && ts.isConstructorDeclaration(previous.nodes[0])
      : previous.symbol === symbol);
    if (isMethodLike(member) && same) previous.nodes.push(member);
    else units.push(memberUnit(member, symbol));
  }
  for (const unit of units) span(source, unit);
  const methods = new Map();
  units.forEach((unit, at) => {
    if (unit.kind === 'fn' && unit.symbol !== undefined) methods.set(unit.symbol, [...(methods.get(unit.symbol) ?? []), at]);
  });
  for (const unit of units) {
    if (unit.caller) unit.calls = memberCalls(unit.nodes, methods, checker, classSymbol, unit.symbol);
  }
  return units;
}

function isMethodLike(member) {
  return ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)
    || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
}

function memberUnit(member, symbol) {
  const unit = {
    kind: 'fixed', label: 'a class member', nodes: [member], symbol, public: false, moves: false,
    calls: [], caller: false, owner: undefined, group: undefined, typeName: undefined, names: [], reads: [],
  };
  const hidden = (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
    || (member.name !== undefined && ts.isPrivateIdentifier(member.name));
  if (ts.isConstructorDeclaration(member)) return { ...unit, kind: 'fn', label: 'constructor', public: true, moves: true, caller: true };
  const name = member.name === undefined ? '' : member.name.getText();
  if (ts.isMethodDeclaration(member)) return { ...unit, kind: 'fn', label: `method ${name}`, public: !hidden, moves: true, caller: true };
  if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return { ...unit, kind: 'fn', label: `accessor ${name}`, public: !hidden, moves: true, caller: true };
  }
  if (ts.isPropertyDeclaration(member)) {
    const arrow = member.initializer !== undefined && isFunctionValue(member.initializer);
    return { ...unit, label: `property ${name}`, caller: arrow };
  }
  return unit;
}

/** The functions a class member calls or reads through `this.m` or `C.m`. */
function memberCalls(nodes, methods, checker, classSymbol, own) {
  const calls = [];
  const visit = node => {
    if (ts.isPropertyAccessExpression(node) && (node.expression.kind === ts.SyntaxKind.ThisKeyword
      || (ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === classSymbol))) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined && symbol !== own) addNew(calls, methods.get(symbol));
    }
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) ts.forEachChild(node, visit);
  return calls;
}

function nameOf(root, file) {
  return relative(root, file).split(sep).join('/');
}

function fixFiles(root, files) {
  const left = [];
  for (const file of files) {
    const name = nameOf(root, file);
    const before = readFileSync(file, 'utf8');
    const { text, problems } = fixSource(name, before);
    if (text !== before) {
      writeFileSync(file, text);
      console.log(`rewrote ${name}`);
    }
    left.push(...problems, ...scan(name, text).flatMap(scope => scope.manual.map(line => `${scope.name}: ${line}`)));
  }
  if (left.length > 0) {
    console.error(`\nFAIL: ${left.length} item(s) need a person to place them:`);
    for (const line of left) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log('OK: every scope reads top to bottom.');
}

/**
 * Rewrites, one at a time, each scope of `text` that breaks rules 1 to 4.
 * Returns the new text and what is left for a person.
 */
export function fixSource(name, text) {
  const problems = [];
  const skipped = new Set();
  let current = text;
  for (let round = 0; round < 1000; round += 1) {
    const scope = scan(name, current).find(candidate => candidate.found.length > 0 && !skipped.has(candidate.name));
    if (scope === undefined) return { text: current, problems };
    skipped.add(scope.name);
    const rewritten = rewrite(current, scope);
    if (rewritten.error !== undefined) {
      problems.push(rewritten.error);
      continue;
    }
    const after = scan(name, rewritten.text).find(candidate => candidate.name === scope.name);
    if (after === undefined || after.found.length > 0) {
      problems.push(`${scope.name}: the canonical order still breaks (${after === undefined ? 'scope lost' : after.found.join('; ')}); order it by hand`);
      continue;
    }
    const broken = newLoadOrderErrors(name, current, rewritten.text);
    if (broken.length > 0) {
      problems.push(`${scope.name}: the canonical order would break load order (${broken.join('; ')}); order it by hand`);
      continue;
    }
    skipped.delete(scope.name);
    current = rewritten.text;
  }
  problems.push(`${name}: no fixed point after 1000 rewrites`);
  return { text: current, problems };
}

/** Rewrites `scope`'s items in `text` into its canonical order; fixed items keep their slots. */
function rewrite(text, scope) {
  const lines = text.split('\n');
  const chunks = [];
  let previousEnd = scope.opensAfter;
  for (const unit of scope.units) {
    if (unit.first <= previousEnd) return { error: `${scope.name}: two items share line ${unit.first}` };
    chunks.push([previousEnd + 1, unit.last]);
    previousEnd = unit.last;
  }
  const slots = scope.units.flatMap((unit, at) => unit.moves ? [at] : []);
  if (slots.length !== scope.order.length) return { error: `${scope.name}: the canonical order lost an item` };
  const placed = scope.units.map((_, at) => at);
  slots.forEach((slot, index) => {
    placed[slot] = scope.order[index];
  });
  const leadingBlanks = ([first, last]) => {
    let count = 0;
    while (first + count <= last && lines[first + count - 1].trim() === '') count += 1;
    return count;
  };
  const out = lines.slice(0, scope.opensAfter);
  placed.forEach((unit, slot) => {
    const [first, last] = chunks[unit];
    out.push(...new Array(leadingBlanks(chunks[slot])).fill(''), ...lines.slice(first - 1 + leadingBlanks(chunks[unit]), last));
  });
  out.push(...lines.slice(previousEnd));
  return { text: out.join('\n') };
}

/** The checker's "used before its declaration" errors `after` has and `before` did not. */
function newLoadOrderErrors(name, before, after) {
  const was = loadOrderErrors(name, before);
  return loadOrderErrors(name, after).filter(message => {
    const at = was.indexOf(message);
    if (at === -1) return true;
    was.splice(at, 1);
    return false;
  });
}

function loadOrderErrors(name, text) {
  const { source, program } = compile(name, text);
  return program.getSemanticDiagnostics(source)
    .filter(diagnostic => LOAD_ORDER.has(diagnostic.code))
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

function lintFiles(root, files) {
  const breaches = files.flatMap(file => scan(nameOf(root, file), readFileSync(file, 'utf8'))
    .flatMap(scope => [...scope.found, ...scope.manual].map(line => `${scope.name}: ${line}`)));
  if (breaches.length > 0) {
    console.error(`FAIL: ${breaches.length} item(s) are out of reading order (PR #39 review, comment 4657187381).`);
    console.error('Run `npm run fix:item-order`, then place by hand what it reports:');
    for (const line of breaches) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`OK: ${files.length} files read top to bottom: types with their code, callers above callees, public entry points first.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
