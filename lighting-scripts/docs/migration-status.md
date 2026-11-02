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
   Eighteen command-script shims preserve dashboard entrypoints. They remain
   command-only and suppress dry-run calls; query and validation clients use the
   local RPC. The 2026-11-02 response-consumer audit found no external response
   consumer among those entrypoints, so cutover does not require a correlated HA
   response bridge or response-client migration. The wake blueprint and
   infrastructure Zigbee recovery remain in HA; the latter still reads the literal
   HA catalog, which must stay aligned with runtime topology.
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

### HA response-consumer audit

Captured evidence dated 2026-11-02 establishes that none of the 18 generated
command-script shims has a response consumer outside TypeScript. This is a scoped
cutover finding, not a claim that an unknown future HA caller could consume a reply
from the command-only event shims.

| # | Shimmed entrypoint | Captured caller evidence | External response consumer |
|---:|---|---|---|
| 1 | `effects_candle_sync` | TypeScript-owned candle automation only | None |
| 2 | `effects_set` | TypeScript-owned native-control automation only | None |
| 3 | `effects_ui_catalog` | Called only by TypeScript-owned `effects_ui_sync` | None |
| 4 | `effects_ui_sync` | TypeScript-owned automation callers only | None |
| 5 | `ls_apply` | Retained recovery calls it without `response_variable`; both response-bearing callers are TypeScript-owned | None |
| 6 | `ls_clear_overrides` | Captured dashboard actions do not request or consume a response | None |
| 7 | `ls_override_block` | Captured dashboard actions do not request or consume a response | None |
| 8 | `ls_range_save` | Generated dashboard candidate reference does not request or consume a response | None |
| 9 | `ls_remote_command` | TypeScript-owned gesture wrappers only | None |
| 10 | `ls_remote_gesture_bedroom` | TypeScript-owned trigger automations and quiet-power helper only | None |
| 11 | `ls_remote_gesture_kitchen` | TypeScript-owned trigger automations and quiet-power helper only | None |
| 12 | `ls_remote_gesture_living_room` | TypeScript-owned trigger automations and quiet-power helper only | None |
| 13 | `ls_remote_power_quiet_bedroom` | TypeScript-owned gesture wrapper only | None |
| 14 | `ls_remote_power_quiet_kitchen` | TypeScript-owned gesture wrapper only | None |
| 15 | `ls_remote_power_quiet_living_room` | TypeScript-owned gesture wrapper only | None |
| 16 | `ls_render` | TypeScript-owned automation and `ls_commit`, both asynchronous | None |
| 17 | `ls_sara_mode` | No captured action caller | None |
| 18 | `ls_store` | Called only by TypeScript-owned `effects_set` | None |

Five shimmed originals return a response: `effects_set`, `effects_ui_sync`,
`ls_apply`, `ls_range_save` and `ls_remote_command`. Only `ls_apply` has captured
response-bearing callers. Both now execute wholly inside TypeScript:

1. `lighting_schedule_lamp_change_detector` calls it directly in
   [`src/domain/automations.ts`](../src/domain/automations.ts).
2. `ls_override_block` calls it directly in
   [`src/domain/state-store.ts`](../src/domain/state-store.ts).

Reproduce the audit with `npm run audit:responses`. The check derives the shim set
from `scripts/export-bridge.py` and the captured remote wrappers, structurally scans
the current script and automation captures plus the captured dashboard snapshots,
and fails if it finds a response-bearing shim call beyond those two reviewed
TypeScript-owned consumers, if the documented 18-entrypoint inventory changes, or
if an unreviewed templated response action cannot be resolved structurally. The one
reviewed dynamic effect-renderer call is internal, cannot select a shimmed
entrypoint, and is bound to the audited template fingerprint so a template change
also fails. Captures are intentionally ignored, so this command is capture-only
and fails when its evidence is unavailable; ordinary public-clone checks remain
capture-independent.

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
   are reviewable local artifacts. The response-consumer audit removes the earlier
   response-client migration concern, but does not authorize cutover. Finish the
   integrated gates and review before changing live output ownership; use a
   supervised daytime check.

GitHub history is intended to record the tested program at useful checkpoints.
It is not involved in the development reload path.
