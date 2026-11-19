import assert from 'node:assert/strict';
import test from 'node:test';
import { stateStoreHandlers } from '../../src/domain/state-store.ts';
import { context } from './gestures-context.ts';

// `ls_store` was the last handler still reading raw `JsonObject` args, and its
// body coerced with JavaScript `Number()`/`String()` instead of the filters the
// captured script applies. Every expectation below is read off the captured
// `ls_store` sequence:
//
//   current = states(store) | from_json(default={})
//   b       = brightness | int                     (guarded `is defined and is not none`)
//   k       = kelvin | int                         (same guard)
//   k       = (1000000 / (mireds | float)) | int   (elif, same guard)
//   h, s    = hs[0] | float, hs[1] | float         (same guard)
//   active  = current.get('effect', 'Normal light')
//   chans   = current.get('effect_channels', catalog.effects.get(active,{}).get('channels',[]))
//   store   is a required field, and the tail evaluates store.startswith(...)
//
// The parity gate cannot see any of this: it reaches `ls_store`'s effect path
// only through `effects_set`, and no preserved suite feeds a malformed
// brightness, a zero mireds, a short hs pair, or a non-string store.

const STORE = 'input_text.profile';
const catalog = () => ({
  effects: {
    'Normal light': { channels: ['brightness', 'color'] },
    Candle: { channels: ['brightness'] },
  },
});
function store(cached = '{}') {
  const ctx = context({ ...stateStoreHandlers, effects_catalog: catalog });
  ctx.put(STORE, cached);
  return ctx;
}
const written = (ctx: ReturnType<typeof store>): Record<string, unknown> => {
  const call = ctx.calls.find(c => c.service === 'input_text.set_value');
  assert.ok(call, 'ls_store writes the merged profile back to the store entity');
  return JSON.parse(String(call.data.value));
};

test('ls_store rejects a mireds value the captured division cannot convert', () => {
  // `1000000 / (mireds | float)` is Python division. `| float` yields 0.0 for a
  // zero and for anything unparseable, so the oracle raises ZeroDivisionError.
  // JavaScript instead yields Infinity/NaN, which `JSON.stringify` had been
  // silently writing to the store as `"k":null`.
  // `true | float` is 1.0, so a boolean is NOT in this set -- only values the
  // float filter reduces to 0.0: a zero, and anything it cannot parse at all.
  for (const mireds of [0, '0', 'abc', []]) {
    assert.throws(() => store().run('ls_store', { store: STORE, mireds }),
      /ls_store\.mireds/, `mireds ${JSON.stringify(mireds)} must raise instead of writing a null kelvin`);
  }
});

test('ls_store converts a usable mireds value through the captured int truncation', () => {
  const ctx = store();
  ctx.run('ls_store', { store: STORE, mireds: 370 });
  // 1000000 / 370 = 2702.7027..., and `| int` truncates toward zero.
  assert.equal(written(ctx).k, 2702);
  assert.equal(written(ctx).m, 'ct');
});

test('ls_store reads a short or non-sequence hs pair as the float filter does', () => {
  // Jinja subscripting past the end, or into a non-sequence, yields Undefined,
  // and `Undefined | float` is 0.0 -- not JavaScript's NaN, which serialized to
  // `null` and silently stored a missing saturation as no value at all.
  const short = store();
  short.run('ls_store', { store: STORE, hs: [10] });
  assert.deepEqual([written(short).h, written(short).s], [10, 0]);

  const scalar = store();
  scalar.run('ls_store', { store: STORE, hs: 'nope' });
  assert.deepEqual([written(scalar).h, written(scalar).s], [0, 0]);
});

test('ls_store coerces brightness and kelvin with the int filter, not JavaScript Number', () => {
  // `Number('0x10')` is 16; Python's `int('0x10', 10)` raises and `float('0x10')`
  // raises too, so the captured `| int` falls back to 0. `Number([5])` is 5;
  // `int([5])` and `float([5])` both raise, so the filter yields 0 again.
  const hex = store();
  hex.run('ls_store', { store: STORE, brightness: '0x10' });
  assert.equal(written(hex).b, 0);

  const array = store();
  array.run('ls_store', { store: STORE, kelvin: [5] });
  assert.equal(written(array).k, 0);
});

test('ls_store requires a string store entity instead of coercing one', () => {
  // `store` is a required field and the captured tail calls
  // `store.startswith('input_text.ls_lamp_')`, which raises for a non-string.
  // `String(args.store)` had been turning anything at all into an entity id.
  for (const bad of [5, null, [], {}]) {
    assert.throws(() => store().run('ls_store', { store: bad }), /ls_store\.store/,
      `store ${JSON.stringify(bad)} must raise instead of being stringified`);
  }
  assert.throws(() => store().run('ls_store', {}), /ls_store\.store/);
});

