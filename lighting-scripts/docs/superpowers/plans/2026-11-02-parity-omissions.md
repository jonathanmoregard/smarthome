# Legacy Parity Omissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the twelve requested preserved legacy modules into the current-source comparison gate without changing preserved evidence, masking backend differences, or permitting reference fallback.

**Architecture:** Keep the preserved test modules and assertions unchanged. Extend the isolated staging and Python-to-TypeScript host adapters only where an old filesystem or simulator API must be translated, while all lighting decisions continue through the production TypeScript handler registry. Represent import-time assertions as one deterministic synthetic unittest outcome and use explicit, validated literal dependencies for preserved fixture stubs.

**Tech Stack:** Python 3.14 unittest parity runner, Home Assistant 2026.7.4/Jinja2 3.1.6 reference closure, Node 22 JSON-lines bridge, strict TypeScript domain handlers.

**Spec:** `tests/parity/README.md`

## Global Constraints

1. Never modify files under `reference/legacy`, preserved scenarios, or preserved assertions; staged copies may only receive absolute path substitutions and execution-seam replacement.
2. TypeScript requests must fail explicitly when unsupported and must never fall back to Python/Jinja execution.
3. Exact test counts, failure/error identities and messages, skips, and exit status must agree; infrastructure crashes and unexercised adapters are not parity.
4. Historical setup replay is permitted only for the two declared frozen-prefix input-review fixtures and ends at the original upgrade call.
5. Current Candle restriction differences remain original-assertion baseline defects; deployed behavior and retained expectations are not changed.
6. Keep the eight explicit exclusions omitted with their existing accurate reasons.
7. Do not run a live Home Assistant path or physical lighting command, install packages, or expose/commit ignored household captures and reports.
8. Work only in `/home/jonathan/worktrees/smarthome-ts-parity` on `ts-port/parity-gates`; every Git mutation uses `mcp__git_broker__git`.

## Review Focus

1. A TypeScript module must make at least one real RPC request before matching setup failures can count as exercised parity.
2. Live-source selection must redirect only the preserved absolute candidate path; historical mode must retain the historical candidate.
3. Literal fixture dependencies must be validated as return-only data and consumed by TypeScript, never evaluated as reference decision code.
4. Simulator callback and scheduling adapters may translate transport/state only; planning, release, rendering, and condition behavior remains TypeScript.
5. Gate completeness must derive from the actual inventory selection so future omissions cannot coexist with `complete_legacy_coverage: true`.

---

### Task 1: Live source selection and input-review provenance

**Files:**

- Modify: `tests/parity/portability.py`
- Modify: `tests/parity/run.py`
- Test: preserved `lighting-algebra/input-processors/tests/test_input_review.py`

**Interfaces:**

- Produces: an isolated `Stage.rewrite_path(source: Path, target: Path)` path-only substitution recorded in stage metadata.
- Consumes: the normalized directory returned by `live_candidate(stage.path)`.

- [ ] **Step 1: Verify the focused live comparison is red for the Candle migration test**

Run: `/nix/store/gxzhl7aaiid7zp3y47jqqiq7zg5mqpwp-python3-3.14.6/bin/python3.14 tests/parity/run.py --backend compare --source live --suite input-review --test migrated_candle`

Expected: comparison exit 1 because reference passes while TypeScript reports the retained Candle assertion failure.

- [ ] **Step 2: Implement the exact absolute candidate-path rewrite for live source**

Add `Stage.rewrite_path(source: Path, target: Path) -> None` and invoke it before module load only for the known preserved two-version upgrade candidate path when `--source live`. Fail closed if the source spelling or target normalized candidate is absent. Leave historical source untouched.

- [ ] **Step 3: Verify live and historical provenance separately**

Run the focused command from Step 1, then the same command with `--source historical`.

Expected: live reference and TypeScript have the same retained Candle failure; historical reference retains the original passing behavior while TypeScript remains current and comparison stays intentionally red.

- [ ] **Step 4: Verify the full input-review module**

