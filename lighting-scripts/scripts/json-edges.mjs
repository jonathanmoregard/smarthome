// Guard: JSON belongs at the edges, not in the domain.
//
// `JsonObject`/`JsonValue` is the INPUT to parsing, never the result. A parser
// that returns the unparsed type has not parsed anything, and a domain type
// written `interface X extends JsonObject` is a validated bag: it inherits the
// index signature, so every field stays JsonValue-assignable, arbitrary keys
// stay legal, and invalid states stay representable.
//
// The legitimate JSON edges are the HA transport, the parity harness RPC and
// on-disk state -- under src/runtime, src/parse, src/adapter or src/live.ts.
// src/domain is not an edge, and inter-handler calls are not an edge either.
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

// `--root <dir>` reads another project (a test fixture); the default is this one.
const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag === -1 ? fileURLToPath(new URL('../', import.meta.url)) : process.argv[rootFlag + 1];
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
 *
 * `ls_base`/`ls_room_base` then went through the seam, and the measured result
 * is one accessor: `lenientAccessors 238 -> 237`, the `list(schedule.stale_keys)`
 * in `plan`. The other three reads it deleted -- `requiredResultObject` and two
 * `requireObject`s -- are strict and so invisible here, as the note above
 * predicted. Do not read the single digit as the size of the change: it moved a
 * 140-line decoder's worth of verification from the consumer to the boundary
 * and closed two of the four remaining entrypoints.
 *
 * `ls_plan` then got a return type and NO seam entry: `jsonTypes 377 -> 376`,
 * `rawJsonReturns 37 -> 36`, and zero accessors, which is the whole honest
 * story of this one. The seam was ruled out by measurement, not taste --
 * `tests/parity/test_bridge.py:54-60` stubs `ls_plan` with
 * `{'marker': ['literal', 7]}`, a document with no `plan` key, and asserts
 * `ls_apply` returns it verbatim; `gate.py:133` runs that file and its exit
 * code is one of the nine gate assertions. A second literal
 * (`adapters.py:220-222`) is pinned to exactly `{plan: {base, resolved}}`. No
 * decoder accepts both, so `ls_plan` stays out of `TypedResults` and `apply`
 * stays `JsonValue`. The three reading callers keep their `object(...)` reads,
 * which is why the accessor column does not move; typing the construction of
 * all nine fields is the criterion-8 value here, and it is not a number this
 * guard can see. Do NOT widen the regexes to make it visible.
 *
 * Criterion 6 starts with `effects_group_plan`: `jsonTypes 376 -> 363`,
 * `lenientAccessors 237 -> 234`. Rows and groups are parsed in
 * `src/parse/grouping.ts`; the payload and the group id are carried as
 * `Verbatim` (`src/runtime/verbatim.ts`), an opaque handle that IS the
 * document at runtime -- so every encoder stays the identity and no compared
 * byte can move -- but has no readable property, so the domain cannot traverse
 * it. That is not a renamed `JsonValue`: a `JsonValue` field can be read, and
 * this cannot. What `grouping.ts` still holds is `planCandle` and its result,
 * which the user has taken out of the port ("no need to port old candle, use
 * the new firmware", 2026-11-19); `candle-sync.ts` reads that result as JSON
 * and is to be left untouched, so those tokens stay until the code is removed.
 *
 * `ls_room_plan` then clears `planning.ts` to zero on every column:
 * `jsonTypes 363 -> 324`, `lenientAccessors 234 -> 226`,
 * `rawJsonReturns 36 -> 32`. The room cache is treated as the on-disk edge
 * it is -- `cacheVersion` is the oracle's own literal, so a cache the live
 * Jinja script wrote hits here -- and its baseline, schedule and the plan
 * built over them are carried, with `withFields` doing the `{...doc, ...}`
 * spreads at the edge. Every raise the inline reads made is a thunk in
 * `src/parse/planning.ts`, called where the inline read sat, so none moves.
 * The two pre-existing divergences (`validCache` tighter than the oracle, the
 * bare `last_updated` read) are preserved and marked at their sites.
 *
 * `effects_resolve` clears `resolution.ts` to zero: `jsonTypes 324 -> 287`,
 * `lenientAccessors 226 -> 203`, `rawJsonReturns 32 -> 29`. Claims, patches,
 * records and base items are parsed in `src/parse/resolution.ts`; numeric
 * reads are the exact `Number(...)` / `String(...)` coercions the inline code
 * applied, precomputed there, and every read that raised is a thunk called
 * where it sat. `recordTimestamp` and `latestRemoteKey` read stored records,
 * so they moved to the parse layer with their callers repointed. The pre-
 * existing `warm_end` cast moved with them, unchanged and marked.
 *
 * The software candle is gone, replaced by the bulb firmware's own (a
 * deliberate behaviour change, not a representation step): `candle-sync.ts`,
 * `planCandle` and its result type, the two candle-group automations and the
 * `effect_candle_frame` renderer were deleted rather than converted.
 * `jsonTypes 287 -> 257`, `lenientAccessors 203 -> 185`,
 * `rawJsonReturns 29 -> 25`. This is deletion, not parsing: no surviving read
 * became typed. The new firmware path adds no accessor -- the stop check in
 * `effects_assign` shares the one lenient read of the old assignment that was
 * already there.

 *
 * Criterion 7 U0 moved the accessors (`list`, `strings`, `num`,
 * `nativeScalar`, `timestamp`, `optionalTimestamp`, `saved`) out of
 * `schedule.ts` into `src/parse/accessors.ts`, and folded the seven private
 * copies of `lazy()` into `runtime/parse.ts`. `jsonTypes 257 -> 246`,
 * `lenientAccessors 185 -> 183`, `rawJsonReturns 25 -> 22`, and **every one of
 * those is a definition's own signature or body leaving the directory** --
 * exactly the "moving a definition" case the header warns about. Not one call
 * site changed; the domain still imports the accessors (through a temporary
 * re-export in `schedule.ts`) and calls them as often as before.
 *
 * U1, `gestures.ts`: `jsonTypes 246 -> 242`, the module's four tokens. Its
 * parsers moved to `src/parse/gestures.ts`; the preset payload is now a
 * `PresetPayload` of the two fields the gesture reads (no coercion, so a
 * string preset stays not-a-preset), and `ls_remote_power_quiet` carries its
 * forwarded argument document as `Verbatim`. The one lenient call left,
 * `String(value)` in the helper writer, formats an already-typed
 * `string | number` into an HA state string; it is not a parse, so it was
 * left rather than respelled to dodge this regex.
 *
 * U2, the override documents' types and their first consumers
 * (`ls_override_block`, `ls_clear_overrides`, `ls_sara_mode`):
 * `jsonTypes 242 -> 237`, `lenientAccessors 183 -> 178`. `StoredFact`
 * (`src/parse/overrides.ts`) is a stored value typed so it cannot be traversed:
 * scalars as themselves, containers as `Verbatim`, the same reference at
 * runtime, so every `===` and `??` on it is the raw value's. The override-block
 * scope's unhashable raise is a thunk, still thrown after the `ls_apply` dry
 * run. `src/parse/sensors.ts` holds the lenient `overrides` reader.
 *
 * U3, `ls_store`: `jsonTypes 237 -> 224`, `lenientAccessors 178 -> 172`,
 * `rawJsonReturns 22 -> 20`. The saved profile is a `StoredProfile` -- the
 * document as an `OpaqueMap`, the active effect, and the channel list as
 * `StoredValue[] | 'absent' | 'non-list'` -- and the patch a `ProfilePatch`
 * whose keys are written in the captured order. The `effects_catalog` call
 * stays a call (it is recorded); its result is read by
 * `catalogEffectChannels`, whose unhashable-key raise happens at lookup.
 *
 * U4, `ls_commit`, clears `state-store.ts` to zero on every column:
 * `jsonTypes 224 -> 188`, `lenientAccessors 172 -> 162`,
 * `rawJsonReturns 20 -> 18`. The request is a `CommitData` of `StoredFact`s
 * and lazy readers (`src/parse/overrides.ts`); stored records are read through
 * one lenient `OverrideRecord` view whether they came from the sensor or were
 * written earlier in the same commit; the written attributes are an
 * `OverridesPatch` built in the captured key order, with stored maps carried
 * as `OpaqueMap`s and spread. Every `===`, `??` and `Set` on a stored value is
 * the raw value's, because `StoredFact` is the raw value. The three known
 * divergences in `commit` (two bare `last_updated` reads, the `created ?? when`
 * fallback, the `previousReason &&` truthiness) are unchanged and marked
 * `// divergence:` for their own commits.
 *
 * Breathe and Colour loop ran on the bulbs, like Candle, until they were
 * removed (a deliberate behaviour change, not a representation step): the
 * frame renderers (`frames.ts`), the engine and its tick (`effects_engine`,
 * `effects_engine_tick`: admission, rotation, `served`) and
 * `automation.effects_lifecycle` were deleted rather than converted, and the
 * frame plan stopped parsing `renderer`, `phases`, `timestamp` and
 * `animation_tick`. `jsonTypes 188 -> 186`, `lenientAccessors 162 -> 154`;
 * `rawJsonReturns` stays 18 because both engine handlers were typed `null`.
 * Deletion again, not parsing. The start/stop checks share one lenient read
 * of an unparsed target (`runningIn`), which replaced the candle's own.
 *
 * U5, `automations.ts`, clears the module on every column:
 * `jsonTypes 186 -> 164`, `lenientAccessors 154 -> 139`,
 * `rawJsonReturns 18 -> 17`. Trigger fields are `StoredFact`s (compared by
 * identity, forwarded as stored); the writer's event data and `who`, the
 * preset payload, the native-control value and the capture's records are
 * `Verbatim`. `src/parse/automations.ts` holds the trigger parsers, the
 * lenient `ui_rows` source match, the `effects_native_plan` capture view
 * (records read after the power events, where the inline read sat) and the
 * expiry ages, which skip non-mapping records exactly as the inline filter did.
 *
 * U6, `ui-state.ts`: `jsonTypes 164 -> 153`, `lenientAccessors 139 -> 117`,
 * `rawJsonReturns 17 -> 15`. UI rows are parsed one per loop iteration (the
 * store still raises before the members); the runtime sensor's targets and
 * assignments are read through a lenient `UiTargetView` of the fields the
 * mirror reads, each with the inline type test; a display colour is a
 * `Display` whose branch is chosen by key (`'kelvin' in display`) exactly as
 * before; the discovery config is carried and re-spread with `effect_list`.
 * `ls_range_save` parses its arguments up front (nothing between the reads can
 * raise). The two `String(...)` calls left format already-typed numbers into
 * MQTT payloads; they are not parses.
 *
 * U7, `native-controls.ts`, clears the module on every column:
 * `jsonTypes 153 -> 100`, `lenientAccessors 117 -> 112`,
 * `rawJsonReturns 15 -> 9`. Both results are constructed, so both are real
 * unions now: `ChannelRecord` with `Record<string, ChannelClaim>`,
 * `PowerEvent`/`SetEvent`, and `ControlCommand`, which is what lets
 * `setControls` dispatch on `command.action` with no `String()`/`object()`.
 * Service data is a `ServiceData` of requests chosen by the first key held
 * (components read per scope item, where the inline reads sat); the catalog's
 * `groups`/`effects` keep their `in` tests; plan targets are read leniently or
 * strictly where each inline read was; the control value is a `ControlValue`
 * of the Jinja readings the checks apply. Pass-through values -- an absolute
 * brightness, a Kelvin value, the underlying colour, the native stamp -- are
 * carried.
 *
 * U8, `transport.ts`, clears the module on every column:
 * `jsonTypes 100 -> 75`, `lenientAccessors 112 -> 102`,
 * `rawJsonReturns 9 -> 8`. The four handlers' parsers and the runtime
 * sensor's lenient reads live in `src/parse/transport.ts`. A frame source's
 * value is read as `value | float` and, for the colour channel only when it is
 * sent, strictly as a `FrameColour`; frame rows and payloads are constructed
 * types. Persisted or forwarded documents are carried: the assigned targets
 * and assignments, the applied map, the multicast groups, a guard's effect
 * targets, a filtered command's other keys, and `AssignResult.generation`
 * (its decoder in `results.ts` carries it too). `runningIn` reads a
 * `StoredChannels` view, so `dispatch-render`'s one call wraps its target in
 * `storedChannels(...)`; that module's counts do not move. The `revisionNow`
 * fallback is a known divergence, unchanged and marked.
 *
 * U9, `dispatch-render.ts`, clears the module on every column:
 * `jsonTypes 75 -> 48`, `lenientAccessors 102 -> 82`,
 * `rawJsonReturns 8 -> 7`. `src/parse/dispatch-render.ts` holds the dispatch
 * plan parser (a baseline entry is still required only when its lamp reaches
 * the baseline check; switches, mirrors and stale keys still after
 * assignment), the runtime reads `ls_dispatch` makes before assigning, and
 * lenient views of the `ls_plan` / `ls_room_plan` results `ls_render` merges,
 * read in the inline order so `list()`/`strings()` raise where they did.
 * Resolved targets and assignments, the merged plans, room-cache updates and
 * the applied map are carried; areas, requested lights, remote rooms, stale
 * keys and `sara_mirror` are stored facts, compared by identity. The `''`
 * revision fallback and the `|| 'config'` / `|| []` truthiness are known
 * divergences, unchanged and marked.
 *
 * U10, `remote-input.ts`, clears the module on every column:
 * `jsonTypes 48 -> 36`, `lenientAccessors 82 -> 55`,
 * `rawJsonReturns 7 -> 5`. `src/parse/remote-input.ts` reads the stored
 * remote input record (its value's step range, adjustment, position,
 * channels, selection, preset contexts and expiry), the other stored records
 * the restart check reads (each one's newest update a thunk, read only once it
 * applies), the `ls_room_plan` answer (stale keys, room period, schedule) and
 * the saved power. The input value and the adjustment are `AssembledMap`s
 * (`src/parse/overrides.ts`): the keys the planner sets plus the stored ones
 * carried unread, in place; an adjustment's numbers are read on demand with
 * `num()`'s own message. The `ctx.now` revision fallback is a known
 * divergence, unchanged and marked.
 *
 * U11, `controller.ts`, clears the module on every column:
 * `jsonTypes 36 -> 15`, `lenientAccessors 55 -> 49`,
 * `rawJsonReturns 5 -> 0`. `src/parse/controller.ts` holds the four
 * handlers' argument parsers and `ls_plan`'s attribute reads, each called
 * where the inline read sat, between the inter-handler calls. A switch rule's
 * interval and a room target's `Number(level)` and `on` are read at the
 * rule's turn. The overrides (as stored and entry by entry), the active
 * overrides, the cached gradients, the power and switch-range mappings and the
 * range defaults are carried. `ls_apply` answers `Verbatim | null`: whatever
 * answered to `ls_plan` is still forwarded verbatim (`test_bridge.py`).
 *
 * U12, `schedule.ts`, clears the module on every column:
 * `jsonTypes 15 -> 0`, `lenientAccessors 49 -> 3`. The accessor
 * re-exports are gone; every importer reads `src/parse/accessors.ts`.
 * `src/parse/schedule.ts` reads the stored override records (each field a
 * thunk or a typed view, a record's `when` read only where the schedule reads
 * it, its kind and value spelled with the `String(...)` they always were),
 * the saved profiles (`own`/`on` required only where read), a lamp's live
 * profile and sample (rgb carried as stored), and the state and attribute
 * numbers. `latestRemote`, `isRemote` and `applies` take typed records. The
 * `num()` re-reads of `scheduleDetails`' own finite numbers are dropped, and
 * `pythonFloatText` (`src/runtime/format.ts`) spells the debug floats. The
 * three lenient calls left are the text formatting in `gestures.ts` and
 * `ui-state.ts`.
 *
 * Criteria 9 and 10 close the domain at 0 on every column:
 * `lenientAccessors 3 -> 0`. The last three were text formatting, not parses:
 * `gestures.ts` writing a helper's new state and `ui-state.ts` writing two
 * numbers into an MQTT payload. They now call `stateText` and `payloadNumber`
 * (`src/runtime/format.ts`), which keep JavaScript's own number-to-text
 * conversion, byte for byte. Every ceiling is 0, and `npm run check` fails on
 * any count above it: `src/domain` names no JSON type, extends no JSON bag,
 * calls no lenient accessor and returns no raw JSON.
 *
 * `parseHelpers` (added at the close-out review, 2026-11-19) closes the gap the
 * token counts left: a domain file could name no JSON type and still parse
 * inferred JSON, by handing a strict or Jinja-coercing parse helper a value
 * it never typed -- an inline `parse: args => ({ x: requireString(args, ...) })`
 * in a handler table, `requireObject` on a carried document, `jinjaFloat` or
 * `jinjaInt` on `ctx.attr`/`ctx.get`. Measured 16 when added: remote-input 3,
 * schedule 2, planning 3, gestures 3, resolution's `effects_scale` 4,
 * transport 1. Each moved into a `src/parse` reader returning a typed value;
 * ceiling 0. Not counted: `jinjaTruthy`, the named
 * predicate the session rules require for Jinja `or`/`and` (a truth test,
 * not a parse), and `ParseError` itself.
 */