test('ls_store resolves the saved effect with dict.get, which ignores an explicit null', () => {
  // `current.get('effect', 'Normal light')` falls back only on an ABSENT key, so
  // a cached explicit null resolves to None, `effects.get(None, {})` is empty,
  // and the channel list is empty. `??` had been treating that null as absent
  // and claiming Normal light's channels instead.
  const ctx = store('{"effect":null}');
  ctx.run('ls_store', { store: STORE, on: true });
  assert.deepEqual(written(ctx).effect_channels, []);
});

// A saved channel list is read by a lenient parser with a default (user
// directive 2026-11-19: "typed with parser that is flexible and has default"):
// a present non-list is treated as absent, i.e. the active effect's catalog
// channels. One test per input class.
test('saved effect_channels: an absent key takes the active effect\'s catalog channels', () => {
  const absent = store('{"effect":"Candle"}');
  absent.run('ls_store', { store: STORE, on: true });
  assert.deepEqual(written(absent).effect_channels, ['brightness']);
});

test('saved effect_channels: an explicit null is treated as absent', () => {
  for (const args of [{ on: true }, { brightness: 3 }]) {
    const ctx = store('{"effect":"Candle","effect_channels":null}');
    ctx.run('ls_store', { store: STORE, ...args });
    const expected = 'brightness' in args ? [] : ['brightness'];
    assert.deepEqual(written(ctx).effect_channels, expected, `with ${JSON.stringify(args)}`);
  }
});

test('saved effect_channels: any other present non-list is treated as absent', () => {
  for (const bad of ['"x"', '""', '0', '5', 'false', '{}', '{"a":1}']) {
    const ctx = store(`{"effect":"Candle","effect_channels":${bad}}`);
    ctx.run('ls_store', { store: STORE, on: true });
    assert.deepEqual(written(ctx).effect_channels, ['brightness'], `effect_channels ${bad}`);
  }
});

test('saved effect_channels: a list, empty included, is kept as stored', () => {
  for (const [saved, expected] of [['[]', []], ['["color"]', ['color']]] as const) {
    const ctx = store(`{"effect":"Candle","effect_channels":${saved}}`);
    ctx.run('ls_store', { store: STORE, on: true });
    assert.deepEqual(written(ctx).effect_channels, expected, `effect_channels ${saved}`);
  }
});

test('ls_store treats an unparseable cache as empty but a non-mapping cache as malformed', () => {
  // `from_json(default={})` swallows a parse failure, so this fallback is
  // faithful and must stay. A cache that parses to a non-mapping is different:
  // the captured `current.get(...)` raises on it.
  const garbage = store('not json at all');
  garbage.run('ls_store', { store: STORE, on: true });
  assert.equal(written(garbage).on, true);

  assert.throws(() => store('5').run('ls_store', { store: STORE, on: true }), /ls_store\.store entity/);
});

const storedText = (ctx: ReturnType<typeof store>): string =>
  String(ctx.calls.find(c => c.service === 'input_text.set_value')?.data.value);

test('ls_store writes the cached profile first, in its order, then the patch', () => {
  // `{...current, ...patch}`: an existing key keeps its position and takes the
  // new value, a key nothing reads passes through, new keys follow in patch order.
  const ctx = store('{"k":1,"x":{"y":[1,null]},"b":5}');
  ctx.run('ls_store', { store: STORE, brightness: 9, on: true });
  assert.equal(storedText(ctx), '{"k":1,"x":{"y":[1,null]},"b":9,"on":true,"effect_channels":["color"]}');
});

test('ls_store release filters drop only the literal channel names', () => {
  const ctx = store('{"effect_channels":[1,{"a":1},"brightness","color",null]}');
  ctx.run('ls_store', { store: STORE, brightness: 3, kelvin: 2700 });
  assert.equal(JSON.stringify(written(ctx).effect_channels), '[1,{"a":1},null]');
});

test('ls_store raises a malformed cache before the catalog call', () => {
  const runs: string[] = [];
  const counting = (cached: string) => {
    const ctx = context({ ...stateStoreHandlers, effects_catalog: () => { runs.push('catalog'); return catalog(); } });
    ctx.put(STORE, cached);
    return ctx;
  };
  assert.throws(() => counting('[1]').run('ls_store', { store: STORE, on: true }), /non-mapping/);
  assert.deepEqual(runs, []);
});

test('ls_store looks effects up by hashable key only, raising for a container', () => {
  assert.throws(() => store('{"effect":{"a":1}}').run('ls_store', { store: STORE, on: true }), /ls_store\.effect.*unhashable/);
  assert.throws(() => store().run('ls_store', { store: STORE, effect: [] }), /ls_store\.effect.*unhashable/);
  const numeric = store();
  numeric.run('ls_store', { store: STORE, effect: 5 });
  assert.equal(storedText(numeric), '{"effect":5,"effect_channels":[]}');
  const named = store();
  named.run('ls_store', { store: STORE, effect: 'Candle', brightness: 1 });
  assert.equal(storedText(named), '{"b":1,"effect":"Candle","effect_channels":["brightness"]}');
});