Run: `/nix/store/gxzhl7aaiid7zp3y47jqqiq7zg5mqpwp-python3-3.14.6/bin/python3.14 tests/parity/run.py --backend compare --suite input-review`

Expected: five tests on each backend, exact matching outcomes, and nonzero TypeScript request/frozen-prefix counts.

### Task 2: Current automation aliases and gesture host translation

**Files:**

- Modify: `tests/parity/portability.py`
- Modify: `tests/parity/adapters.py`
- Modify: `tests/parity/run.py`
- Test: the nine requested remote/gesture modules

**Interfaces:**

- Consumes: normalized live script/automation captures and the production `automation.remote_center`, `automation.remote_directions`, and `automation.remote_preset` handlers.
- Produces: explicit historical-role aliases, validated room/role dispatch, supported class-level service observation, and module-specific raw-event replay without legacy sequence interpretation.

- [ ] **Step 1: Preserve the recorded red results for all nine modules**

Run each exact module through `tests/parity/run.py --backend compare --suite <path>`.

Expected: missing live filenames/automation aliases, unsupported historical automation names, or guarded legacy sequence execution; the pending-input module already has exact matching baseline failures.

- [ ] **Step 2: Stage only explicit current capture aliases**

Create a single explicit role/room alias map shared by `live_candidate` and `simulator`. Validate every mapped current capture exists and has the expected automation shape before materializing staged historical filenames.

- [ ] **Step 3: Translate historical automation calls to typed handlers**

Extend `simulator` with exact aliases for the preserved center/directions/preset names and a dedicated validated preset translation. Add only the preserved class-level pre-service observer shape required to collect typed command/timer emissions.

- [ ] **Step 4: Replace the old raw sequence driver at the module boundary**

Install a module-specific replay adapter for `lighting-algebra/remote/test_remote.py` that feeds the original event stream into typed automation handlers, advances emitted scheduled continuations, and returns observations to the unchanged assertions. Keep the generic `DrySim.seq` guard fail-closed.

- [ ] **Step 5: Verify all nine modules individually**

Run each exact module through compare again.

Expected: exact outcome agreement and real TypeScript requests for every module; retained failures remain defects rather than converted passes.

### Task 3: Module-level assertions and literal dependency injection

**Files:**

- Modify: `tests/parity/inventory.json`
- Modify: `tests/parity/run.py`
- Modify: `tests/parity/adapters.py`
- Modify: `tests/parity/rpc.py`
- Modify: `tests/parity/bridge.ts`
- Modify: `tests/parity/test_bridge.py`
- Test: preserved `lighting-algebra/adapters/test_adapters.py`

**Interfaces:**

- Produces: a `module-assertions` seam that runs one unchanged import as one synthetic unittest outcome.
- Produces: `Rpc.call(..., literal_dependencies: dict[str, JsonValue])` consumed only by the test bridge as TypeScript handler return values.

- [ ] **Step 1: Write and run a failing bridge test for literal dependency consumption**

Name the break: ignoring an explicit literal dependency makes the real TypeScript caller execute its production dependency and return the wrong observable result.

Run: `/nix/store/gxzhl7aaiid7zp3y47jqqiq7zg5mqpwp-python3-3.14.6/bin/python3.14 -W error::ResourceWarning -m unittest tests.parity.test_bridge`

Expected: the new test fails because the bridge/RPC does not yet accept the literal dependency.

- [ ] **Step 2: Implement minimal literal dependency transport**

Add the optional RPC field and bridge-side handler overlay. Accept JSON data only, clone returned values, keep the production registry for every other handler, and report the dependency call in TypeScript execution metadata.

- [ ] **Step 3: Implement the synthetic import outcome**

Load `module-assertions` modules only inside a stable synthetic `FunctionTestCase`/`TestCase` after TypeScript adapters are installed. Execute the unchanged module exactly once; report one test, not the number of top-level assertions.

- [ ] **Step 4: Validate and inject the preserved `ls_apply` literal fixture**