const CEILINGS = {
  jsonTypes: 0,
  validatedBags: 0,
  lenientAccessors: 0,
  rawJsonReturns: 0,
  parseHelpers: 0,
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
  parseHelpers: /(?<![A-Za-z0-9_$.])(?:require(?:Object|Number|String|Array|Boolean|Finite|Range|Rgb)|jinja(?:Int|Float|String)|parseFinite|parsePythonNumeric|optional(?:Finite|Boolean)|anchor)\s*\(/g,
};

const count = (text, pattern) => (text.match(pattern) ?? []).length;

// Recursive: src/domain/types is domain too. The handler shells under
// src/handlers were held to the same zero until M3 deleted them.
const files = (await readdir(DOMAIN, { recursive: true })).filter(name => name.endsWith('.ts')).sort();
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
  ['parseHelpers', 'parse helpers'],
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

// A fall fails too, until the ceiling is lowered, as in the other guards: a
// ceiling is a house-wide total, so slack left by a fall in one file would
// absorb a later rise in another.
if (slack.length > 0) {
  console.error('\nFAIL: a count fell below its ceiling. Progress made: lower these ceilings in scripts/json-edges.mjs to the new count:');
  for (const [key, label] of slack) {
    console.error(`  ${label}: ${CEILINGS[key]} -> ${totals[key]}`);
  }
  process.exit(1);
}
console.log('\nOK: every count sits exactly at its ceiling.');
