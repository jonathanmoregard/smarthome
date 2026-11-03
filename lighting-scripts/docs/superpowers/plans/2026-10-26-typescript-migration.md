# TypeScript Lighting Migration Implementation Plan

**Goal:** Preserve lighting behavior while moving program code from runtime Jinja to versioned TypeScript with immediate edit/test/reload.

**Architecture:** A pure script-dispatch layer accepts typed JSON state, registry/topology, clock and input. A stable runtime owns connection, persistence, subscriptions and output. Original Python tests drive either original HA/Jinja or the TypeScript dispatcher through a JSON-lines adapter; assertions remain unchanged.

**Tech Stack:** Node22+, strict TypeScript, Python existing reference tests, Home Assistant2026.7.4 reference engine; Digital Alchemy integration evaluated against restart requirements.

**Spec:** User requirements and accepted migration approach recorded in tasks/session-constraints.md and tasks/mission.md.

## Tasks

1. Freeze live reference and preserve tests. Parent owns reference/live, manifest, package/runtime contracts. Capture hashes without printing script bodies; inspect dependencies and record incomplete snapshots.
2. Test adapter. Worker owns tests/parity and reference portability adapters. Preserve original test sources. Establish reference gate, connect the same test API to JSON-lines TypeScript runner, and record every unsupported entry point rather than silently falling back.
3. Pure logic. Worker owns src/domain/resolution.ts, gradient.ts and related pure resolver modules. Read exported source and existing assertions, run failing parity first, then implement exact behavior.
4. Gestures and grouping. Worker owns src/domain/gestures.ts and grouping.ts, with adapter-driven native HA test cases. Preserve power/chord/cursor, group membership safety and lamp ownership.
5. Parent implements runtime/dispatch, schedule/override/planning and output, integrates workers, then verifies reload, recovery and no duplicate output. No physical lighting tests.
6. Run settled integrated gate and fresh-context review; correct material findings. Complete authorized Git/GitHub delivery when available.

## Review focus

1. Restart during pending gestures/effects must not double-send or erase room intent.
2. Missing/unavailable entities and nonfinite numeric inputs must not generate invalid light commands.
3. Timezone/DST and the wake window must match the reference.
4. Group emission must require current exact acknowledged membership and preserve per-lamp settings.
5. Test adapters must fail unsupported operations and never call the reference as a hidden TypeScript fallback.
