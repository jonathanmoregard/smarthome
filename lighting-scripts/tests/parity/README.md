# Preserved-test parity harness

The code is versioned in the public `smarthome` repository. The private original
archive in `reference/`, `migration-fixtures.json`, and detailed `*report.json`
outputs stay local and are ignored by Git. Restore that archive before running
this harness in a fresh checkout; ordinary `npm test` runtime tests are independent.

The original files under `reference/legacy` are immutable evidence. This harness
loads isolated copies, changes absolute filesystem paths only, and replaces the
execution seam. It does not rewrite scenarios or assertions. Every run hashes
all preserved files before and after staging. Live export envelopes are unwrapped
into a temporary candidate directory because historical tests expect bare configs.
Captured automations are included under both their slug and stable-id fixture
aliases, so the reference uses the current event writer and recovery conditions.

## Running

Use Python 3.14 and Node 22.18 or later. On the capture host:

```sh
/nix/store/gxzhl7aaiid7zp3y47jqqiq7zg5mqpwp-python3-3.14.6/bin/python3.14 tests/parity/run.py --backend compare --suite gestures --suite core --suite grouping --report tests/parity/comparison-report.json
```

For another machine, install `homeassistant==2026.7.4` and `Jinja2==3.1.6` into a
Python 3.14 virtual environment, then invoke its Python. `portability.py` loads the
exact Nix HA wrapper dependency closure when present; otherwise installed packages
supply dependencies. `HA_WRAPPER` can select another compatible wrapper. No HA
server, connection credentials, MQTT connection, or physical device is used.

1. `--backend reference` executes preserved Jinja/native HA and original assertions.
2. `--backend typescript` executes the TypeScript RPC and original assertions.
3. `--backend compare` executes both independently. A module passes this comparison
   only when test counts, exact failing test identities, exception types/messages,
   skip identities, and exit status agree. An infrastructure crash with no test
   outcome never passes comparison. For pure-template and native-gesture seams,
   every result also gets a direct reference comparison.
4. `--source live` selects captured live source (default). `--source historical`
   selects each original test's historical source; TypeScript remains the actual
   current implementation, so disagreement is expected where behavior changed.
5. `--suite` is repeatable; aliases include `gestures`, `core`, `core-relational`,
   `grouping`, `input`, `input-edges`, `input-review`, and `gradient`. An exact path
   from `--inventory` is also accepted. `--test` filters unittest IDs by substring.
6. With no selection, every one of the 42 inventoried modules runs. Unsupported
   adapters and unported entrypoints fail explicitly. Selected runs list every
   module they did not run; they are not a full-suite claim.

The comparison gate means *equivalent observed behavior including documented
baseline failures*, not that all historical assertions pass. Its structured report
contains both outcomes, original-test hashes and captured-live export hashes.
Pure result comparison allows floating arithmetic differences of at most `1e-9`
absolute / `1e-12` relative; all original exact assertions remain exact.

## Execution boundary

`Rpc` sends JSON lines to the test-only `tests/parity/bridge.ts`, which invokes
the same TypeScript `execute` and handler registry as production `src/rpc.ts`,
and receives result, state, calls and events. No failed or unsupported request falls back to
Python/Jinja. The test bridge carries NaN/Infinity in explicit out-of-band numeric paths and
restores the true JavaScript values before calling the domain. This preserves
original malformed-number assertions; it neither coerces them to null nor adds
a test mode to the production RPC. `PARITY_RPC` can select the production command
for finite JSON-only checks.

The DrySim adapter reuses fixture setup, `put`, `store`, `advance`, state views and
original `pure` assertions. Its only initialization-time catalog read is the
literal fixture object in `effects-promotion/live/effects_catalog.json`, exactly
what the old fixture used. Runtime script execution always crosses RPC. Queued
render calls remain explicitly drainable. Service/script callbacks suspend at the actual TypeScript boundary. The bridge
can execute a nested request while paused, then restore the callback's concurrent
state before resuming. Existing `before_service`, `after_service`, `on_publish`,
`before_emit`, `after_publish`, and validated pre-service wrappers are supported.
Call timestamps come from the actual elapsed clock. The scheduled engine drain
advances due continuations, invokes original `on_delay`, and honors the existing
budget. All 16 original effect-pacing tests pass on both implementations.
Direct sequence interpretation and test-created Jinja scripts remain unsupported;
`run_automation` dispatches only an exact captured slug/id to its typed handler.

The wake suite's explicit independent legacy oracle is allowed to render only the
exact preserved `before/ls_apply.json` plan template. This computes the expected
value; the actual `ls_base` result still comes exclusively from TypeScript.
Native gesture comparison runs the original HA replay and the TypeScript replay
separately and compares the returned command sequence and cursor. Native HA's
service sinks are isolated in-memory fixtures.

## Which old gates are authoritative?

