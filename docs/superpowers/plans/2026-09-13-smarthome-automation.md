# Smarthome Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested Rust automation daemon, Nix package/module, CI, and operations guide for normalized MQTT-based home automation.

**Architecture:** Pure behavior lives in `house-automation-core`; I/O lives in `house-automationd`. Every clock and transport boundary is injected. Nix builds both and exports a hardened NixOS module.

**Tech Stack:** Rust 2024, Tokio, rumqttc, rusqlite, serde/TOML/JSON, tracing, axum, Nix flakes.

---

## File map

- `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`: workspace/toolchain lock.
- `house-automation-core/src/{value,curve,state,overlay,input,reconcile}.rs`: pure domain behavior.
- `house-automationd/src/{config,persistence,zigbee2mqtt,mqtt,scheduler,health}.rs`: runtime adapters.
- `house-automationd/src/main.rs`: startup and task orchestration only.
- `nix/module.nix`: `services.houseAutomation` options and hardened unit.
- `nix/package.nix`, `flake.nix`: reproducible package, dev shell, checks, module export.
- `examples/house.toml`: anonymous example topology.
- `.github/workflows/ci.yml`: one `nix flake check -L` gate.
- `README.md`: architecture, configuration, operations, backup, TellStick boundary.

### Task 1: Scaffold reproducible workspace

- [ ] Add workspace manifests, pinned stable Rust toolchain, `.gitignore`, and minimal library/binary entry points.
- [ ] Run `cargo metadata --no-deps --format-version 1`; expect both crates and no warnings. Current Cargo versions warn when format version is omitted.
- [ ] Add `flake.nix`/`nix/package.nix` using pinned nixpkgs and `rustPlatform.buildRustPackage` with `Cargo.lock`.
- [ ] Run `nix flake show`; expect package, module, dev shell, and check attributes to evaluate.
- [ ] Commit `chore: scaffold Rust and Nix workspace`.

### Task 2: Normalized values and capabilities

- [ ] RED: tests reject NaN/out-of-range brightness, clamp offsets, clamp Kelvin to device limits, and omit unsupported CCT/color fields.
- [ ] Run `cargo test -p house-automation-core value`; expect failures because value types do not exist.
- [ ] GREEN: implement validated `Brightness`, `Kelvin`, `Color`, `LightTarget`, and `Capabilities` types with capability-aware target degradation.
- [ ] Run targeted tests, then `cargo test -p house-automation-core`; expect pass.
- [ ] Commit `feat(core): add normalized light values and capabilities`.

### Task 3: Circadian curve

- [ ] RED: tests cover exact anchors, between-anchor interpolation, midnight wrap, monotonic no-overshoot, malformed anchors, and brightness/CCT bounds between neighboring anchors. Apply device-specific limits only after offsets and overlays compose.
- [ ] Run `cargo test -p house-automation-core curve`; verify expected missing-API failures.
- [ ] GREEN: implement cyclic fixed-time anchors and monotone cubic interpolation with linear fallback for two points.
- [ ] Refactor shared interpolation without changing behavior; rerun core tests.
- [ ] Commit `feat(core): add bounded circadian curves`.

### Task 4: Scope state, freeze, convergence, offsets, and 04:00 reset

- [ ] RED: use fake wall/monotonic clocks to cover freeze capture, time-invariant frozen baseline, offsets while frozen, smooth unfreeze, full convergence, and reset of every scope at/after 04:00.
- [ ] Include missed-reset startup tests before and after 04:00. A due reset atomically moves every frozen control into smooth convergence; `Converging` is already unfrozen and becomes `Follow` when convergence completes.
- [ ] Run `cargo test -p house-automation-core state`; verify expected failures.
- [ ] GREEN: implement `ScopeId`, room/floor/house membership, `CurveMode`, convergence, `ScopeState`, composed target, and atomic daily reset transition.
- [ ] Run all core tests; expect pass.
- [ ] Commit `feat(core): compose circadian scope state`.

### Task 5: Temporary overlays

- [ ] RED: tests cover expiry recomputing current underlying target, same-key replacement, different-key nesting order, cancellation, CCT/color overlays, non-persistence, and a visible clamp-aware freeze/unfreeze acknowledgement pulse for dimmable targets without flashing on/off-only targets.
- [ ] Run targeted tests and verify missing overlay behavior fails.
- [ ] GREEN: implement keyed overlays ordered by priority then insertion sequence, with expiry filtering during composition.
- [ ] Run all core tests; expect pass.
- [ ] Commit `feat(core): add deterministic temporary overlays`.

### Task 6: Declarative remote classification

