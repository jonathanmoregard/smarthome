import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog, emptyCatalog } from '../../src/runtime/catalog.ts';
import type { JsonObject } from '../../src/runtime/context.ts';

/**
 * The runtime catalog is the lighting system's registry document: it maps
 * logical lamps to physical members, names the effect renderers, and carries
 * the MQTT topics. It arrives as JSON from three edges (the catalog file, the
 * HA snapshot, the parity harness RPC) and was previously traversed raw by ten
 * domain modules, each re-validating a different subset.
 *
 * These tests pin the parse decisions that are NOT mechanical, because each one
 * is a behaviour the domain depends on.
 */

const minimal: JsonObject = { members: {}, groups: {}, effects: {} };

test('a non-mapping members rejects the whole catalog', () => {
  // Break: a silent {} here makes every lamp lose its physical members, so
  // effects_frame_plan emits nothing and the lights simply stop responding.
  assert.throws(() => parseCatalog({ ...minimal, members: 0 }), /members must be an object/);
  assert.throws(() => parseCatalog({ ...minimal, members: null }), /members must be an object/);
  assert.throws(() => parseCatalog({ ...minimal, members: [] }), /members must be an object/);
});

test('a members entry that is not a list of strings rejects the catalog', () => {
  // Break: a non-string member flows into an MQTT topic lookup and publishes
  // to `undefined`, which silently addresses nothing.
  assert.throws(() => parseCatalog({ ...minimal, members: { 'light.a': 'light.a_1' } }), /members/);
  assert.throws(() => parseCatalog({ ...minimal, members: { 'light.a': [1] } }), /members/);
  assert.deepEqual(parseCatalog({ ...minimal, members: { 'light.a': ['light.a_1'] } }).members,
    { 'light.a': ['light.a_1'] });
});

test('an effect without a renderer rejects the catalog', () => {
  // Break: the renderer name is used as a script name in ctx.run(), so a
  // missing one becomes `Unsupported script: undefined` mid-frame instead of
  // a load-time complaint about the catalog.
  assert.throws(() => parseCatalog({ ...minimal, effects: { Candle: {} } }), /renderer must be a string/);
  assert.throws(() => parseCatalog({ ...minimal, effects: { Candle: { renderer: 7 } } }), /renderer must be a string/);
  const parsed = parseCatalog({ ...minimal, effects: { Candle: { renderer: 'fx_candle', channels: ['brightness'] } } });
  assert.deepEqual(parsed.effects.Candle, { renderer: 'fx_candle', channels: ['brightness'] });
});

test('an effect may declare no channels, and that is an empty list', () => {
  // state-store treats a missing channel list as absence, not as an error.
  assert.deepEqual(parseCatalog({ ...minimal, effects: { Candle: { renderer: 'fx' } } }).effects.Candle,
    { renderer: 'fx', channels: [] });
});

test('an absent candle_group stays absent rather than becoming an empty mapping', () => {
  // The live catalog has no candle_group at all. effects_candle_sync branches
  // on `=== undefined` to choose the 'fx_candle_active' name and id 1100;
  // handing it {} would keep the branch but is a different statement, and
  // handing it a default group name would silently create the wrong group.
  assert.equal(parseCatalog(minimal).candle_group, undefined);
  assert.deepEqual(parseCatalog({ ...minimal, candle_group: { friendly_name: 'fx_candle_active', id: 1100 } }).candle_group,
    { friendly_name: 'fx_candle_active', id: 1100 });
  // Both fields are independently optional: the consumer defaults each one.
  assert.deepEqual(parseCatalog({ ...minimal, candle_group: {} }).candle_group,
    { friendly_name: undefined, id: undefined });
});

test('an absent ui_choices stays absent so the two-choice fallback still fires', () => {
  // effects_ui_catalog publishes ['Normal Light', 'Candle'] when the catalog
  // names no choices. An empty list would publish an empty effect_list and
  // strip the effect picker from every HA light.
  assert.equal(parseCatalog(minimal).ui_choices, undefined);
  assert.deepEqual(parseCatalog({ ...minimal, ui_choices: ['Normal Light'] }).ui_choices, ['Normal Light']);
  assert.throws(() => parseCatalog({ ...minimal, ui_choices: 'Normal Light' }), /ui_choices/);
});

test('fields no consumer raises on default to empty instead of absent', () => {
  // Each of these is only iterated or looked up, and every consumer already
  // treats a missing one as nothing. Collapsing absence into emptiness removes
  // an optional the domain would otherwise re-test at each of its loops.
  const parsed = parseCatalog(minimal);
  assert.deepEqual(parsed.baseline_groups, {});
  assert.deepEqual(parsed.multicast, []);
  assert.deepEqual(parsed.topics, {});
  assert.deepEqual(parsed.phases, {});
  assert.deepEqual(parsed.processors, {});
  assert.deepEqual(parsed.remotes, {});
});

