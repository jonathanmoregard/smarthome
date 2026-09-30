# Smarthome automation

This repository owns the complete home-automation appliance: Rust lighting
daemon, physical `home-server` NixOS configuration, MQTT and Zigbee2MQTT,
encrypted runtime secrets, tests, release publication, deployment, rollback,
and recovery documentation. Rust owns automation semantics; protocol services
translate device events and commands. Home Assistant is deliberately absent.

`smarthome` has no import or runtime dependency on another configuration
repository. GitHub builds both release closures, Cachix distributes them, and
the server only evaluates and substitutes promoted revisions with builders
disabled. Start with the runbooks for [bootstrap](docs/home-server/bootstrap.md),
[deployment](docs/home-server/deployment.md),
[recovery](docs/home-server/recovery.md),
[secrets](docs/home-server/secrets.md),
[access](docs/home-server/access.md), and
[Home Assistant](docs/home-server/home-assistant.md).

## Architecture

```text
                         +-------------------+
                         |  Rust automation  |
                         |  desired state    |
                         +---------+---------+
                                   |
                                  MQTT
                                   |
                              Mosquitto
                    +--------------+--------------+
                    |                             |
              Zigbee2MQTT                TellStick adapter
                    |                     (discovery boundary)
              ZBDongle-E                         |
                    |                    ZNet Lite v2 local API
                 Zigbee                    |             |
                                      433 MHz        Z-Wave
```

Zigbee, Z-Wave, and 433 MHz remain separate radio systems. MQTT and the Rust
domain model are where they meet. Automation rules do not belong in Mosquitto,
Zigbee2MQTT, the TellStick adapter, Matrix, or shell scripts.

## Build and configure

Run the comprehensive local gate:

```console
nix flake check -L
```

CI first evaluates the whole flake, then builds path-selected app or system
lanes. The local command above builds every check, so it is intentionally
broader than either selected CI lane.

For focused Rust work:

```console
nix develop --command cargo fmt --check
nix develop --command cargo clippy --workspace --all-targets -- -D warnings
nix develop --command cargo test --workspace
```

[`examples/house.toml`](examples/house.toml) is the executable configuration
example. Configuration is versioned with `schema_version = 1` and rejects
unknown fields, duplicate IDs, invalid references, unsafe MQTT namespaces, and
impossible capability combinations. Static topology belongs in Git; deliberate
runtime choices do not.

The exported NixOS module integrates the daemon without describing a particular
machine:

```nix
services.houseAutomation = {
  enable = true;
  settings = builtins.fromTOML (builtins.readFile ./house.toml);
  environmentFile = config.age.secrets.house-automation-mqtt.path;
};
```

The module generates the non-secret TOML, runs the service as its own
unprivileged account, stores state below `/var/lib/house-automation`, and applies
systemd hardening. The production host currently leaves
`homeServer.houseSettings = null`, so it deploys the app profile but does not
start the daemon until real paired device IDs replace the example topology.

## Releases

Pull requests classify changed paths and run only affected application or
home-server lanes, plus unconditional flake evaluation and a stable required
`ci` summary. No pull-request job can access repository secrets.

Every push to protected `main` independently publishes affected tracks:

- application changes build `packages.x86_64-linux.default`, verify signed
  builderless substitution, then fast-forward `release/app`;
- host changes build
  `nixosConfigurations.home-server.config.system.build.toplevel`, perform the
  same verification, then fast-forward `release/home-server`.

Both exact roots must exist in `jonathanmoregard.cachix.org`; dependencies may
come only from that signed cache or `cache.nixos.org`. `CACHIX_AUTH_TOKEN` is a
cache-scoped GitHub Actions secret used only by main publication jobs. Only
post-verification promotion jobs receive `contents: write`. The server fetches
the public repository over HTTPS, serializes both deployers on one lock, and
keeps at most two application and two system profile generations. Dellan is not
part of either release path; its SSH key remains ordinary operator access.

### Add a room, light, or control

Adding, naming, moving or removing a light needs no repository change and no
pull request. Zigbee2MQTT is the device registry (`devices.yaml` in
`/var/lib/zigbee2mqtt`, kept across restarts), and `house-automationd`
follows its retained `zigbee2mqtt/bridge/devices` list at runtime.

