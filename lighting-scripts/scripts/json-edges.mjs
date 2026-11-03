// Guard: JSON belongs at the edges, not in the domain.
//
// `JsonObject`/`JsonValue` is the INPUT to parsing, never the result. A parser
// that returns the unparsed type has not parsed anything, and a domain type
// written `interface X extends JsonObject` is a validated bag: it inherits the
// index signature, so every field stays JsonValue-assignable, arbitrary keys
// stay legal, and invalid states stay representable.
//
// The legitimate JSON edges are the HA transport, the parity harness RPC and
// on-disk state -- under src/runtime, src/parse or src/live.ts. src/domain is
// not an edge, and inter-handler calls are not an edge either.
//
// Read this honestly: these counts cover src/domain ONLY, so moving a parser
// into src/parse lowers them without deleting a single `JsonObject`. That is
// the intended mechanism for criteria 4 through 8 -- the parse layer is the
// declared boundary and is EXPECTED to grow as the domain empties -- but it
// means a falling total here is evidence about where JSON lives, not about how
// much of it there is. Two things therefore do not count as progress: moving a
// parser to src/parse and leaving its call sites in the domain (the accessor
// and type counts stay put, correctly), and relocating domain logic that was
// never a parser just to get it out of this directory.
//
// Ceilings ratchet DOWN only. Raising one is the regression this guard exists
// to catch, so a raise must be argued in the commit message, never done to make
// a build pass.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOMAIN = join(ROOT, 'src/domain');

