# smarthome-scripts

TypeScript replacement for the Home Assistant lighting scripts. The domain runs
without Home Assistant or Jinja. The live adapter uses Home Assistant's official
[`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket)
client; Home Assistant continues to own resident settings, registries and triggers.

This is a staged migration in the `smarthome` repository's `lighting-scripts/`
directory. No live scripts, automations or lamps have been changed. See
`docs/migration-status.md` for remaining deployment and installation checks.

## Development

Requires Linux with `flock`, Node 22.18+ and Python 3. Install the pinned `package.json` dependencies
with `npm install --ignore-scripts` on a machine with registry access. The current
workspace has locally available TypeScript and an unmodified build of the official
HA client. It does not yet have a verified lockfile or clean-install result.

```sh
python3 scripts/bootstrap-runtime.py
npm run dev -- --config .runtime/catalog.json --live-rooms ''
```

`--live-rooms` is required, live or offline: see [Rooms on the port](#rooms-on-the-port).
Bootstrap runs once and refuses to overwrite resident configuration. It has already
been run in this workspace. The development process accepts JSON lines on stdin:

```json
{"script":"effects_catalog","args":{}}
```

Saving TypeScript compiles a candidate and replaces the running domain only after
successful compilation. A failed compile leaves the previous program active. No
commit, PR or CI run is required. Host/connection implementation changes require
restarting the process; ordinary domain scripts reload in place.

1. `npm run check` checks strict TypeScript.
2. `npm test` exercises the runtime and domain without sending real outputs.
3. `npm run parity` runs the curated original-test comparison and native HA
   differential checks. Reports distinguish passing tests, identical baseline
   defects, uncovered execution seams and omitted historical versions.
4. `npm run parity:inventory` lists every preserved test module.
5. `npm run verify` runs all three gates.

The public repository contains the program, runtime tests and parity harness.
The captured household configuration, original private reference archive, frozen
replay state and detailed reports stay local and are ignored by Git. `npm test`
runs without that private archive; parity and bootstrap/export commands require
it. The current workspace retains it under `reference/` and
`tests/parity/migration-fixtures.json`.

`tests/parity/README.md` describes how to run an individual original suite against
the reference, TypeScript, or both. Existing test assertions remain unchanged.
The native HA oracle needs the local HA Python environment described there.

## Runtime configuration

`.runtime/catalog.json` contains logical lamps, physical members, MQTT topics,
verified groups, UI rows and remote identities. The process watches it for atomic
replacement; topology changes do not require a code PR. `catalog.remotes` maps
helper-room names to remote source/device IDs, including delayed POWER completion.
HA entity/device/area/label changes and resident helper settings feed the live
snapshot. A new physical device must still be assigned to the correct logical lamp;
registry membership alone cannot infer that relationship.

`.runtime/state.json` is the durable journal; its adjacent lock enforces one owner
for that journal. Keep runtime data and credentials out of Git. A restart does not
blindly replay outputs whose delivery was uncertain. Physical output is guarded
against stale revisions, generations, topology and ownership. Completed work is
recorded only after the transport acknowledges success.

## Staged cutover

```sh
python3 scripts/export-bridge.py
```

This prepares 21 HA automation configurations and 18 command-script shims in
`.runtime/bridge` (script shims are in its `scripts` subdirectory).
Each retains its triggers and conditions and forwards the trigger data through a
small `smarthome_script` event. The existing generated files have not been applied.
They replace the corresponding action bodies under the same automation IDs; they
must not run alongside a second copy of those actions.

The script shims cover dashboard commands. They forward only supplied fields,
remain command-only and suppress dry-run requests. A 2026-11-02 audit of all 18
shimmed entrypoints found no caller outside TypeScript that consumes a response, so
no correlated HA response bridge or response-client migration is required for
cutover. Query and validation clients use the local JSON-lines RPC
(`node --experimental-strip-types src/rpc.ts`, with `{script,args,snapshot}`). Run
`npm run audit:responses` with the local captures to recheck that boundary. The
retained infrastructure recovery automation still reads the literal HA
`effects_catalog`, so keep that catalog aligned with runtime topology until that
consumer is migrated too.

The three disabled legacy `house_*` automations remain disabled. The wake blueprint
continues writing the wake helper. Zigbee infrastructure failure recovery remains
in Home Assistant. Dormant `effects_route` and `effects_release` have no consumers
in the captured scripts/automations and use obsolete schemas; they are retained as
reference, not silently invoked by TypeScript.

Cutover checklist:

1. Mark every bulb flashed with the candle firmware in `.runtime/catalog.json`.
   Candle capability is decided to come from the bulb's reported firmware version
   (our build carries its own file version), but the code does not read the
   version yet: today it still reads a declared flag under `bulbs`, keyed by the
   bulb's member entity, e.g. `"bulbs": { "light.<bulb>": { "candle": true } }`.
   Until a bulb is marked, its lamp does not run Candle. A lamp runs Candle only
   when it has at least one bulb and every one of its bulbs is marked; a
   malformed flag rejects the file and the previous config is kept. Replace this
   step when the firmware-version check lands.
2. Clear `runtime.applied` once at cutover so every lamp is re-sent (starts the
   firmware candle). Set the `applied` attribute of `sensor.ls_effects_runtime`
   to an empty mapping `{}`: an absent or null `applied` is read as `targets`,
   which the old engine also wrote, so removing it re-sends nothing.

Live connection requires an existing credential file and an explicit command:

```sh
HA_URL=https://YOUR_HOME_ASSISTANT HA_TOKEN_FILE=/path/to/existing/token \
  npm run dev -- --live --config .runtime/catalog.json --live-rooms <room>[,<room>...]
```

Do not run that as a smoke test. Complete the parity/runtime checks, review the
bridge configurations and switch output ownership before a supervised daytime
cutover. Restore the captured original automation actions to roll back. This
repository deliberately does not embed credentials or perform a live cutover on
startup in its default offline mode.

## Rooms on the port

The cutover can go one room at a time while the old scripts keep the rest of the
house. A room is the port's when it is in `--live-rooms` (comma-separated Home
Assistant area ids; `''` is none) and its port switch
`input_boolean.ls_<room>_on_port` is on. The list is what the process may take;
the switch is where a person hands the room over or back. A missing
`--live-rooms` is refused at start-up: it never means every room.

1. The port computes the whole house, and sends lamp, bulb and switch commands
   and room cache writes only for its rooms. A command that reaches any room
   that is not its own is not sent.
2. A remote press, a dashboard control, a lamp switched from the app or a lamp
   switched on in another room does nothing in the port. House-wide inputs (the
   schedule, house modes, recovery) are computed for the whole house and reach
   only the port's rooms.
3. The overlay store stays shared, with one writer per event. The render
   bookkeeping (`sensor.ls_effects_runtime`) is the port's own while any room is
   still on the old scripts: it is read once at start and is then neither sent
   nor read back, so the two systems never overwrite each other's applied
   lights or generation.
4. When a room's switch turns on, and on start, the port re-sends that room's
   lamps, so their bulb effects (the firmware candle) start.

`python3 scripts/export-bridge.py --rollout` prepares the matching Home Assistant
side in `.runtime/bridge-rollout`: one new automation per room-scoped bridge (id
`<id>_port`), acting only for rooms whose switch is on, plus a recovery bridge
that lets the port render what the old scripts commit. House-wide store writers
and the schedule tick stay with the old scripts. The old scripts must, in turn,
skip rooms whose switch is on; that patch is built from the captured originals
and stays out of this repository.