```console
nix run .#house -- add upper-floor/upper-hallway/lamp   # pair and name
nix run .#house -- list                                 # name, room, model, availability
nix run .#house -- show upper-floor/upper-hallway/lamp  # owner, live state, circadian target
nix run .#house -- identify 0x7cc6b6fffe3cef1c          # make it flash
nix run .#house -- rename 0x7cc6b6fffe3cef1c upper-floor/upper-hallway/lamp
nix run .#house -- remove upper-floor/upper-hallway/lamp
```

- A light follows the curve as soon as Zigbee2MQTT finishes its interview,
  even under its `0x…` name. A light whose exposes cannot be mapped is not
  controlled, and `house show` says why. Remotes and sensors are listed but
  not discovered as controls.
- A `<floor>/<room>/<device>` name only adds room membership. It lets remotes
  target the room and allows later per-room adjustments. Ownership is the
  most specific declared scope: room, then floor, then house. The house scope
  uses `default_curve` and is created automatically when `house.toml`
  declares none.
- A `[[devices]]` entry still works. When it shares a `friendly_name` with a
  discovered device, the static entry wins.

Policy still lives in `nixos/hosts/home-server/house.toml` and goes through
the [Releases](#releases) tracks: `default_curve`, curves, a declared
`[[rooms]]` + `[[scopes]]` pair to give a room its own curve or make it a
remote target, and `[[controls]]` for remotes. Run `nix flake check -L`
after such changes.

`/healthz` on the daemon's loopback listener reports
`discovery: disabled | pending | synced` without naming devices. `/devices`
lists every device with its room, owner, target and any not-controlled
reason; `house` reads it through the same SSH connection.

Scopes compose as room, floor, and house ownership. The most specific physical
owner holds durable offsets and curve state; broader actions fan out to those
owners. A control's selected scope is declarative initially and is persisted if
runtime scope selection is later enabled.

## MQTT contract

Zigbee2MQTT's native JSON topics remain intact:

```text
zigbee2mqtt/<friendly_name>               observed JSON state/action
zigbee2mqtt/<friendly_name>/availability availability
zigbee2mqtt/<friendly_name>/get           state read request
zigbee2mqtt/<friendly_name>/set           command
zigbee2mqtt/bridge/state                  bridge availability
```

Application-owned topics are under the separately configured, versioned
namespace `house/v1/...`; today it carries daemon status/LWT and leaves room for
future normalized APIs. The application namespace must not overlap the
Zigbee2MQTT base topic.

MQTT is an internal bus, normally on loopback for co-located services. Commands,
button actions, and ephemeral events are never retained. Retained observed state
and availability are accepted at QoS 1; control actions use QoS 0 and retained
control actions are ignored. The daemon publishes retained online/offline
status through a last will. Do not expose the broker to the public Internet.

## Zigbee setup and pairing

The host configuration owns Zigbee2MQTT and the Sonoff ZBDongle-E. It must use a
stable `/dev/serial/by-id/...` path and Zigbee2MQTT's supported `ember` adapter,
never `/dev/ttyUSB0`. At bootstrap, verify the dongle firmware against the
documentation for the exact installed Zigbee2MQTT release; this repository does
not assert a firmware version that will become stale.

Connect the coordinator through a USB extension cable, away from the server and
USB 3 radio noise. Use it for Zigbee only, not concurrent Zigbee/Thread
multiprotocol. Mains-powered Zigbee devices can build the router backbone;
battery remotes and sensors should not be assumed to route. The server itself
does not need Wi-Fi.

To open pairing from any tailnet machine whose SSH key the server accepts:

```console
nix run .#pair-zigbee -- --time 180
```

The command forwards a private Unix socket to the server's loopback-only
Mosquitto over ordinary SSH (`home-server` by default; `--host` or
`SMARTHOME_HOST` override it), refuses to continue unless Zigbee2MQTT reports
online, permits joining for the given 1–254 seconds, prints joins and
identification results, and closes pairing again at the end or on Ctrl-C. If the
connection drops, pairing still closes when the window expires. The
`pair-zigbee-device` skill in `.claude/skills/` lets a Claude session run it and
walk someone through resetting a bulb that has no button.

To pair an IKEA LED2111G6 or Philips Hue bulb directly (no Hue Bridge):

1. Run `pair-zigbee` (or enable pairing briefly through the private/localhost
   Zigbee2MQTT frontend).
2. Factory-reset the bulb and wait for its interview to complete.
3. Assign a unique stable `friendly_name`, add the device and its observed
   capabilities to the declarative configuration, and make sure pairing is
   closed.
4. Confirm its state and availability topics, then exercise on/off, brightness,
   color temperature, and optional color. IKEA bulbs that cannot smoothly
   transition brightness and CCT together receive sparse incremental updates.

Pair an E1810/E1524 remote the same way and declare it under `[[controls]]`. The
example mapping is:

| Gesture | Action |
| --- | --- |
| Up / down | Increase / decrease brightness offset |
| Left / right | Adjust color-temperature offset |
| Center single click | Toggle power |
| Center double click | Freeze/unfreeze, with acknowledgement |

The E1810 center `toggle` is ambiguous because it may be followed by
`toggle_hold`. A second `toggle` within the double-click deadline (350 ms in the
example) becomes one double-click action. Otherwise the single-click action
waits until the ambiguous hold window expires (1200 ms in the example), allowing
a late hold to cancel it. Holds and releases are classified separately, so they
cannot accidentally become clicks. The daemon never toggles immediately and
then undoes it, avoiding visible power flashes.

## Lighting semantics

Each output is recomputed from independent layers:

```text
circadian baseline + durable user offsets + contextual modifiers + overlays
```

Brightness uses normalized `0.0..1.0`; color temperature is canonical Kelvin
and is translated/clamped for each device. Color temperature interpolates in
mired, matching lamp control and perceptual behavior. Shape-preserving cubic
interpolation prevents overshoot within each adjacent anchor pair; complete
daily curves are intentionally non-monotone, rising toward daytime and falling
toward night. Thresholds and maximum refresh intervals keep hours-long changes
sparse enough not to flood the Zigbee mesh.

Curves support two modes. Existing fixed curves omit `kind` and define explicit
`anchors`. `kind = "solar_hybrid"` derives daily anchors from configured local
sunrise, solar noon, sunset, wake time, and bed time. Brightness and color
temperature use separate evening transition points, so lights can warm before
they become dim. Solar calculation is local and deterministic; it performs no
network lookup or geocoding.

`[location]` holds approximate committed coordinates plus an IANA timezone.
The example uses coarse Stockholm coordinates rather than a precise household
position. Its winter policy maps every date from November 1 through January 31
to a November 1 reference profile. December and January therefore keep the
longer November cycle instead of contracting toward solstice daylight; normal
seasonal movement resumes February 1. The hold dates and reference remain
explicit TOML values.

Offsets survive restart and continue to apply while a curve is frozen. Freezing
captures the baseline at that instant. Unfreezing resumes the live curve through
a configurable smooth convergence rather than a jump. Both commands add a
short, visible brightness acknowledgement overlay on eligible dimmable targets
without switching the light off, changing the durable offset, or destroying the
underlying target. On/off-only targets are never flashed for acknowledgement.

At 04:00 local time every night, **all physical lighting owners are unfrozen**,
regardless of which control or room originally froze them. Each owner converges
smoothly back to its current curve. A durable reset-date marker makes a daemon
that starts after a missed 04:00 reset perform it once rather than leaving stale
frozen state behind.

The whole-hour signal is a configurable 500 ms brightness overlay. Expiration
recomputes the then-current target; it never saves a value, sleeps, and restores
stale state. Overlays have deterministic IDs/priorities, may replace or cancel
one another, and are intentionally not persisted.

The engine separately tracks desired and observed device state. On MQTT
reconnect it first resubscribes and requests current state, then waits for the
retained Zigbee2MQTT bridge-online report and each device's retained online
availability before sending that device a desired command. This avoids a
bridge-online/device-offline ordering race. Bounded maximum refreshes target
only devices whose deadlines are due, use independent dispatch tokens, and
cannot be canceled or starved by changes elsewhere. MQTT disconnects and
Zigbee bridge restarts both require fresh device availability. Retries are
bounded and stale
acknowledgements cannot override a newer plan, preventing command oscillation.

## State, secrets, and backups

Durable state lives in
`/var/lib/house-automation/state.sqlite3`. Versioned SQLite migrations preserve
user brightness/CCT offsets, follow/frozen mode and captured baselines, runtime
scope selection, and the last global reset date. Temporary overlays, in-flight
convergence, and MQTT connection state are not restored.

Create a transactionally consistent SQLite export while the daemon runs:

```console
sudo install -d -o house-automation -g house-automation -m 0700 /srv/backup
sudo -u house-automation \
  /nix/var/nix/profiles/smarthome/bin/house-automationd backup \
  --database /var/lib/house-automation/state.sqlite3 \
  --destination /srv/backup/house-automation-state.sqlite3
```

The destination must not already exist. Copy the export off-host and test its
restore procedure. Git is only a recovery source for declarative configuration
and encrypted agenix material; it does **not** back up SQLite, Mosquitto
persistence, Zigbee2MQTT's database/coordinator backup, Matrix PostgreSQL, or
Matrix media. Until the host has a tested off-host destination, mutable service
data is not truly backed up.

MQTT credentials are read from a root/service-readable runtime environment file
using the configured variable names. On NixOS, point `environmentFile` at an
agenix-decrypted path such as `/run/agenix/...` or a systemd credential path.
Never put secret values in TOML, Git, generated world-readable files, or Nix
expressions that would copy them into the store. The same runtime-file pattern
applies to future TellStick or cloud API credentials.

## TellStick boundary

TellStick ZNet Lite v2 remains legacy local infrastructure for 433 MHz and
Z-Wave. A future adapter may discover and translate its **verified local API** to
normalized MQTT events/commands; it must not depend on Telldus cloud. This
repository intentionally does not invent endpoint paths or payload semantics
before the hardware/API is inspected. The adapter owns protocol translation
only—automation stays in Rust, and no radio-level Zigbee/Z-Wave bridge is
attempted.

## Operations and diagnostics

The daemon logs structured events through `tracing`, including device, room,
source, action, scope, old/new target, availability, reconnect, curve mode, and
overlay where relevant. Secret-bearing MQTT payloads are not logged wholesale.
The loopback health endpoint returns success only after the database migration,
MQTT connection, and Zigbee2MQTT bridge readiness are all established.

Useful host-side checks:

```console
systemctl status house-automationd mosquitto zigbee2mqtt
journalctl -u house-automationd -f
journalctl -u zigbee2mqtt -f
curl --fail-with-body http://127.0.0.1:9876/healthz
mqtt_pkg="$(sudo nix eval --raw \
  /var/lib/smarthome-system-deploy/source#nixosConfigurations.home-server.config.services.mosquitto.package.outPath)"
"$mqtt_pkg/bin/mosquitto_sub" -h 127.0.0.1 -t 'zigbee2mqtt/bridge/state' -v
"$mqtt_pkg/bin/mosquitto_sub" -h 127.0.0.1 -t 'zigbee2mqtt/+/availability' -v
df -h /var/lib/house-automation /var/lib/zigbee2mqtt
```

For an unexpected target, correlate the structured log fields with the active
curve, durable offset, curve mode, and overlay. Also confirm the device's
availability and observed JSON state before forcing a command.

## Test boundaries

Pull requests always evaluate the complete flake, then build selected app or
system checks. App checks cover Rust formatting, Clippy, unit/integration tests,
package source boundaries, package build, module integration, and simulated
house behavior. System checks cover focused deployer contracts, complete host
services, full standalone boot, and real app/system deployment and rollback in
the CD VM. Main publication adds signed-cache provenance and builderless
substitution proofs before moving either release ref.

The `simulated-house` flake check is a black-box NixOS VM test with a real
Mosquitto broker, the real daemon, and a fake Zigbee2MQTT peer. Its controlled
clock and MQTT observations exercise delayed single/double clicks,
acknowledgement overlays, the nightly 04:00 all-owner reset, whole-hour
expiration, persistence, reconnect, reconciliation, readiness, and logs without
test-only production endpoints.

The `pair-zigbee` check boots a client and a server with OpenSSH, the
production-shaped loopback Mosquitto listener, and a fake Zigbee2MQTT bridge. It
runs the packaged command through its SSH tunnel and checks the exact
`permit_join` requests for a completed window, Ctrl-C, termination, hangup, a
refused request, a dropped tunnel, a stopped or never-started bridge, a stopped
broker, an unreachable host, and argument validation.

A VM cannot validate Ember firmware, USB enumeration, RF quality, pairing, or
mesh routing. Stable by-id resolution and static Zigbee2MQTT configuration can
be evaluated in CI, but the ZBDongle-E and representative IKEA/Hue hardware still
require a documented physical smoke test during bootstrap.