/**
 * Ceilings for src/domain. Baseline measured 2026-11-03 before any rework was
 * `442 / 9 / 293 / 62`.
 *
 * `lenientAccessors` 293 -> 282 after the runtime catalog was parsed once at
 * the edge: eleven `object(...)`, `strings(...)` and `num(...)` calls existed
 * only to re-dissolve the catalog document at each read site.
 *
 * `validatedBags` 9 -> 0 with criterion 3: every `interface X extends
 * JsonObject` became a type alias, so arbitrary keys are now illegal (TS2353)
 * and the fields no longer inherit an index signature. Type-level only, erased
 * at runtime.
 *
 * `jsonTypes` 442 -> 431 as a mechanical consequence of that same change: the
 * twelve debagged declarations contained eleven literal `JsonObject` tokens,
 * which the regex counts. No *read* became typed here, so the drop overstates
 * criterion 3's reach. The remaining 431 are dominated by handler arguments,
 * handler return types and entity-state reads, and move with criteria 4
 * through 8. A criterion that reduces accessors without reducing types is still
 * making real progress, so the four ratchet independently.
 *
 * Criterion 4 cleared the four leaf modules — `scale`, `gradient`, `blocks`,
 * `frames` — to zero on every count, which is why they no longer appear in the
 * table at all. `jsonTypes 431 -> 414`, `lenientAccessors 282 -> 277`,
 * `rawJsonReturns 62 -> 60`. The parsers they used to hold now live in
 * `src/parse/`, and `isObject`/`object` moved to `src/runtime/parse.ts`. Note
 * that moving a *definition* out of `src/domain` does not move these counts:
 * the regexes count call sites and signatures, so the 277 remaining accessor
 * calls are still in domain code and only fall as each module gets properly
 * parsed in criteria 5 through 8.
 *
 * Criterion 5's typing pass is the kind that IS real elimination, and it shows
 * in the accessor column: giving `profile`/`sample`/`interpolate` real return
 * types took `schedule.ts` from 64 lenient calls to 48 and from 7 raw-JSON
 * returns to 4 without relocating a single function.
 * `jsonTypes 414 -> 410`, `lenientAccessors 277 -> 261`,
 * `rawJsonReturns 60 -> 57`.
 *
 * Criteria 2 and 8 then land one entrypoint at a time, and the per-entrypoint
 * movement is small by construction: `ls_switch_plan` is worth
 * `jsonTypes 410 -> 408`, `lenientAccessors 261 -> 260`,
 * `rawJsonReturns 57 -> 56`. Read that as a unit price, not as the size of the
 * change -- the commit that moves it also builds the seam (`ctx.call`, the
 * typed/JSON handler pair and the result codecs) that the remaining 21
 * entrypoints reuse. The expected total is the ~112 references the handler
 * boundary holds: 57 raw-JSON returns plus 55 local JSON output builders.
 *
 * `effects_resolve` and `effects_gradient_plan` next: `lenientAccessors
 * 260 -> 257`, and the other three columns do not move at all. Worth reading
 * carefully, because it exposes a limit of this script rather than a limit of
 * the work. `rawJsonReturns` counts the regex `): JsonObject`, so a handler
 * registered as a bare `(_context, args) => fn(args)` -- which both of these
 * were -- never counted as a raw JSON return in the first place. The 57 is
 * therefore a LOWER BOUND on the handler boundary, and converting an
 * unannotated handler shows up only in the accessor column. Do not widen the
 * regex to fix this: that would raise every count and read as a regression.
 *
 * `effects_emit` and `effects_assign` move all three live columns —
 * `jsonTypes 408 -> 407`, `lenientAccessors 257 -> 255`,
 * `rawJsonReturns 56 -> 54` — because both were annotated `): JsonObject` and
 * `emitCommands` builds its whole result (`{published_at, completed}`) from
 * what this call published, so its type adds no JSON token back.
 *
 * **The selection rule that fell out of these five conversions, and the reason
 * the next ones are not in this order:** an entrypoint pays off here only when
 * its result is CONSTRUCTED. Where the result is mostly passthrough of an
 * unparsed document, its type has to keep saying `JsonObject` to stay lossless,
 * so converting it ADDS tokens here while removing accessors elsewhere.
 * `effects_candle_plan` is the measured example: `lamps`, `actual`, `members`
 * and `remove` are all raw HA attribute data, so its result type costs ~5
 * tokens to save ~5 accessor calls. Those entrypoints wait for criteria 6/7 to
 * parse the underlying data first; converting them now would need a ceiling
 * raise to show no real progress.
 *
 * `ls_dispatch` and `ls_commit`, both constructed results, both unions that
 * say what the handler really answers (`null` for a stale plan; `{accepted:
 * false}` for a stale revision): `jsonTypes 407 -> 405`,
 * `lenientAccessors 255 -> 254`, `rawJsonReturns 54 -> 52`.
 *
 * **The seam is not required to type a result, and eight handlers prove it.**
 * `typed()` exists so a CALLER can read a real type; where nothing internal
 * consumes the result, the whole of criterion 8 is the return annotation. Eight
 * such handlers went over in one pass -- `effects_ui_sync`'s messages and
 * `ls_range_save`'s rule are constructed, and `ls_store`, `ls_render`,
 * `effects_engine`, `effects_engine_tick`, `ls_remote_gesture` and
 * `effects_set` answer `null` or an already-named `ControlPlan` on every path.
 * `jsonTypes 405 -> 393`, `lenientAccessors 254 -> 253`,
 * `rawJsonReturns 52 -> 44`: eight raw returns for eight signatures, and the
 * biggest single movement in this mission so far, at no seam cost and with no
 * call site touched. Read THE SELECTION RULE above together with this: the
 * question is whether the result is constructed, NOT whether it goes through
 * `typed()`.
 *
 * **THE SELECTION RULE, REFINED — and this is the version to use.** The rule
 * above weighed only the result's own tokens, and on that reading
 * `effects_group_plan` looked not worth converting: its commands carry a raw
 * `payload` and a raw `group`, so its result type must add two JSON tokens.
 * Measured with the CALLERS counted, the trade is not close. `framePlan`
 * returns `ctx.call('effects_group_plan', ...)` unchanged, so one result type
 * serves `effects_frame_plan` too, and the two sites that read it shed an
 * `object(`, a `list(`, a `.map(object)`, four `String(...)` comparisons on
 * `command.topic` and two `strings(command.members)` calls -- which also
 * killed `transport.ts`'s whole local `strings` helper.
 * `jsonTypes 393 -> 389`, `lenientAccessors 253 -> 245`,
 * `rawJsonReturns 44 -> 42`: the two added tokens are real and still the
 * column falls.
 *
 * So: **a conversion pays off when the result's added tokens are fewer than
 * the accessors its callers shed.** A constructed result is the case where
 * that holds automatically, not the only case. Before parking an entrypoint as
 * "passthrough", read its callers and count.
 *
 * `effects_candle_plan` is that rule applied, and it was the entrypoint parked
 * TWICE as not worth converting -- the earlier note put it at "~5 tokens to
 * save ~5 accessors". Counted properly: three fields stay JSON (`lamps`,
 * `actual`, `remove`, each for a different and written-down reason) while
 * seven accessors go from `iterate()`. `jsonTypes 389 -> 385`,
 * `lenientAccessors 245 -> 238`, `rawJsonReturns 42 -> 40`. The accessor
 * prediction was exact; the token drop beat it, because the caller shed its
 * own `JsonValue` locals too.
 *
 * `ls_remote_plan` (+ `ls_remote_command`, typed for free as its only caller)
 * is the first conversion where **this script measures almost none of the
 * value**: `jsonTypes 385 -> 382`, `rawJsonReturns 40 -> 38`, and
 * `lenientAccessors does not move at all`. That is not a disappointing result,
 * it is a limit of the four regexes. The reads it deleted were
 * `requireString(result, 'input_revision')`, `requireBoolean(result.on)` and
 * `requireArray(result, 'targets')` in `ls_remote_command`, and the
 * `lenientAccessors` pattern counts only `object|values|list|num|
 * jinjaMappingGet|String`. Strict `require*` re-reads of an already-produced
 * result are invisible here and always were. When a conversion's payoff is
 * strict re-reads rather than lenient ones, argue it in the commit message and
 * ratchet what moved -- do not go looking for a different conversion because
 * this table liked it better.
 *
 * `ls_base`/`ls_room_base` start here, and deliberately only start.
 * `ScheduledBaseResult` types the envelope and the command union exactly --
 * `schedule_details` was ALWAYS `Record<string, ScheduleDetails>` and the
 * field threw the type away -- while `cmds`'s `rgb` stays `JsonValue[]`,
 * because it comes off a raw `rgb_color` attribute that reaches compared JSON
 * unchanged. `profiles`, `targets` and the seam conversion are NOT in this
 * commit: a decoder for a half-described result would have to promise fields
 * the type only half-knows, and `falsy-boundaries.test.ts:219` stubs `ls_base`
 * with a deliberately missing `targets` that must keep raising.
 * `jsonTypes 382 -> 379`, `rawJsonReturns 38 -> 37`.
 *
 * Then `profiles` and `targets`, which had to land together because the lamp
 * target is built as `{...p, ...}` from the profile. `targets` is a union of
 * two genuinely asymmetric shapes -- the room entry has no `send`,
 * `transition` or `observed`, and its `area` is a plain string where the
 * lamp's is nullable -- so it is two union members rather than one
 * optional-heavy shape. `jsonTypes 379 -> 377`; `effect` and
 * `effect_channels` stay `JsonValue` on both, since `saved(...)` produces them
 * and `ls_store`/`effects_ui_sync` round-trip them. `ScheduledBaseResult` is
 * now complete, which is what makes the seam conversion's decoder writable at
 * all -- that is the next commit, deliberately separate, because it is where
 * the stub handling and the only behaviour change live.
 */