- [ ] RED: tests cover delayed single click, double click before and exactly at deadline, timeout, third click, long press/release isolation, declarative scope/action mapping, and acknowledgement-overlay requests after successful freeze/unfreeze actions.
- [ ] Run `cargo test -p house-automation-core input`; verify expected failures without real sleeps.
- [ ] GREEN: implement per-remote click state using injected monotonic timestamps plus `ingest` and `flush_due` APIs.
- [ ] Run all core tests; expect pass.
- [ ] Commit `feat(core): classify remote gestures`.

### Task 7: Desired/observed reconciliation and Zigbee2MQTT translation

- [ ] RED: tests cover unavailable suppression, recovery reconcile, MQTT reconnect resubscribe/forced reconcile, duplicate observed reports, group-first/per-device fallback, non-retained event/command publications, and capability degradation.
- [ ] RED: fixture tests parse representative IKEA E1810 actions and LED2111G6/Hue state/availability JSON without vendor behavior in core.
- [ ] Run targeted tests; verify failures are missing behavior, not malformed fixtures.
- [ ] GREEN: implement deterministic reconciliation actions and Zigbee2MQTT topic/payload translation. Convert normalized brightness to 0–254 and Kelvin to bounded mireds only in adapter.
- [ ] Run workspace tests; expect pass.
- [ ] Commit `feat(mqtt): reconcile Zigbee desired state`.

### Task 8: SQLite migrations and restoration

- [ ] RED: temporary-database tests cover migration from empty DB, idempotent reopen, offsets/frozen baseline/scope/power/reset-date round trip, transaction rollback, and exclusion of overlays/connection state.
- [ ] Run `cargo test -p house-automationd persistence`; verify schema/API failures.
- [ ] GREEN: implement numbered transactional migration table, JSON-versioned scope rows, metadata rows, and SQLite online-backup subcommand.
- [ ] Run daemon and workspace tests; expect pass.
- [ ] Commit `feat(state): persist deliberate automation state`.

### Task 9: Static configuration and validation

- [ ] RED: tests load `examples/house.toml`, then reject duplicate IDs, dangling room/floor/device/scope refs, unstable MQTT namespace, invalid time windows, empty curves, unsupported remote actions, invalid acknowledgement settings, and public health bind without explicit opt-in.
- [ ] Run targeted tests; verify expected validation failures.
- [ ] GREEN: implement serde config types, reference validation, defaults (`house/v1`, 350 ms click window, 04:00 reset, configurable convergence), and redacted debug output.
- [ ] Run `cargo test --workspace`; expect pass.
- [ ] Commit `feat(config): validate declarative house topology`.

### Task 10: Async daemon, health, and scheduling

- [ ] RED: integration tests use in-memory transport boundary and paused Tokio time to cover startup migration-before-connect, delayed click dispatch, visible freeze/unfreeze acknowledgement overlays, sparse curve ticks, whole-hour 500 ms overlay, graceful shutdown, reconnect, and health readiness transitions.
- [ ] Run daemon integration tests; verify expected failures.
- [ ] GREEN: implement MQTT event loop with retained online/offline availability only, scheduler, SQLite writer, signal handling, and loopback axum `/healthz` JSON.
- [ ] Add structured tracing fields and payload redaction tests.
- [ ] Run `cargo test --workspace`; expect pass.
- [ ] Commit `feat(daemon): run MQTT automation service`.

### Task 11: NixOS service module and flake gates

- [ ] RED: add Nix evaluation/runtime test asserting generated TOML, dedicated user, `StateDirectory=house-automation`, restart policy, loopback health, `NoNewPrivileges`, strict protection, empty capabilities, and real `/healthz` response.
- [ ] Run new Nix check; verify failure before module exists.
- [ ] GREEN: implement `services.houseAutomation.{enable,package,settings,environmentFile}` with `pkgs.formats.toml` and hardened systemd unit.
- [ ] Expose checks for fmt, Clippy `-D warnings`, tests, package build, and module VM/runtime.
- [ ] Run `nix flake check -L`; expect all checks pass.
- [ ] Commit `feat(nix): package and harden automation daemon`.

### Task 12: Documentation and CI

- [ ] Write README sections from design: diagram, topics/retention, configuration, pairing, device capabilities, freeze/reset, overlays, state, logs, health, TellStick discovery boundary, backup/export, and debugging.
- [ ] Add pinned GitHub Actions workflow running `nix flake check -L`; keep token permissions read-only.
- [ ] Run `git diff --check`, `cargo fmt --check`, Clippy, tests, build, and `nix flake check -L`.
- [ ] Commit `docs: add smarthome operations guide and CI`.
