import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The domain's modules import in one direction: no module reaches itself through its imports, type imports
 * included, so each can be read (and moved) after what it builds on.
 */
const DOMAIN = fileURLToPath(new URL('../../src/domain/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
}

/** Each domain file's relative imports, `import('…')` type references included. */
function graph(): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const file of files(DOMAIN)) {
    const text = readFileSync(file, 'utf8');
    const targets = [...text.matchAll(/(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+)'/g)].map(match => resolve(dirname(file), match[1]!));
    edges.set(file, [...new Set(targets)]);
  }
  return edges;
}

/** Every cycle's members, as paths under src/domain, one strongly connected group at a time (Tarjan). */
function cycles(edges: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
  const found: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, next); low.set(node, next); next++; stack.push(node); on.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!edges.has(target)) continue;
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node)!, low.get(target)!)); }
      else if (on.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const group: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      on.delete(member); group.push(relative(DOMAIN, member));
      if (member === node) break;
    }
    if (group.length > 1) found.push(group.sort());
  };
  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return found;
}

test('no domain module reaches itself through its imports', () => {
  // M5 carry-over. Break: a type module imports one that imports it back (range.ts and the types it brands), or two
  // concept modules lean on each other (switches.ts and lighting-state.ts).
  assert.deepEqual(cycles(graph()), []);
});
