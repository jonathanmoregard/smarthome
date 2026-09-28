# Runtime device registry

Date: 2026-09-28

## Why

Adding a lamp must not require a pull request. Today house-automationd reads
one TOML file baked into the NixOS system, so every new device is a repo edit,
a review and a deploy. The user also requires that devices persist across
reboots and support create, read, update, delete and inspect.

## Decision

Zigbee2MQTT's own state directory is the device registry. Git keeps policy
only. house-automationd discovers devices from Zigbee2MQTT at runtime, and a
`house` command gives operators CRUD over SSH.

Rejected:

- A second runtime device file edited by a CLI: a second source of truth that
  drifts from Zigbee2MQTT, with capabilities typed by hand.
- Git-driven device list pushed without review: still a repo edit per device.

## Persistence

The NixOS zigbee2mqtt module copies the generated `configuration.yaml` over the
live file on every start (`ExecStartPre`), so anything Zigbee2MQTT wrote there
would be lost. Renames are not written there: the module already defaults
`settings.devices = "devices.yaml"` and `settings.groups = "groups.yaml"`
(`lib.mkDefault`), and Zigbee2MQTT 2.13 reads and writes devices and groups in
those separate files (`util/settings.js`, `readDevicesOrGroups` /
`writeDevicesOrGroups`). They live in `/var/lib/zigbee2mqtt` and Nix never
rewrites them. Pairing data stays in `database.db`. No host change is needed;
the host must simply not override those two settings.

Invariant: a device renamed at runtime keeps its name after
`systemctl restart zigbee2mqtt` and after reboot.

## Every light follows the curve on join

A discovered light is controlled as soon as Zigbee2MQTT finishes its
interview, whatever its name — including the default `0x…` address. With no
room, it is owned by the house scope and follows `default_curve`.

## Placement by name (optional)

Room placement exists only to target remotes at a room and for future per-room
or per-lamp adjustments. It never gates control.

A device's Zigbee2MQTT `friendly_name` may be `<floor>/<room>/<device>`, each
segment matching the existing id grammar. Example:
`upper-floor/upper-hallway/lamp`.

- Matching name: the device is a member of that floor and room.
- Any other name: the device has no room and is owned by the house scope.

A floor or room that appears only in device names is created implicitly as a
membership target; it gets no scope of its own. Ownership follows the existing
most-specific-scope rule: a declared room scope, else a declared floor scope,
else the house scope. So a placed device keeps following `default_curve` until
someone declares an override scope for its room or floor.

## Base configuration (git)

New top-level key `default_curve = "<curve id>"`, required when discovery is
enabled. The daemon synthesizes a house scope with that curve if the TOML does
not declare one. Everything else in the schema is unchanged. `[[devices]]` stay valid;
if a static device and a discovered device share a `friendly_name`, the static
declaration wins and the discovered one is ignored with a log line.

The first production `nixos/hosts/home-server/house.toml` holds location,
MQTT, circadian settings, curves and `default_curve`. No devices.

## Discovery in house-automationd

- Subscribe to retained `zigbee2mqtt/bridge/devices`.
- For each device of type `Router`/`EndDevice` with a `definition` whose
  exposes contain a `light`:
  - `state` → on/off; `brightness` → dimming.
  - `color_temp` with `value_min`/`value_max` mired → colour temperature;
    Kelvin bounds are `1e6 / mired`, rounded inward so the derived range is
    always inside the bulb's range.
  - `color_xy` / `color_hs` → colour capabilities.
  - Vendor `IKEA` → `single_transition_attribute = true`.
- Non-light devices are listed but not controlled in this iteration.
- Every bridge update is diffed against the current discovered set:
  added devices start reconciliation, removed devices stop it and their
  per-device state is dropped, moved devices change owner scope.
- No restart is needed for any of these.
- Until the first bridge message arrives, the daemon runs with static devices
  only and `/health` reports `discovery: pending`.
- A light whose exposes cannot be mapped is not controlled; `house show`
  reports the reason. This is the only case where a discovered light is not
  controlled.

## `house` command

Runs from any machine with Tailscale and an accepted SSH key, like
`pair-zigbee`, by speaking MQTT to the server's local broker over SSH.

| Operation | Command | Effect |
|---|---|---|
| Create | `house add <floor/room/name> [--time S]` | Opens pairing; renames the first joined device to the name |
| Read | `house list` | Name, placement, model, availability |
| Inspect | `house show <name>` | Above plus owner scope, live state, circadian target, not-controlled reason |
| Update | `house rename <old> <new>` | Zigbee2MQTT rename; moves rooms when the path changes |
| Delete | `house remove <name> [--force]` | Zigbee2MQTT remove; device leaves the network |

`pair-zigbee` stays as the low-level pairing command; `house add` reuses it.
`house show` reads live state from Zigbee2MQTT and the circadian target from
the daemon's health endpoint over the same SSH connection.

## Testing

Invariants, not mirrors of the implementation:

- Derived colour-temperature range is inside the reported mired range for
  every fixture, including the captured LED2111G6 interview payload.
- A device renamed out of a room is never commanded under its old room.
- VM test: a fake Zigbee2MQTT publishes a device list; the daemon commands the
  device; a rename moves it; removal stops commands.
- The shipped production `house.toml` validates.
- Host evaluation fails if `devices.yaml` / `groups.yaml` stop being the
  Zigbee2MQTT device and group files.

## Rollout

1. One PR: discovery in the daemon, the `house` command, the base
   `house.toml` enabled on home-server, and a module assertion that
   `devices.yaml` / `groups.yaml` stay the Zigbee2MQTT device and group files.
   These cannot ship separately: today the config, scope and runtime layers
   all reject a topology with no static devices, so the daemon cannot run
   until discovery makes an empty static device list valid.
2. Operator: `house rename 0x7cc6b6fffe3cef1c upper-floor/upper-hallway/lamp`.

After step 1, adding a device never needs a pull request.

## Empty static topology

With discovery, `devices = []` and `controls = []` are valid, a scope may have
no devices until discovery fills it, and the runtime idles with no devices
instead of refusing to start.