`inventory.json` lists every module and its evidence category. The broadest
preserved integrated gate is `lighting-algebra/remote-ranges/run_gate.py`: it runs
`tests/`, `input-processors/tests/`, `remote-regressions/`, and `remote-ranges/`.
The exact explicit supersessions found in preserved gate source are:

1. `tests/test_remote_fast.py` and `tests/test_remote_store.py`: both
   `input-processors/run_gate.py` and later gates replace old scale-claim behavior
   (up/down stealing effect channels) with input invariants.
2. `GestureIntegrationTests.test_blocked_logical_dispatch_does_not_delay_third_power_or_arrow_capture`:
   `sara-window/run_gate.py` replaces the old 0.4-second assertion with the approved
   0.6-second burst tests and explicitly substitutes `WindowReplay` fixtures.

They remain runnable and visible in this harness; none is silently skipped.
The four automatic-group provisioning modules under `smarthome-remote-20261026`
target an unfinished candidate, not the captured deployed behavior. Their native
reference runs remain available; their TypeScript adapters are explicitly uncovered.

## Observed baseline conflicts

The selected live comparison report records these without modifying expectations:

1. `core`: 23 tests, 7 failures and 4 errors on both backends, with 648 complete
   result comparisons agreeing. All five scale tests pass. The same original core
   suite passes all 23 tests against its historical source.
2. `grouping`: 12 tests, one failure on both backends, with 2,019 complete result
   comparisons agreeing. `test_proposed_groups_preserve_complete_lamps` reads a
   fixture whose `verified` fields are now true, while the original assertion
   requires false. This failure occurs independently of planner execution.
3. `gestures`: all 33 original scenarios pass on native HA and TypeScript;
   all 33 paired replay outcomes agree (144 TypeScript script calls).

All failing core test IDs and exception messages are in `comparison-report.json`.
Native `native_drift.py` proves the source difference rather than inferring it
from a mock: historical `lamp_a` receives Candle, captured-live `lamp_a` becomes a
constant, and captured-live `light.living_room_yellow_retro_lamp` receives Candle.
This proves deployed behavior, not historical user authorization for that change.
The live resolver export SHA256 is
`6947df61c16b49fde9f491a68f6dcd0a670ea0448b048544d23cfcb83979f386`.

Earlier exploratory runs (before the captured automation overlay was complete)
also exposed failures: input-edges 3 tests/2 errors; input
15 tests/3 failures/5 errors; input-review 5 tests/1 failure; core-relational 24
tests/3 failures/1 error. These are not declared superseded. The original core-relational NaN/Infinity cases also run through the test-only
numeric bridge. Full migration verification remains incomplete until every
required active module and unsupported execution seam is covered.

Supplemental native differentials preserve independent oracles and do not replace
old tests:

```sh
python tests/parity/native_drift.py
python tests/parity/native_gradient.py
python tests/parity/native_resolution.py
python tests/parity/native_controls.py
```

The recorded supplements show 7,059 exact scale/compiled-gradient samples across
181 profiles against the frozen native-HA macro, and 240 exact live-native resolver
cases against the integrated TypeScript dispatcher. See the adjacent JSON reports.


## Reproducible selected gate and historical upgrades

`python tests/parity/gate.py` runs the curated current-source set, native
supplements and bridge regression tests. `gate-report.json` counts clean original
assertion tests separately from baseline defects and lists every omitted module
with a reason. A compatible selected gate does not claim complete migration or
count identical reference failures as passing tests. The detailed report retains
structured assertion operands, avoiding false differences caused solely by Python
formatting `225.0` versus `225` or shortening dictionary representations.

Two input-review tests deliberately execute a historical program before upgrading
its source. `capture_migrations.py` freezes that prefix at the original `upgrade`
call, with source hashes and a checked sequence of script inputs/results/state
changes. `migration-fixtures.json` supplies only that declared historical setup;
no TypeScript call falls back to reference execution. After the original upgrade
helper returns, all decision calls cross the typed boundary. The report lists
historical setup requests separately from TypeScript requests. This correctly
preserves the newer-UI-brightness migration case; the historical Candle migration
still conflicts with the current live Candle restriction and remains reported.

The settled gate also reruns the native bridge-field, full automation, schedule,
and UI/range differentials (`native_bridges.py` and the three neighboring
`tests/runtime/*native*.py` scripts). Their reports cover 72 bridge-field cases,
38 automation scenarios, 40 schedule comparisons and 26 UI/range comparisons.
The current authoritative verification artifacts are `gate-report.json` and
`gate-comparison-report.json`. Other comparison JSON files retain exploratory
results from earlier adapter states and are not release-status claims.

The current gate includes 22 preserved modules, including the input processor,
remote-range, dispatch, output-recovery and cache suites. Runtime settings are
copied from the selected literal catalog; only constructor fixture setup uses
the original historical catalog. An observed `ls_override` event is delivered to
the typed commit handler, matching the original simulator's synchronous writer
sink. Cache instrumentation observes actual TypeScript `Math.log` calls; the
observer's Python return value is never used by the implementation.
