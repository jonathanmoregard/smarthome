// Guard: the new architecture stays apart from the old script-shaped code.
//
// 1. A file under `src/domain/` imports only from `src/domain/`.
// 2. Nothing under `src/domain/` or `src/adapter/` imports from `src/legacy/`,
//    except the files `scripts/legacy-files.json` lists under `bridges`.
// 3. `src/legacy/` holds only the files the list names under `files`. The list
//    may only shrink: a new file there fails, and so does a listed file that
//    is gone (delete its entry).
//
// Only relative specifiers are read: a package or `node:` import is outside
// the project and passes.
//
// Usage: node scripts/domain-imports.mjs [--root <dir>] [--legacy <file>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, option, ts } from './ts-project.mjs';

const root = resolve(option('--root') ?? fileURLToPath(new URL('../', import.meta.url)));
const listFile = resolve(option('--legacy') ?? join(root, 'scripts/legacy-files.json'));

const list = JSON.parse(readFileSync(listFile, 'utf8'));
const files = new Set(list.files);
const bridges = new Set(list.bridges);

const rel = file => relative(root, file).split(sep).join('/');
const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/** Every `.ts` under `dir` (relative to the root), as root-relative names. */
function sources(dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { recursive: true }).filter(name => name.endsWith('.ts')).map(name => `${dir}/${name.split(sep).join('/')}`).sort();
}

/** The relative specifiers a file imports or re-exports, or loads with `import()`. */
function specifiers(file) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.ESNext, true);
  const found = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
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
    if (inside(target, 'src/legacy')) {
      if (!bridges.has(file)) problems.push(`${file} imports ${spec}: nothing outside src/legacy may import it unless legacy-files.json lists the file under "bridges"`);
    } else if (inside(file, 'src/domain') && !inside(target, 'src/domain')) {
      problems.push(`${file} imports ${spec}: src/domain imports only from src/domain`);
    }
  }
}

const present = sources('src/legacy');
for (const file of present) {
  if (!files.has(file)) problems.push(`${file} is not in legacy-files.json: src/legacy only holds the files that list names, and it only shrinks`);
}
for (const file of files) {
  if (!present.includes(file)) problems.push(`${file} is in legacy-files.json but gone: remove it from the list`);
}

console.log(`Domain imports: ${sources('src/domain').length} domain, ${sources('src/adapter').length} adapter, ${present.length} legacy files\n`);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  fail(`${problems.length} import or legacy-list problem(s).`);
}
console.log('OK');
