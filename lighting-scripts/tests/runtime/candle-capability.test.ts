import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import { readRuntimeCatalog } from '../../src/main.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { candleLamps, resolveEffects } from '../../src/legacy/domain/resolution.ts';
import { parseResolveArgs } from '../../src/parse/resolution.ts';
import type { JsonObject } from '../../src/runtime/context.ts';

/**
 * Candle runs on the bulb's own firmware, so whether a lamp can run it is a
 * fact about its bulbs, declared in the catalog (`bulbs.<entity>.candle`); it
 * cannot be derived from the model. A lamp may run Candle iff it has at least
 * one member and every member is flagged.
 */

test('the catalog reads each bulb\'s declared candle firmware; absent is not flashed', () => {
  const catalog = parseCatalog({ members: { 'light.a': ['light.a_1'] }, bulbs: { 'light.a_1': { candle: true }, 'light.b_1': {} } });
  assert.deepEqual(catalog.bulbs, { 'light.a_1': { candle: true }, 'light.b_1': { candle: false } });
  assert.deepEqual(parseCatalog({}).bulbs, {});
});

test('a malformed candle flag rejects the catalog', () => {
  assert.throws(() => parseCatalog({ bulbs: { 'light.a_1': { candle: 'yes' } } }), /catalog\.bulbs\.light\.a_1\.candle must be true or false/);
  assert.throws(() => parseCatalog({ bulbs: { 'light.a_1': true } }), /catalog\.bulbs\.light\.a_1 must be an object/);
  assert.throws(() => parseCatalog({ bulbs: [] }), /catalog\.bulbs must be an object/);
});

test('a runtime catalog with a malformed candle flag is refused when it is loaded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lighting-candle-'));
  const path = join(directory, 'catalog.json');
  await writeFile(path, JSON.stringify({ groups: {}, effects: {}, members: {}, bulbs: { 'light.a_1': { candle: 1 } } }));
  await assert.rejects(readRuntimeCatalog(path), /candle must be true or false/);
});

test('a lamp runs Candle only when every one of its bulbs has the firmware, and a lamp with no bulbs never does', () => {
  const catalog = parseCatalog({
    members: { 'light.all': ['light.all_1', 'light.all_2'], 'light.some': ['light.some_1', 'light.some_2'], 'light.none': [] },
    bulbs: { 'light.all_1': { candle: true }, 'light.all_2': { candle: true }, 'light.some_1': { candle: true } },
  });
  assert.deepEqual([...candleLamps(catalog)], ['light.all']);
});

const item = { area: 'living', period: 'cosy', on: true, brightness: 110, color: { kelvin: 2200 } };
const roomCandle: JsonObject = { candle: { kind: 'channels', scope: 'room', target: 'living',
  value: { channels: { brightness: { kind: 'effect', effect: 'Candle', instance: 'shared' } } } } };

test('a room-wide Candle selection runs Candle on every capable lamp in the room, and on no other', () => {
  const args = parseResolveArgs({ base: { 'light.a': item, 'light.b': item, 'light.c': item },
    catalog: { effects: { Candle: { channels: ['brightness'] } } }, overrides: roomCandle });
  const result = resolveEffects(args, new Set(['light.a', 'light.b']));
  assert.equal(result.targets['light.a']!.brightness.kind, 'effect');
  assert.equal(result.targets['light.b']!.brightness.kind, 'effect');
  assert.equal(result.targets['light.c']!.brightness.kind, 'constant');
});

test('a baseline Candle runs only on a capable lamp', () => {
  const candle = { ...item, effect: 'Candle' };
  const args = parseResolveArgs({ base: { 'light.a': candle, 'light.c': candle }, catalog: { effects: { Candle: { channels: ['brightness'] } } } });
  const result = resolveEffects(args, new Set(['light.a']));
  assert.equal(result.targets['light.a']!.brightness.kind, 'effect');
  assert.equal(result.targets['light.c']!.brightness.kind, 'constant');
});

test('effects_resolve takes the capability from the runtime catalog it runs with, not from its catalog argument', () => {
  const snapshot = { now: '2026-10-26T12:00:00+01:00', state: {}, areas: {}, members: [],
    catalog: { members: { 'light.a': ['light.a_1'], 'light.c': ['light.c_1'] }, bulbs: { 'light.a_1': { candle: true } } } };
  const result = execute({ script: 'effects_resolve', snapshot, args: { base: { 'light.a': item, 'light.c': item },
    catalog: { effects: { Candle: { channels: ['brightness'] } } }, overrides: roomCandle } }, handlers).result as
    { targets: Record<string, { brightness: { kind: string } }> };
  assert.equal(result.targets['light.a']!.brightness.kind, 'effect');
  assert.equal(result.targets['light.c']!.brightness.kind, 'constant');
});
