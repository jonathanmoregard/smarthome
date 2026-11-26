# Parsed State Store and Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the named state-store and automation handlers to evidence-derived parsed script arguments without changing the measured Home Assistant/Jinja behavior.

**Architecture:** Register each named handler through `withParsedArgs`, parse once at the untrusted script boundary, and pass typed argument objects to the existing logic. Use memoized `lazy()` parsing wherever the captured control flow can skip a field, and retain optional empty defaults for missing values that Jinja only tests, iterates, or measures.

**Tech Stack:** TypeScript, Node test runner, pinned Home Assistant 2026.7.4 / Jinja 3.1.6 parity gate.

**Spec:** `docs/jinja-coercion-table.md` plus the 2026-11-02 task brief.

## Global Constraints

1. Work only inside `lighting-scripts/`; do not modify `tests/parity/**` or anything under `reference/`.
2. Choose every primitive from captured use and record counts; do not infer from TypeScript taste.
3. Convert only the explicitly named `state-store.ts` handlers; audit but do not convert `ls_store`.
4. Keep the three-handler `remote(kind)` factory in `automations.ts` and parameterize its parser by kind.
5. After each source file, require silent `npm run check`, at least 105 passing runtime tests, and parity status `selected_scope_compatible` with exactly 224 clean assertions, 37 baseline defects, 22 gated modules, 8/8 supplements, and incomplete legacy coverage.
6. Commit each source file as soon as its full verifier trio is green; Git mutations use the structured broker.

## Review Focus

1. Missing iterated or length-only fields retain Jinja's empty behavior rather than becoming required.
2. Case-2 nested fields remain lazy when an earlier empty iterable or branch prevents access.
3. Bare truthiness uses `jinjaTruthy`, including strings such as `off` and `TRUE`.
4. `or` fallbacks use Jinja truthiness, while `default(...)` preserves explicit null/falsy values.
5. String and case filters use Jinja spelling and casing rather than JavaScript coercion.

---

### Task 1: Parse the named state-store handlers

**Files:**

1. Modify: `src/domain/state-store.ts`
2. Test: existing runtime suite and parity gate; add a focused runtime regression only for a captured helper mismatch that fails before implementation.

**Interfaces:**

1. Consumes: `withParsedArgs`, `jinja*`, `require*`, and captured-source evidence.
2. Produces: typed arguments for `ls_commit`, `ls_override_block`, `ls_clear_overrides`, and `ls_sara_mode`; `ls_store` remains unchanged.

- [x] **Step 1:** Gather per-field counts and classify every raw use as strict access versus truthiness/iteration/length.
- [x] **Step 2:** If captured evidence proves an existing helper divergence in a named handler, add and run the focused regression test to observe the expected failure.
- [x] **Step 3:** Implement the four parsed handlers, preserving captured control-flow laziness and documenting evidence in comments.
- [x] **Step 4:** Run the focused test if added, then `npm run check`, `npm test`, and `npm run parity`; compare the structured parity summary to the exact baseline.
- [x] **Step 5:** Stage only the intended state-store change and any focused runtime test, verify forbidden paths are absent, and commit with all field counts.

### Task 2: Parse automation handlers

**Files:**

1. Modify: `src/domain/automations.ts`
2. Test: existing runtime suite and parity gate; add focused runtime regressions only for newly proven behavior changes.

**Interfaces:**

1. Consumes: the same runtime parsing primitives and evidence convention established by Task 1.
2. Produces: parsed automation handlers, including a `remote(kind)` parser parameterized without conflating sibling field semantics.

- [x] **Step 1:** Gather per-field counts and classify every raw use as strict access versus truthiness/iteration/length.
- [x] **Step 2:** Add and observe any evidence-backed focused red regression before fixing an existing behavior bug.
- [x] **Step 3:** Implement parsed argument types and `withParsedArgs` registrations, retaining the shared remote factory and control-flow laziness.
- [x] **Step 4:** Run focused tests if added, then `npm run check`, `npm test`, and `npm run parity`; compare the structured parity summary to the exact baseline.
- [x] **Step 5:** Stage only the intended automation change and focused runtime tests, verify forbidden paths are absent, and commit with all field counts.

### Task 3: Whole-branch review

**Files:**

1. Review: all changes since the branch base; no planned production edits.

**Interfaces:**

1. Consumes: both green commits, their evidence comments, and verifier outputs.
2. Produces: a fresh read-only review verdict and any evidence-backed fix pass.

- [x] **Step 1:** Build a review package and dispatch one fresh read-only reviewer.
- [x] **Step 2:** Re-grade findings against the task brief; address Critical/Important findings with RED-to-GREEN tests in one fix pass.
- [x] **Step 3:** Run final verification and report exact counts, deliberate omissions, helper divergences, rulings, and deferred minors.
