# Smarthome automation

This repository contains the reusable, host-neutral lighting application: a Rust
daemon, its strict declarative configuration, MQTT/Zigbee2MQTT adapter, Nix
package, and NixOS service module. Rust owns automation semantics; protocol
services translate device events and commands. Home Assistant is deliberately
not part of the architecture.

The private NixOS configuration remains responsible for the physical host:
networking, Tailscale and SSH, agenix, Mosquitto, Zigbee2MQTT, Matrix, storage,
backup destinations, and deployment. That keeps host identities and secrets out
of this reusable repository. The [companion host runbook](https://github.com/jonathanmoregard/nixos-config/blob/main/docs/home-server/README.md)
owns the Dell Wyse assumptions, blank-disk bootstrap, Matrix setup, other
mutable-service backups, rollback, and disaster recovery.

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

Run the same complete gate used by CI:

```console
nix flake check -L
```

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
systemd hardening. The host configuration wires the module to its broker and
age-decrypted credential file.

### Add a room, light, or control

1. Add the floor and room to `[[floors]]` and `[[rooms]]`.
2. Add room, floor, or house `[[scopes]]` and select a circadian curve.
3. Pair the device, give it a stable Zigbee2MQTT `friendly_name`, and use that
   exact name in `[[devices]]` or `[[controls]]`.
4. Declare only capabilities the device actually exposes: on/off, dimming,
   color temperature with safe Kelvin/mired limits, XY/HS color, input, or
   sensor capabilities. Vendor-specific extensions stay optional.
5. Optionally declare a Zigbee group for synchronized room commands. Devices
   remain available as per-device fallbacks, including when a group cannot
   express color temperature safely.
6. Map control gestures to a scope and run `nix flake check -L` before deploying
   through the host repository's established path.

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

To pair an IKEA LED2111G6 or Philips Hue bulb directly (no Hue Bridge):

1. Enable pairing briefly through the private/localhost Zigbee2MQTT frontend.
2. Factory-reset the bulb and wait for its interview to complete.
3. Assign a unique stable `friendly_name`, add the device and its observed
   capabilities to the declarative configuration, and disable pairing.
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
and is translated/clamped for each device. Monotone interpolation avoids curve
overshoot. Thresholds and maximum refresh intervals keep hours-long changes
sparse enough not to flood the Zigbee mesh.

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
retained Zigbee2MQTT bridge-online report before sending desired commands. It
reconciles devices when available, including bounded maximum refreshes that
cannot be starved by changes elsewhere. Retries are bounded and stale
acknowledgements cannot override a newer plan, preventing command oscillation.

## State, secrets, and backups

Durable state lives in
`/var/lib/house-automation/state.sqlite3`. Versioned SQLite migrations preserve
user brightness/CCT offsets, follow/frozen mode and captured baselines, runtime
scope selection, and the last global reset date. Temporary overlays, in-flight
convergence, and MQTT connection state are not restored.

Create a transactionally consistent SQLite export while the daemon runs:

```console
sudo house-automationd backup \
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
mosquitto_sub -h 127.0.0.1 -t 'zigbee2mqtt/bridge/state' -v
mosquitto_sub -h 127.0.0.1 -t 'zigbee2mqtt/+/availability' -v
df -h /var/lib/house-automation /var/lib/zigbee2mqtt
```

For an unexpected target, correlate the structured log fields with the active
curve, durable offset, curve mode, and overlay. Also confirm the device's
availability and observed JSON state before forcing a command.

## Test boundaries

`nix flake check -L` is the sole CI entry point and covers the Rust formatting,
Clippy, unit/integration tests, package build, and Nix module checks exposed by
the flake. No CI job deploys a host or requires plaintext secrets.

The `simulated-house` flake check is a black-box NixOS VM test with a real
Mosquitto broker, the real daemon, and a fake Zigbee2MQTT peer. Its controlled
clock and MQTT observations exercise delayed single/double clicks,
acknowledgement overlays, the nightly 04:00 all-owner reset, whole-hour
expiration, persistence, reconnect, reconciliation, readiness, and logs without
test-only production endpoints.

A VM cannot validate Ember firmware, USB enumeration, RF quality, pairing, or
mesh routing. Stable by-id resolution and static Zigbee2MQTT configuration can
be evaluated in CI, but the ZBDongle-E and representative IKEA/Hue hardware still
require a documented physical smoke test during bootstrap.
