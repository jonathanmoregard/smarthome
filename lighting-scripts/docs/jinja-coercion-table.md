# Jinja coercion table (the oracle's semantics, measured)

`src/runtime/parse.ts` reproduces the behaviour recorded here. Every row was
measured against this repository's own pinned Home Assistant 2026.7.4 /
Jinja 3.1.6 closure — not taken from documentation — so that the TypeScript
boundary parsers agree with the comparison oracle rather than with JavaScript.

Regenerate with the probe kept alongside the parity scratch work; it imports
`tests/parity/portability.py` so it loads exactly the interpreter the parity
gate compares against.

## Why this file exists

**JavaScript's implicit coercion is not equivalent to Jinja's, and where they
differ Jinja is normally stricter.** Casting an untrusted value to `number` and
letting arithmetic coerce therefore produces values the oracle would never
produce:

| expression | Jinja 3.1.6 | JavaScript |
|---|---|---|
| `"80" + 120` | `TypeError` | `"80120"` |
| `200 - "80"` | `TypeError` | `120` |
| `[76.5, "80"] \| min` | `TypeError` | `76.5` |
| `missing + 1` | `UndefinedError` | `NaN` |
| `none + 1` | `TypeError` | `1` |
| `"80" * 2` | `"8080"` | `160` |
| `{} .rgb[0]` | `UndefinedError` | `TypeError` |

The practical consequence in this port: a brightness that arrives as the string
`"80"` instead of the number `80` made `scaleValue` return **255** at position
`0.5` (correct answer `140`) and **NaN** at negative positions, because the
declared `number` type was produced by a cast rather than by parsing. The oracle
would have raised instead.

## Filters

`| int` and `| float` with the default fallback, and with an explicit one.

| value | `\| int` | `\| int(-1)` | `\| float` | `\| float(-1.5)` | truthy |
|---|---|---|---|---|---|
| `5` | `5` | `5` | `5.0` | `5.0` | true |
| `5.7` | `5` | `5` | `5.7` | `5.7` | true |
| `"5"` | `5` | `5` | `5.0` | `5.0` | true |
| `"5.7"` | `5` | `5` | `5.7` | `5.7` | true |
| `""` | `0` | `-1` | `0.0` | `-1.5` | false |
| `" "` | `0` | `-1` | `0.0` | `-1.5` | **true** |
| `"hot"` | `0` | `-1` | `0.0` | `-1.5` | true |
| `"Infinity"` | `0` | `-1` | `Infinity` | `Infinity` | true |
| `"inf"` | `0` | `-1` | `Infinity` | `Infinity` | true |
| `"nan"` | `0` | `-1` | `NaN` | `NaN` | true |
| `"1e3"` | `1000` | `1000` | `1000.0` | `1000.0` | true |
| `"0x10"` | `0` | `-1` | `0.0` | `-1.5` | true |
| `"-5"` | `-5` | `-5` | `-5.0` | `-5.0` | true |
| `"5,0"` | `0` | `-1` | `0.0` | `-1.5` | true |
| `none` | `0` | `-1` | `0.0` | `-1.5` | false |
| `true` | `1` | `1` | `1.0` | `1.0` | true |
| `false` | `0` | `0` | `0.0` | `0.0` | false |
| `[]` | `0` | `-1` | `0.0` | `-1.5` | **false** |
| `[5]` | `0` | `-1` | `0.0` | `-1.5` | true |
| `{}` | `0` | `-1` | `0.0` | `-1.5` | **false** |

Points that cost real debugging time in this port:

1. **`| int` never yields `NaN` or `±Infinity`; `| float` does.** `"inf" | int`
   takes the fallback, `"inf" | float` is `Infinity`. This is precisely why
   `frames.ts` and `native-controls.ts` disagreed about `number("Infinity")` —
   each matched a different filter. Pick `jinjaInt` or `jinjaFloat` per call
   site according to which filter the original template used.
2. **`"0x10" | int` is the fallback**, while JavaScript's `Number("0x10")` is
   `16`.
3. **`"1e3" | int` is `1000`**, reached through Jinja's float fallback path, so
   `parseInt` (which gives `1`) is the wrong primitive.
4. **`[]` and `{}` are falsy**, unlike JavaScript, so `if (someArray)` does not
   reproduce `{% if value %}`.
5. **`NaN` is truthy** in Python (`bool(float("nan"))` is `True`) and falsy in
   JavaScript.
6. `| string` is Python `str()`: `none` becomes `"None"`, `true` becomes
   `"True"`.

## Missing keys

**Whether a missing key raises depends on how it is used, not on whether a
filter was applied.** Jinja's default `Undefined` is falsy, iterates as empty
and reports a `length` of zero; it raises only in arithmetic or a coercion
filter. Measured:

| use of a missing key | Jinja 3.1.6 | JavaScript |
|---|---|---|
| `{% if d.missing %}` | `False`, no error | `undefined` is falsy too |
| `{% if not d.missing %}` | `True`, no error | same |
| `{% for x in d.missing %}` | **empty, no error** | `TypeError` |
| `d.missing \| length` | **`0`** | `TypeError` |
| `d.missing \| list \| length` | `0` | `TypeError` |
| `d.missing is defined` | `False` | — |
| `d.missing \| default(9)` | `9` | — |
| `d.missing + 1` | **`UndefinedError`** | `NaN` |
| `d.missing \| int` | **`UndefinedError`** | — |
| `d.missing[0]` | `UndefinedError` | `TypeError` |
| `[] \| min` | `""` | `Infinity` for `Math.min()` |
| `[1, "a"] \| min` | `TypeError` | `1` |

So the rule for choosing a primitive is:

1. The captured template applies `| int`, `| float` or `| default(x)` → use the
   matching `jinja*` coercion with the same fallback. The fallback is observable
   behaviour; tightening it is a divergence.
2. The template reads the field unfiltered **and uses it in arithmetic, in a
   coercion filter, or by indexing** → absence raises in the oracle, so
   `require*` is faithful.
3. The template reads the field unfiltered but only **tests it for truthiness,
   iterates it, or takes its `length`** → absence is silently empty in the
   oracle, so the field is **optional with an empty default**. `require*` here
   is a divergence.

Case 3 is easy to get wrong and expensive: an earlier revision of this work
read "unfiltered" as "required" for `ls_dispatch`'s `output_targets` and
`remote_rooms`, both of which are iterated and only set on the partial-plan
path. That broke seven parity modules and cost 69 clean assertion tests.
Grepping a narrow window around the field name also misclassifies — a
`| default(...)` or `is defined` further along the same expression is missed,
which is how `switches` and `stale_keys` were first read as unfiltered.