const CEILINGS = {
  jsonTypes: 377,
  validatedBags: 0,
  lenientAccessors: 238,
  rawJsonReturns: 37,
};

/** Comments may legitimately name these types while explaining why they are gone. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PATTERNS = {
  jsonTypes: /\bJson(?:Object|Value)\b/g,
  validatedBags: /\binterface\s+\w+\s+extends\s+Json(?:Object|Value)\b/g,
  lenientAccessors: /(?<![A-Za-z0-9_$.])(?:object|values|list|num|jinjaMappingGet|String)\s*\(/g,
  rawJsonReturns: /\)\s*:\s*Json(?:Object|Value)\b/g,
};

const count = (text, pattern) => (text.match(pattern) ?? []).length;

const files = (await readdir(DOMAIN)).filter(name => name.endsWith('.ts')).sort();
const totals = Object.fromEntries(Object.keys(PATTERNS).map(key => [key, 0]));
const rows = [];

for (const name of files) {
  const text = stripComments(await readFile(join(DOMAIN, name), 'utf8'));
  const row = { name };
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    row[key] = count(text, pattern);
    totals[key] += row[key];
  }
  rows.push(row);
}

const COLUMNS = [
  ['jsonTypes', 'JsonObject/Value'],
  ['validatedBags', 'extends Json'],
  ['lenientAccessors', 'lenient calls'],
  ['rawJsonReturns', 'raw JSON returns'],
];

rows.sort((a, b) => b.jsonTypes - a.jsonTypes);
const width = Math.max(...files.map(name => name.length), 8);
console.log('src/domain — JSON at the edges\n');
console.log(`${'file'.padEnd(width)}  ${COLUMNS.map(([, label]) => label.padStart(16)).join('  ')}`);
for (const row of rows) {
  if (!COLUMNS.some(([key]) => row[key] > 0)) continue;
  console.log(`${row.name.padEnd(width)}  ${COLUMNS.map(([key]) => String(row[key]).padStart(16)).join('  ')}`);
}
console.log(`${'TOTAL'.padEnd(width)}  ${COLUMNS.map(([key]) => String(totals[key]).padStart(16)).join('  ')}`);
console.log(`${'ceiling'.padEnd(width)}  ${COLUMNS.map(([key]) => String(CEILINGS[key]).padStart(16)).join('  ')}`);

const over = COLUMNS.filter(([key]) => totals[key] > CEILINGS[key]);
const slack = COLUMNS.filter(([key]) => totals[key] < CEILINGS[key]);

if (over.length > 0) {
  console.error('\nFAIL: JSON moved back into the domain.');
  for (const [key, label] of over) {
    console.error(`  ${label}: ${totals[key]} exceeds the ceiling of ${CEILINGS[key]}`);
  }
  console.error('Parse at the edge and hand the domain a real type. Do not raise the ceiling.');
  process.exit(1);
}

// Progress does NOT fail the build. A red check mid-refactor invites someone to
// "fix" it by reverting the improvement, and it breaks the edit-then-check loop.
// The ratchet is applied deliberately at commit time, prompted by this notice.
if (slack.length > 0) {
  console.log('\nProgress made. Ratchet these ceilings down in scripts/json-edges.mjs before committing:');
  for (const [key, label] of slack) {
    console.log(`  ${label}: ${CEILINGS[key]} -> ${totals[key]}`);
  }
} else {
  console.log('\nOK: every count sits exactly at its ceiling.');
}
