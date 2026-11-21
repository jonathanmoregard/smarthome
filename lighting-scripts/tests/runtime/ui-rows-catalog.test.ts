import assert from 'node:assert/strict';
import test from 'node:test';
import { context, setCatalog } from './gestures-context.ts';
import { discoveryRows, uiRows } from '../../src/parse/ui-state.ts';
import { ParseError } from '../../src/runtime/parse.ts';
import type { JsonObject } from '../../src/runtime/context.ts';

/*
 * Review round 2, item 2. The UI rows and the discovery rows are the
 * catalog's (`ui_rows`, `ui_discovery`): configuration, so a row missing the
 * entity it names is a configuration error, refused with the field it lacks.
 * It must not become the entity `'undefined'`.
 */

const TOPICS = { availability: 't/a' };
const UI_ROW = { source: 'light.group', proxy: 'light.ep_test', members: [], topics: TOPICS };

function rowsOf(catalog: JsonObject) {
  const ctx = context({});
  setCatalog(ctx, catalog);
  return ctx;
}

const refused = (message: string) => (error: unknown) => error instanceof ParseError && error.message === message;

test('a UI row with its source and proxy parses them as given', () => {
  const row = uiRows(rowsOf({ ui_rows: [UI_ROW] }))[0]?.();
  assert.deepEqual([row?.source, row?.proxy], ['light.group', 'light.ep_test']);
});

test('a UI row with no source, or a source that is not text, is refused', () => {
  // Break: the row's source is `String(row.source)`, so an absent source is the entity 'undefined'.
  for (const [source, got] of [[undefined, 'undefined'], [5, 'number 5'], [null, 'null']] as const) {
    const parse = uiRows(rowsOf({ ui_rows: [{ ...UI_ROW, source }] }))[0];
    assert.throws(() => parse?.(), refused(`effects_ui_sync.row.source must be a string, got ${got}`), String(source));
  }
});

test('a UI row with no proxy is refused', () => {
  // Break: the row's proxy is `String(row.proxy)`, so an absent proxy is the entity 'undefined'.
  const parse = uiRows(rowsOf({ ui_rows: [{ members: [], topics: TOPICS, source: 'light.group' }] }))[0];
  assert.throws(() => parse?.(), refused('effects_ui_sync.row.proxy must be a string, got undefined'));
});

test('a discovery row with its entity and unique id parses them as given', () => {
  const [row] = discoveryRows(rowsOf({ ui_discovery: [{ entity: 'light.ep_test', config: { unique_id: 'ep_test' } }] }));
  assert.deepEqual([row?.entity, row?.uniqueId], ['light.ep_test', 'ep_test']);
});

test('a discovery row with no entity is refused', () => {
  // Break: the row's entity is `String(row.entity)`, so an absent entity is the entity 'undefined'.
  assert.throws(() => discoveryRows(rowsOf({ ui_discovery: [{ config: { unique_id: 'ep_test' } }] })),
    refused('effects_ui_catalog.row.entity must be a string, got undefined'));
});

test('a discovery row whose config has no unique id, or no config at all, is refused', () => {
  // Break: the unique id is `${config.unique_id}`, so an absent one is the text 'undefined'.
  assert.throws(() => discoveryRows(rowsOf({ ui_discovery: [{ entity: 'light.ep_test', config: {} }] })),
    refused('effects_ui_catalog.row.config.unique_id must be a string, got undefined'));
  assert.throws(() => discoveryRows(rowsOf({ ui_discovery: [{ entity: 'light.ep_test' }] })),
    refused('effects_ui_catalog.row.config must be an object, got undefined'));
});
