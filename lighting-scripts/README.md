# smarthome-scripts

TypeScript replacement for the Home Assistant lighting scripts. The domain runs
without Home Assistant or Jinja. The live adapter uses Home Assistant's official
[`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket)
client; Home Assistant continues to own resident settings, registries and triggers.

This is a staged migration in the `smarthome` repository's `lighting-scripts/`
directory. No live scripts, automations or lamps have been changed. See
`docs/migration-status.md` for remaining deployment and installation checks.

## Layout

Every input goes Home Assistant → `HaInput` → `Msg` → `update` →
`lightingState` → `reconcile` → outputs, in one turn of the adapter.

1. `src/domain/`: the Model, its messages and `update`, the schedule, the
   lighting state and the dashboard view. Pure: it imports only itself and
   never sees Home Assistant's JSON.
2. `src/adapter/`: one turn (`loop.ts`: `handleInput`, `afterOutputs`), the
   reconciler (`reconcile.ts`), the outputs and their Home Assistant calls
   (`encode.ts`) and the websocket client with its wire types (`ha-client.ts`).
3. `src/adapter/codecs/`: every read and write of Home Assistant's JSON: the
   house mirror, the inputs, the config and Model, the helper and store
   writes, the catalog and the journal.
4. The host: `src/host.ts` keeps the Home Assistant mirror and the journal,
   runs turns one at a time, makes each output's call in order and sets one
   timer for the next wake. `src/main.ts` runs it live, over the websocket client
   in `src/adapter/ha-client.ts`; `src/rpc.ts` is the JSON-lines host the e2e
   harness drives.

`npm run check` holds these layers: `scripts/domain-imports.mjs` (the domain
imports only itself, the adapter never the host), `scripts/json-edges.mjs` (no
JSON outside the codecs, `encode.ts` and `ha-client.ts`) and
`scripts/domain-words.mjs`.

## Development

Requires Node 22.18+ and Python 3. Install the pinned `package.json` dependencies
with `npm install --ignore-scripts` on a machine with registry access.

```sh
python3 scripts/bootstrap-runtime.py
HA_URL=https://YOUR_HOME_ASSISTANT HA_TOKEN_FILE=/path/to/existing/token \
  npm run dev -- --live --config .runtime/catalog.json --live-rooms <room>[,<room>...]
```

The host runs live only; the offline JSON-lines mode is `src/rpc.ts`, which the
e2e harness drives. `--live-rooms` is required: see
[Rooms on the port](#rooms-on-the-port). Bootstrap runs once and refuses to
overwrite resident configuration.

`npm run dev` compiles a candidate on every save under `src/` and restarts the
host only after a successful compile; a failed compile leaves the running host
as it was. The journal (`.runtime/journal.json`, or `--state <file>`) keeps
what each bulb was last sent, so a restart sends nothing a bulb already shows.

1. `npm run check` checks strict TypeScript and the layer guards.
2. `npm test` exercises the domain, the adapter and the host without sending
   real outputs.
3. `npm run e2e` replays the recorded golden scenarios against the port and
   compares the flow with the original scripts (`tests/e2e/`).
4. `npm run verify` runs all three gates.

The public repository contains the program, its tests and the e2e harness. The
captured household configuration, the original private reference archive and
the golden recordings stay local and are ignored by Git. `npm test` runs without
them; `npm run e2e` and the bootstrap/export commands need them, under
`reference/` and `.runtime/`.

## Runtime configuration

`.runtime/catalog.json` contains logical lamps, physical members, MQTT topics,
verified groups, UI rows and remote identities. The process watches it for atomic
replacement; topology changes do not require a code PR. `catalog.remotes` maps
helper-room names to remote source/device IDs, including delayed POWER completion.
HA entity/device/area/label changes and resident helper settings feed the live
snapshot. A new physical device must still be assigned to the correct logical lamp;
registry membership alone cannot infer that relationship.

`.runtime/journal.json` is the durable journal: what each bulb and switch was
last sent, saved after each send and written whole, then renamed into place. A
send is recorded only once every call carrying it has gone; a failed call is
retried after its backoff. One host runs per journal: a start takes
`<journal>.lock` (holding its process id), a second start that finds it held
stops with an error naming the owner, and a lock whose process has ended is
taken over. Keep runtime data and credentials out of Git.

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
2. Name the house mode in `.runtime/catalog.json`: `"mode": "<name>"`, the
   name the mode's Home Assistant helpers carry (lower-case letters, digits
   and `_`). Its overlay key and record target (`mode:<name>`), its dashboard
   script (`ls_<name>_mode`), the automation that reads its switch
   (`automation.lighting_schedule_<name>_mode_switch`) and its mirror
   (`input_boolean.ls_<name>_mode_mirror`) are spelled from it. A catalog
   without it is refused at start.
3. Clear `runtime.applied` once at cutover so every lamp is re-sent (starts the
   firmware candle). Set the `applied` attribute of `sensor.ls_effects_runtime`
   to an empty mapping `{}`: an absent or null `applied` is read as `targets`,
   which the old engine also wrote, so removing it re-sends nothing.

Live connection requires an existing credential file and an explicit command:

```sh
HA_URL=https://YOUR_HOME_ASSISTANT HA_TOKEN_FILE=/path/to/existing/token \
  npm run dev -- --live --config .runtime/catalog.json --live-rooms <room>[,<room>...]
```

Do not run that as a smoke test. Run `npm run verify`, review the
bridge configurations and switch output ownership before a supervised daytime
cutover. Restore the captured original automation actions to roll back. This
repository deliberately does not embed credentials or perform a live cutover on
startup in its default offline mode.

## Rooms on the port

The cutover can go one room at a time while the old scripts keep the rest of the
house (`src/adapter/live-rooms.ts`). A room is the port's when it is in
`--live-rooms` (comma-separated Home Assistant area ids; `''` is none) and its
port switch `input_boolean.ls_<room>_on_port` is on. The list is what the
process may take; the switch is where a person hands the room over or back. A
missing `--live-rooms` is refused at start-up: it never means every room.

1. The port computes the whole house, and sends lamp, bulb and switch commands
   only for its rooms: the reconciler is given only their lamps and switches,
   so a Zigbee group with a lamp of another room is never used.
2. A remote press, a dashboard control, a lamp switched from the app or a plug
   pressed in another room does nothing in the port: an input's messages are
   dropped unless every room they are about is the port's. House-wide inputs
   (the mode, a hold over the house, clearing every overlay, the range
   defaults) are the old scripts' to commit. The clock runs for every room.
3. Until every room is the port's, the port reads the overlays from
   `sensor.ls_overrides` at every turn, so its rooms follow what the old
   scripts commit (a hold over the house holds each room), and it writes back
   only its own rooms' overlays and remote helpers; everything else in the
   sensor, house-wide overlays included, is left exactly as found. The
   dashboard mirror, the block selects and the mode mirror stay with the old
   scripts. The fields the old scripts read across rooms
   (`docs/sensor-fields.md`, "Carried": the render queue and its requests,
   `sensor.ls_effects_runtime`, the room caches) are never written by the
   port; each write of the port moves the store's revision, so an old render
   planned before it is not marked handled and runs again.
4. Whenever a room is handed to the port while it runs (its switch turns on, or
   off and on again), the port forgets what it sent that room's bulbs and sends
   them their light again, so their bulb effects (the firmware candle) start.
   At start, the journal holds what the port last sent.
5. When every room of the house is the port's, none of the above applies: the
   port drives the whole house. With the old house-wide automations still
   running, do the full cutover for the last room instead.
6. Live rooms that hold none of the catalog's lamps are refused at start-up.
   The port writes `input_text.ls_port_heartbeat`
   (`<unix seconds>|<live rooms>`) every 10 s, but not while Home Assistant is
   out of reach; a Home Assistant watchdog, built with the old-side patch,
   turns off every port switch a fresh heartbeat does not name, and all of them
   after 30 s without one. An empty list sends nothing, not even a heartbeat.

`python3 scripts/export-bridge.py --rollout` prepares the matching Home Assistant
side in `.runtime/bridge-rollout`: one new automation per room-scoped bridge (id
`<id>_port`), acting only for rooms whose switch is on and forwarding the
automation's own variables (the dashboard controls' `sources`), plus a recovery bridge
that lets the port render what the old scripts commit. House-wide store writers
and the schedule tick stay with the old scripts. The old scripts must, in turn,
skip rooms whose switch is on; that patch is built from the captured originals
and stays out of this repository.
