# Smarthome

This repository owns the complete home-automation appliance: the physical
`home-server` NixOS configuration, Home Assistant, MQTT and Zigbee2MQTT,
encrypted runtime secrets, tests, release publication, deployment, rollback,
and recovery documentation. Home Assistant owns the production lighting schedule:
fixed Day, Cosy and Night blocks, managed in its UI.

`smarthome` has no import or runtime dependency on another configuration
repository. GitHub builds the release closure, Cachix distributes it, and the
server only evaluates and substitutes promoted revisions with builders
disabled. Start with the runbooks for [bootstrap](docs/home-server/bootstrap.md),
[deployment](docs/home-server/deployment.md),
[recovery](docs/home-server/recovery.md),
[secrets](docs/home-server/secrets.md),
[access](docs/home-server/access.md), and
[Home Assistant](docs/home-server/home-assistant.md).

## Architecture

```text
                         +-------------------+
                         |  Home Assistant   |
                         | lighting blocks   |
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

Home Assistant is configured in
[`nixos/modules/home-assistant.nix`](nixos/modules/home-assistant.nix) and is
the production automation layer. Zigbee, Z-Wave, and 433 MHz remain separate
radio systems. Automation rules do not belong in Mosquitto, Zigbee2MQTT, the
TellStick adapter, Matrix, or shell scripts.

## Checks

Run the comprehensive local gate:

```console
nix flake check -L
```

CI first evaluates the whole flake, then builds the home-server lane when
host paths changed. The local command above builds every check, so it is
intentionally broader than the selected CI lane. The development shell provides
`age`. Nix commands require a working Nix installation and daemon.

## Releases

Pull requests classify changed paths and run only the affected home-server
lane, plus unconditional flake evaluation and a stable required `ci` summary.
No pull-request job can access repository secrets, and no secret value belongs
in a pull request.

Every push to protected `main` that changes the host publishes the system
track: build
`nixosConfigurations.home-server.config.system.build.toplevel`, push its
closure, verify signed builderless substitution, then fast-forward
`release/home-server`.

The exact root must exist in `jonathanmoregard.cachix.org`; dependencies may
come only from that signed cache or `cache.nixos.org`. `CACHIX_AUTH_TOKEN` is a
cache-scoped GitHub Actions secret used only by main publication jobs. Only
the post-verification promotion job receives `contents: write`. The server's
`system-deploy` timer fetches the public repository over HTTPS, hydrates the
system closure, and performs transactional activation with sustained health
checks, keeping at most two system profile generations. Dellan is not part of
the release path; its SSH key remains ordinary operator access.

The deployer uses `/var/lib/smarthome-system-deploy` for its source checkout
and markers, and `/nix/var/nix/profiles/system` for the active system profile.
System rollback preserves the exact previous generation and refuses to clobber
an operator-selected rollback. See [deployment](docs/home-server/deployment.md)
and [recovery](docs/home-server/recovery.md).

### Add a light to the production schedule

Adding, naming, moving or removing a light needs no repository change and no
pull request. Zigbee2MQTT remains the device registry (`devices.yaml` in
`/var/lib/zigbee2mqtt`, kept across restarts) and publishes paired devices to
Home Assistant through MQTT discovery.

Pair and name the device through Home Assistant's Zigbee2MQTT bridge, label it
`house_schedule` (or `on_off` for a plug), and assign its room. The block
times and light settings are edited on the `/lighting-schedule` dashboard. The
complete procedure is in
[the Home Assistant runbook](docs/home-server/home-assistant.md).

## MQTT contract

Zigbee2MQTT's native JSON topics are consumed by Home Assistant through MQTT
discovery:

```text
zigbee2mqtt/<friendly_name>               observed JSON state/action
zigbee2mqtt/<friendly_name>/availability availability
zigbee2mqtt/<friendly_name>/get           state read request
zigbee2mqtt/<friendly_name>/set           command
zigbee2mqtt/bridge/state                  bridge availability
```

MQTT is an internal bus on loopback for co-located services: the loopback
Mosquitto listener allows anonymous access under a topic ACL, and the broker
must never be exposed to the public Internet. Commands, button actions, and
ephemeral events are never retained. Retained observed state and availability
are accepted at QoS 1; control actions use QoS 0 and retained control actions
are ignored.

## Zigbee setup and pairing

The host configuration owns Zigbee2MQTT and the Sonoff ZBDongle-E. It must use a
stable `/dev/serial/by-id/...` path and Zigbee2MQTT's supported `ember` adapter,
never `/dev/ttyUSB0`. At bootstrap, verify the dongle firmware against the
documentation for the exact installed Zigbee2MQTT release; this repository does
not assert a firmware version that will become stale. The Zigbee channel, PAN
ID, extended PAN ID, and encrypted network key are stable identity data; do not
regenerate them during routine recovery.

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
connection drops, pairing still closes when the window expires.

To pair an IKEA LED2111G6 or Philips Hue bulb directly (no Hue Bridge):

1. Run `pair-zigbee` (or enable pairing briefly through the private/localhost
   Zigbee2MQTT frontend).
2. Factory-reset the bulb and wait for its interview to complete.
3. Assign a unique stable `friendly_name`, make sure pairing is closed, and
   label it `house_schedule` in the Home Assistant UI.
4. Confirm its state and availability topics, then exercise on/off, brightness,
   color temperature, and optional color.

An E1810/E1524 remote pairs the same way; its center `toggle` may be followed
by `toggle_hold`, so any Home Assistant automation on it should tolerate a late
hold rather than treat it as a click.

## State, secrets, and backups

Mutable service state lives under `/var/lib/hass` (Home Assistant, including
the lighting schedule), `/var/lib/zigbee2mqtt` (device database
and coordinator identity), and `/var/lib/mosquitto` (persistence). Git is only a
recovery source for declarative configuration and encrypted agenix material; it
does **not** back up any of these, nor Matrix PostgreSQL or Matrix media. HA's
Backup integration covers `/var/lib/hass` only. Until the host has a tested
off-host destination for the rest, mutable service data is not truly backed up.

Secrets are read from a root/service-readable runtime file, for example an
agenix-decrypted path such as `/run/agenix/...` or a systemd credential path.
Never put secret values in Git, generated world-readable files, or Nix
expressions that would copy them into the store. The same runtime-file pattern
applies to future TellStick or cloud API credentials. See
[secrets](docs/home-server/secrets.md).

## TellStick boundary

TellStick ZNet Lite v2 remains legacy local infrastructure for 433 MHz and
Z-Wave. A future adapter may discover and translate its **verified local API** to
normalized MQTT events/commands; it must not depend on Telldus cloud. This
repository intentionally does not invent endpoint paths or payload semantics
before the hardware/API is inspected. The adapter owns protocol translation
only—production automation stays in Home Assistant, and no radio-level
Zigbee/Z-Wave bridge is attempted.

## Test boundaries

Pull requests always evaluate the complete flake, then build the selected
home-server checks. They cover the focused deployer contracts (`system-deploy`,
`system-activator`, `hydrator`), the complete host services
(`home-server-services`, `home-server-ssh`, `vm-home-server`), the full
standalone boot (`standalone-host`), and real system deployment and rollback in
the CD VM (`vm-home-server-cd`). Main publication adds signed-cache provenance
and builderless substitution proofs before moving `release/home-server`.

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
