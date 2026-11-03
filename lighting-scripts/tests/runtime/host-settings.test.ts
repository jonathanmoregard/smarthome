import assert from 'node:assert/strict';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeCatalog, watchRuntimeCatalog } from '../../src/main.ts';
import { LightingHost } from '../../src/runtime/host.ts';
import { execute } from '../../src/runtime/engine.ts';

test('runtime catalog atomic edits hotload without replacing the program; malformed edits preserve previous settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lighting-settings-'));
  const path = join(directory, 'catalog.json');
  const initial = { members: {}, groups: {}, effects: {}, marker: 'before' };
  await writeFile(path, JSON.stringify(initial));
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial: { state: {}, areas: {}, members: [], now: '2026-10-26T12:00:00Z', catalog: await readRuntimeCatalog(path) }, autoTimers: false,
    // Serves the raw document, as the effects_catalog shim does: this test is
    // about the document hotloading, and `marker` is not a field any lighting
    // logic reads, so the parsed view deliberately drops it.
    program: request => execute(request, { catalog: ctx => ctx.rawCatalog() }), transport: { send: async () => {}, close: async () => {} } });
  let accepted!: () => void, rejected!: () => void;
  const loaded = new Promise<void>(resolve => { accepted = resolve; });
  const invalid = new Promise<void>(resolve => { rejected = resolve; });
  const watcher = watchRuntimeCatalog(path, async catalog => { await host.update(snapshot => { snapshot.catalog = catalog; }); accepted(); }, () => rejected());
  try {
    assert.equal((await host.dispatch('catalog')).marker, 'before');
    await writeFile(join(directory, 'next.json'), JSON.stringify({ ...initial, marker: 'after' }));
    await rename(join(directory, 'next.json'), path); await loaded;
    assert.equal((await host.dispatch('catalog')).marker, 'after');
    await writeFile(path, '{invalid'); await invalid;
    assert.equal((await host.dispatch('catalog')).marker, 'after');
  } finally { watcher.close(); await host.close(); }
});
