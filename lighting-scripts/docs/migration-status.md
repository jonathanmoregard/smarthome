# Migration status

The implementation is in the `smarthome` repository under `lighting-scripts/`.
Live Home Assistant configuration has not been modified. This document
distinguishes the implemented program from deployment and repository delivery.

## Scope and design

1. 41 of 45 captured scripts have TypeScript implementations, including the room
   gesture wrappers, planners, channel resolution, UI actions, fair effect engine,
   guarded dispatch and asynchronous Candle membership synchronization.
2. `house_apply_mode` and `house_sunrise` are legacy: their three captured consumer
   automations have been disabled since 2026-10-14. Current state evidence is
   `reference/live/automation-states.json`.
3. `effects_route` and `effects_release` have no consumers in the captured scripts
   or automations and use obsolete assignment/controller schemas. They are not
   part of the active port. This is a scoped consumer check, not proof about every
   external HA caller.
4. Twenty-one automation action adapters are typed. Their generated trigger bridges
   retain the current HA conditions/variables and replace actions with one event.
   Eighteen command-script shims preserve dashboard entrypoints. Their event
   protocol has no HA script response support; dry-run calls are suppressed, and
   response clients must migrate to the local RPC before cutover. The wake blueprint
   and infrastructure Zigbee recovery remain in HA; the latter still reads the
   literal HA catalog, which must stay aligned with runtime topology.
5. Program edits compile and reload without Git operations or PRs. Runtime helper
   settings, registries, logical device mappings and remote identities remain data.
   Failed compilation keeps the last working domain loaded.

TypeScript was selected over Rust because it provides the requested typed edit/test
loop without adding a native build/deployment boundary. Prior research considered
Digital Alchemy; this implementation uses the official HA WebSocket library and a
small explicit execution boundary. Digital Alchemy dependencies could not be
resolved in this session. The fallback keeps domain tests independent of either
integration framework.

## Evidence

Original assertions live unchanged under `reference/legacy`. Captured current
script and automation exports are under `reference/live`; hashes/provenance are
recorded by the parity runner. `tests/parity/gate-report.json` is the current
machine-readable result, with separate counts for passing original tests, defects
that reproduce in current Jinja, and omitted historical suites. Equivalent red
tests are not counted as passing assertions. Native differential checks compare
public outputs as well as original assertions.

The parity reference intentionally uses current deployed source: some old suites
target older semantics. For example, current Candle resolution restricts activation
to the designated logical lamp; older tests assumed arbitrary lamps. The native HA
comparison records this difference without restoring obsolete behavior or changing
the old expectation.

## Delivery blockers

1. Code and the test harness use the existing public `smarthome` repository.
   Household captures, the original private reference archive, frozen replay state
   and detailed reports are intentionally local and ignored by Git. Restoring that
   private archive is required to rerun the original-test parity gate in a fresh
   checkout. Ordinary runtime tests do not require it.
2. A clean package install and lockfile are unverified. Registry resolution failed;
   offline installation lacks cached metadata. The local checks use TypeScript5.9.3,
   Node type definitions22.19.17 and an unmodified build of official
   `home-assistant-js-websocket`9.7.1 at commit
   `1a2349c49951e4fc9090e2c8049189157cc21f8b`.
3. No HA cutover or physical lighting test has been performed. Generated bridges
   are reviewable local artifacts. Finish the integrated gates and review before
   changing live output ownership; use a supervised daytime check.

GitHub history is intended to record the tested program at useful checkpoints.
It is not involved in the development reload path.