test('the two row arrays keep absence distinct from emptiness', () => {
  // Break: effects_ui_sync raises `Missing runtime catalog.ui_rows` when the
  // document names no rows, while ls_native_controls reads the same field
  // leniently and treats absence as no rows. A [] default here would silence
  // the first and make a catalog that forgot its UI rows publish nothing at
  // all instead of complaining.
  const parsed = parseCatalog(minimal);
  assert.equal(parsed.ui_rows, undefined);
  assert.equal(parsed.ui_discovery, undefined);
  assert.deepEqual(parseCatalog({ ...minimal, ui_rows: [] }).ui_rows, []);
  assert.throws(() => parseCatalog({ ...minimal, ui_rows: {} }), /ui_rows must be an array/);
});

test('multicast records are carried through unvalidated', () => {
  // effects_group_plan filters candidate groups with `continue`: an unverified
  // group, a missing topic or a one-member group is skipped, not rejected.
  // Parsing those strictly here would turn a silent skip into a raise and
  // break grouping for every catalog that contains one pending group.
  const groups = [{ verified: false }, { topic: 7 }, { members: ['light.a'] }, 'not even a record'];
  assert.deepEqual(parseCatalog({ ...minimal, multicast: groups }).multicast, groups);
  // The field itself must still be a list.
  assert.throws(() => parseCatalog({ ...minimal, multicast: {} }), /multicast must be an array/);
});

test('unknown document fields are absent from the parsed view', () => {
  // The parsed catalog is a projection of what the lighting logic reads, not a
  // mirror of the file. Unknown fields stay in the raw document that the
  // name-keyed effects_catalog shim serves, so the HA and parity edges are
  // unaffected, but they never reach domain logic.
  const parsed = parseCatalog({ ...minimal, budget: 12, something_new: { a: 1 } });
  assert.ok(!Object.hasOwn(parsed, 'something_new'));
  assert.ok(!Object.hasOwn(parsed, 'budget'));
});

test('topic and phase values must be strings', () => {
  // Both are published or passed as a renderer phase; a number would reach the
  // MQTT layer as a topic of `7`.
  assert.throws(() => parseCatalog({ ...minimal, topics: { 'light.a_1': 7 } }), /topics/);
  assert.throws(() => parseCatalog({ ...minimal, phases: { 'light.a': null } }), /phases/);
  assert.deepEqual(parseCatalog({ ...minimal, topics: { 'light.a_1': 'zigbee2mqtt/a' } }).topics,
    { 'light.a_1': 'zigbee2mqtt/a' });
});

test('a processor may omit its remote adjustment, and a present one must be a string', () => {
  // resolution defaults the adjustment per processor name when the key is
  // absent, so absence is legal and must stay distinguishable. The record's
  // other document fields are not parsed because nothing reads them: captured
  // fixtures omit `animated`, and requiring it rejected a catalog that works.
  const absent = parseCatalog({ ...minimal, processors: { 'Normal light': {} } });
  assert.equal(absent.processors['Normal light']?.remote_adjustment, undefined);
  assert.deepEqual(parseCatalog({ ...minimal, processors: { 'Normal light': { animated: 'not a boolean' } } }).processors,
    { 'Normal light': { remote_adjustment: undefined } });
  assert.throws(() => parseCatalog({ ...minimal, processors: { Normal: { remote_adjustment: 3 } } }),
    /remote_adjustment/);
});

test('a remote must name its device and source', () => {
  // The engine spreads the remote record into the gesture handler's arguments.
  assert.deepEqual(parseCatalog({ ...minimal, remotes: { studio: { device_id: 'abc', source: 'light.studio' } } }).remotes,
    { studio: { device_id: 'abc', source: 'light.studio' } });
  assert.throws(() => parseCatalog({ ...minimal, remotes: { studio: { source: 'light.studio' } } }), /device_id/);
});

test('a partial catalog parses, because requiring a registry is the loading edge\'s job', () => {
  // main.ts and live.ts both refuse to start without members, groups and
  // effects, and say so in terms of the registry. Repeating that rule here
  // would reject the single-script snapshots that carry only the collection
  // under test, and buy nothing: every consumer of the parsed view iterates or
  // looks up, so an absent collection and an empty one are the same to it.
  assert.deepEqual(parseCatalog({}).members, {});
  assert.deepEqual(parseCatalog({ members: { 'light.a': ['light.a_1'] } }).effects, {});
  // A present-but-wrong collection is still an error.
  assert.throws(() => parseCatalog({ groups: 7 }), /groups must be an object/);
});

test('a missing catalog is an explicit empty catalog, not a parse error', () => {
  // Most scripts never read the catalog, and the unit suite drives them with
  // snapshots that omit it. emptyCatalog() names that state so the context can
  // hold a real Catalog rather than an optional one.
  const empty = emptyCatalog();
  assert.deepEqual(empty.members, {});
  assert.deepEqual(empty.effects, {});
  assert.equal(empty.candle_group, undefined);
  assert.equal(empty.ui_choices, undefined);
  assert.equal(empty.ui_rows, undefined);
});

test('a non-mapping document is rejected', () => {
  assert.throws(() => parseCatalog([]), /catalog must be an object/);
  assert.throws(() => parseCatalog('{}'), /catalog must be an object/);
  assert.throws(() => parseCatalog(null), /catalog must be an object/);
});
