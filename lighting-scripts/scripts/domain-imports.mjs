// Guard: the layers import downward only.
//
// 1. A file under `src/domain/` imports only from `src/domain/`.
// 2. A file under `src/adapter/` never imports the host: `src/host.ts`,
//    `src/main.ts`, `src/live.ts` or `src/rpc.ts`.
//
// Every relative specifier is read: imports and re-exports, `import()` calls,
// and `import('…')` type references. A package or `node:` import is outside
// the project and passes.
//
// Usage: node scripts/domain-imports.mjs [--root <dir>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, option, ts } from './ts-project.mjs';

const root = resolve(option('--root') ?? fileURLToPath(new URL('../', import.meta.url)));

/** The host: what runs the adapter. */
const HOST = new Set(['src/host.ts', 'src/main.ts', 'src/live.ts', 'src/rpc.ts']);

const rel = file => relative(root, file).split(sep).join('/');
const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/** Every `.ts` under `dir` (relative to the root), as root-relative names. */
function sources(dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { recursive: true }).filter(name => name.endsWith('.ts')).map(name => `${dir}/${name.split(sep).join('/')}`).sort();
}

/** The relative specifiers a file imports or re-exports, loads with `import()`, or names in an `import('…')` type. */
function specifiers(file) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.ESNext, true);
  const found = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter(text => text.startsWith('.'));
}

const problems = [];

for (const file of [...sources('src/domain'), ...sources('src/adapter')]) {
  for (const spec of specifiers(file)) {
    const target = rel(resolve(root, dirname(file), spec));
    if (inside(file, 'src/domain') && !inside(target, 'src/domain')) {
      problems.push(`${file} imports ${spec}: src/domain imports only from src/domain`);
    } else if (inside(file, 'src/adapter') && HOST.has(target)) {
      problems.push(`${file} imports ${spec}: the adapter never imports the host`);
    }
  }
}

console.log(`Domain imports: ${sources('src/domain').length} domain, ${sources('src/adapter').length} adapter files\n`);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  fail(`${problems.length} import problem(s).`);
}
console.log('OK');
