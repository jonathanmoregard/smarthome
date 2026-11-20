import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * A branded id or a range type is built only by a parser. In code that means
 * one cast per brand, inside its constructor in `src/parse/ids.ts`, plus the
 * one in `entriesOf` (`src/domain/types/ids.ts`), which gives a record's keys
 * back their id type. Any other cast to a type declared under
 * `src/domain/types/` forges a value no parser built.
 *
 * Every cast in those allowed places carries its reason: a comment starting
 * `Cast:` on the statement.
 */

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/domain-type-casts/', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Every cast that breaks the rule, as `file:line what is wrong`. */
function badCasts(root: string): string[] {
  const program = ts.createProgram(walk(join(root, 'src')), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const domainTypes = join(root, 'src', 'domain', 'types') + sep;
  const name = (file: string) => relative(root, file).split(sep).join('/');

  const namesDomainType = (type: ts.Node): boolean => {
    if (ts.isTypeReferenceNode(type)) {
      let symbol = checker.getSymbolAtLocation(type.typeName);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      const declared = (symbol?.declarations ?? []).some(declaration =>
        (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration))
        && declaration.getSourceFile().fileName.startsWith(domainTypes));
      if (declared) return true;
    }
    return ts.forEachChild(type, child => namesDomainType(child) || undefined) ?? false;
  };

  /** The constructors and `entriesOf`/`fromEntriesOf`: the only places a domain type may be cast to. */
  const allowedPlace = (node: ts.Node): boolean => {
    let fn: ts.Node | undefined = node.parent;
    while (fn !== undefined && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
    if (fn === undefined || !ts.isFunctionDeclaration(fn) || fn.name === undefined) return false;
    const file = name(fn.getSourceFile().fileName), fnName = fn.name.text;
    return file === 'src/parse/ids.ts' && /^to[A-Z]/.test(fnName)
      || file === 'src/domain/types/ids.ts' && (fnName === 'entriesOf' || fnName === 'fromEntriesOf');
  };

  const hasReason = (node: ts.Node): boolean => {
    let statement: ts.Node = node;
    while (!ts.isStatement(statement.parent) && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) {
      statement = statement.parent;
    }
    if (!ts.isStatement(statement)) statement = statement.parent;
    const source = statement.getSourceFile().getFullText();
    return (ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? [])
      .some(range => /^\/\/\s*Cast:\s*\S/.test(source.slice(range.pos, range.end)));
  };

  const found: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(join(root, 'src') + sep)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const where = `${name(source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (allowedPlace(node)) {
          if (!hasReason(node)) found.push(`${where} no reason`);
        } else if (namesDomainType(node.type)) {
          found.push(`${where} outside the constructors and entriesOf`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort();
}

test('a cast to a domain type happens only in an id constructor or entriesOf, each with its reason', () => {
  // Break: a parse step, a runtime module or the domain casts `x as RoomId`
  // instead of calling its constructor, or an allowed cast loses its reason.
  assert.deepEqual(badCasts(PROJECT), []);
});

test('the cast check reports a forged cast and an allowed cast with no reason, and nothing else', () => {
  // Break: the check misses a cast outside the allowed places, lets a reason
  // comment excuse it, accepts an unexplained cast in a constructor, or counts
  // `as const` and casts to types outside src/domain/types.
  assert.deepEqual(badCasts(FIXTURE), [
    'src/domain/lamp.ts:9 outside the constructors and entriesOf',
    'src/parse/ids.ts:10 no reason',
  ]);
});
