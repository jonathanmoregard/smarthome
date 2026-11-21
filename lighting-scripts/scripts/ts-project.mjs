// Shared by the compiler-API guards (`domain-types.mjs`, `domain-words.mjs`):
// command-line options and one TypeScript program over a project root.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export { ts };

export function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  }).sort();
}

/**
 * The project under `--root` (default: `lighting-scripts/`). It is compiled with
 * its own tsconfig when it has one; a fixture without one gets every `.ts`
 * under `src/` and this project's module settings.
 */
export function project() {
  const root = resolve(option('--root') ?? fileURLToPath(new URL('../', import.meta.url)));
  const config = join(root, 'tsconfig.json');
  let names, options;
  if (existsSync(config)) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (read.error !== undefined) fail(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    names = parsed.fileNames;
    options = { ...parsed.options, noEmit: true };
  } else {
    names = walk(join(root, 'src'));
    options = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true,
    };
  }
  const program = ts.createProgram(names, options);
  const checker = program.getTypeChecker();
  const under = dir => file => resolve(file).startsWith(join(root, dir) + sep);
  return {
    root,
    program,
    checker,
    /** `src/domain/x.ts`: a file's name relative to the root, with forward slashes. */
    name: file => relative(root, resolve(file)).split(sep).join('/'),
    /** A predicate: is this file under `dir` (relative to the root)? */
    under,
    /** The symbol itself, or what an import alias stands for. */
    resolved: symbol => symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol,
  };
}