Require the replacement config to be a literal return-only fixture with the expected hash/source shape, then supply its result as an explicit TypeScript dependency. Never render or execute its legacy sequence.

- [ ] **Step 5: Verify red-to-green**

Run the bridge test and the exact adapters module compare command.

Expected: bridge test passes; both backends report one synthetic import test with exact agreement and TypeScript RPC activity.

### Task 4: Standalone simulator and typed release compatibility

**Files:**

- Modify: `tests/parity/inventory.json`
- Modify: `tests/parity/run.py`
- Modify: `tests/parity/adapters.py`
- Modify: `src/domain/transport.ts`
- Modify: `tests/runtime/transport.test.ts` or the nearest existing transport test file
- Test: preserved `effects-promotion/tests/test_logic.py`

**Interfaces:**

- Produces: `standalone_simulator(stage: Path, rpc: Rpc) -> module` that patches the exact preserved `harness.Sim` symbol before test import.
- Produces: a typed `effects_release` compatibility handler that filters the existing assignment set and delegates to typed assignment application.

- [ ] **Step 1: Write and run a failing TypeScript release test**

Name the break: releasing selected targets leaves their assignments active or fails to delegate the remaining assignments.

Run: `node --experimental-strip-types --test --experimental-test-isolation=none <focused transport test>`

Expected: failure because `effects_release` is not registered.

- [ ] **Step 2: Implement the minimal typed release handler**

Add `releaseEffects(ctx: ScriptContext, args: JsonObject): JsonValue` beside the assignment engine and register `effects_release`. Preserve current runtime state and service ordering; do not execute captured Jinja.

- [ ] **Step 3: Install the exact standalone simulator adapter**

Reuse literal constructor/catalog setup and state mutators, but route every `run`, `plan`, and `reconcile` decision through RPC. Translate old state field names structurally where required. Fail closed for legacy `seq`, `render`, and `cond`; keep event/service/scheduling code limited to typed outputs and host bookkeeping.

- [ ] **Step 4: Verify the standalone suite**

Run: `/nix/store/gxzhl7aaiid7zp3y47jqqiq7zg5mqpwp-python3-3.14.6/bin/python3.14 tests/parity/run.py --backend compare --suite effects-promotion/tests/test_logic.py`

Expected: 26 exact matching test outcomes, real TypeScript requests, and no legacy interpreter fallback.

### Task 5: Curated gate, documentation, and complete coverage report

**Files:**

- Modify: `tests/parity/gate.py`
- Modify: `tests/parity/README.md`
- Modify: `docs/migration-status.md`
- Test: `tests/parity/gate.py`

**Interfaces:**

- Consumes: all twelve compatible exact module paths.
- Produces: omission reasons only for the eight explicit exclusions and `complete_legacy_coverage` derived from zero required active omissions.

- [ ] **Step 1: Add the twelve modules to `SUITES` and remove stale omission overrides**

Keep the eight excluded modules and their reasons unchanged. Compute completeness from the resulting omissions rather than hard-coding `False`; explicit exclusions do not block the requested legacy-coverage claim.

- [ ] **Step 2: Update human-readable coverage status**

Document the module-import, frozen-prefix/live-path, current-automation alias, and standalone simulator seams without publishing ignored fixture content.

- [ ] **Step 3: Run focused parity for the twelve modules together**

Expected: exact backend agreement for all twelve; baseline failures remain separately counted.

- [ ] **Step 4: Run final required verification**

Run: `npm run parity`

Run: `npm run check`

Run: `npm test`

Expected: all exit 0; gate report contains the new summary and only eight explicit omissions; TypeScript runtime tests remain 65/65 or increase only by the added release test.

- [ ] **Step 5: Verify repository hygiene and commit**

Use Git broker status/diff/add/commit only. Confirm no `reference/`, `.runtime/`, `migration-fixtures.json`, or `*report.json` path is staged. Commit on `ts-port/parity-gates` with a parity-focused message.
