# Smarthome Automation Design

## Scope and repository boundary

`smarthome` is a public, reusable application repository. It owns Rust automation semantics, protocol adapters, its package, a NixOS service module, example configuration, and application CI. It contains no household coordinates, real device identifiers, server names, passwords, tokens, or encrypted host secrets.

`nixos-config` consumes a pinned `smarthome` flake input. That repository owns the concrete `home-server` host, household topology, agenix declarations, network policy, Matrix configuration, hardware bootstrap gates, and deployment wiring. This keeps application builds reproducible in existing public CI without adding a cross-repository credential.

## Rust workspace

The workspace has two crates:

- `house-automation-core`: pure normalized domain types, circadian curves, composition, scopes, remote classification, overlays, desired-state reconciliation, and persistence-neutral state transitions.
- `house-automationd`: TOML configuration, SQLite persistence, MQTT I/O, Zigbee2MQTT translation, the optional TellStick adapter boundary, scheduling, structured logs, and a loopback health endpoint.

The split keeps clock-driven lighting logic deterministic and cheap to test. Vendor payload parsing and network retries cannot leak into core state transitions.

## Domain and configuration

Normalized values are validated newtypes:

- brightness: finite `0.0..=1.0`
- color temperature: Kelvin internally, clamped to each device's declared min/max
- optional color: normalized XY or hue/saturation extension
- capabilities: on/off, dimming, color temperature, color, power metering, input, occupancy, and temperature

Static TOML configuration defines rooms, floors, devices, Zigbee groups, aliases, capabilities, remote mappings, scope membership, fixed-time circadian anchors, transition cadence, MQTT namespace, health bind, double-click window, unfreeze convergence, daily reset time, and whole-hour overlay. Configuration rejects missing references, duplicate identifiers, invalid curves, unsupported mappings, and non-loopback health binds unless explicitly allowed.

Successful manual freeze and unfreeze actions request a short configurable brightness acknowledgement overlay. Dimmable targets pulse away from their current clamp boundary, making acknowledgement visible at both low and maximum brightness. On/off-only targets are never flashed off. Expiry recomputes current composed state, so acknowledgement does not alter offsets, frozen state, or convergence.

Unknown physical values stay outside this repository. The NixOS module generates TOML for the daemon from host configuration.

## Circadian composition

Each controllable scope has one shared logical state, independent of how many remotes select it. Per-control state contains only runtime-selected scope. Target composition runs in this order:

1. Resolve FOLLOW baseline at current wall time, or use FROZEN baseline captured at freeze time.
2. During unfreeze convergence, interpolate from frozen baseline to the live curve's moving value.
3. Apply persisted user brightness and color-temperature offsets.
4. Apply configured contextual modifiers.
5. Apply active temporary overlays by stable priority and insertion sequence.
6. Clamp to normalized and device capability limits.

Fixed-time anchors use monotone cubic interpolation so smooth curves do not overshoot. Sparse updates occur only when the composed target changes beyond configured brightness or temperature thresholds, plus a bounded maximum refresh interval. Zigbee groups receive synchronized commands when declared; unavailable members and unsupported capabilities fall back per device.

Freeze captures current baseline, not output after offsets or overlays. Offsets remain editable while frozen. Unfreeze creates a configurable convergence interval rather than an instantaneous jump.

At configured local time, default `04:00`, one atomic state transition unfreezes every frozen scope through normal smooth convergence and records reset date. Already-following scopes stay FOLLOW; scopes already converging are already unfrozen and continue uninterrupted. Before accepting commands, first startup initializes and persists the latest completed reset marker; later startups compare it with latest scheduled reset so downtime across 04:00 cannot preserve stale freezes.

## Input classification and scopes

Remote mappings translate adapter events into declarative actions. Initial E1810 mapping is up/down brightness offset, left/right warmth offset, center single-click on/off, and center double-click freeze toggle.

Center short-click classification holds first click until configurable window closes. Second eligible click inside inclusive boundary emits only double-click. A timeout emits only single-click. Long-press and release events are separate. For E1524/E1810, `toggle_hold` cancels the pending `toggle` because that remote always emits `toggle` before a center hold and has no center-release event; a hold must not execute the single-click action. Tests inject monotonic and wall clocks; no test sleeps.

Actions target configured room, floor, or house scopes. Runtime-selected scope is persisted only when selection is enabled. Normal configurations can map each remote directly to one scope.

## Overlays and reconciliation

Overlays are in-memory layers with key, priority, start, expiry, and replacement policy. Same-key overlays replace deterministically; different keys compose by priority then insertion sequence. Expiry always recomputes from current baseline, offsets, and remaining overlays. Transient overlays never persist.

The hourly example adds a small brightness delta for 500 ms on each whole hour. It never saves/restores a stale target.

Per device, the engine stores desired target, last observed state, availability, last command, and correlation deadline. MQTT reconnect causes resubscription and deterministic reconciliation. Device availability recovery reconciles current desired state. Native Zigbee2MQTT event and command topics remain unchanged; application topics use `house/v1/...`. Input events and commands publish with `retain=false`. Observed reports do not mutate user offsets unless a configured input action explicitly does so, preventing report-command oscillation.

## Persistence

SQLite lives in systemd-managed `/var/lib/house-automation/state.sqlite3`. Embedded numbered migrations run transactionally before MQTT starts. Persisted data includes shared scope offsets, durable follow/frozen mode, frozen baseline, per-control runtime-selected scope, power intent, and last completed daily reset. Runtime convergence restores as FOLLOW because it contains boot-relative monotonic time. Ephemeral overlays, connection state, convergence progress, and partial animations are excluded.

## Protocol boundaries

Zigbee2MQTT adapter requires JSON output and parses native action/state/availability payloads with unknown-field/action tolerance. It maps configured friendly names exactly because Zigbee2MQTT names may contain `/`. E1524/E1810 actions are normalized from the documented open action enum; no native double-click is assumed. LED2111G6 brightness maps to `0..254`, Kelvin maps inversely to device mired bounds, and commands/reads are never retained. Devices configured as single-transition-attribute split simultaneous brightness and color-temperature transitions instead of relying on unsupported IKEA behavior. No vendor model match enters core semantics.

TellStick support starts as a disabled adapter interface with explicit traits for discovery, observed events, commands, token refresh, and polling. Current verified local API documentation establishes bearer authentication and device-list discovery but not a complete event or control endpoint set. Concrete calls remain disabled until actual ZNet Lite v2 `/api` discovery is recorded. Failure of this optional adapter cannot block Zigbee/MQTT automation.

## Operations and security

Daemon runs as dedicated unprivileged user. NixOS module uses a read-only generated config, private state directory, `NoNewPrivileges`, strict filesystem protection, private temporary directory, restricted address families, empty capability set, restart-on-failure, and bounded resources. MQTT credentials are optional runtime files; values never enter Nix store or logs.

`tracing` logs stable fields including device, room, source, action, scope, old/new target, availability, reconnect, curve mode, and overlay ID. Raw MQTT payloads are logged only at opt-in trace level after secret-bearing fields are redacted.

Health endpoint binds `127.0.0.1` by default and reports process readiness, database migration state, MQTT connection state, last successful reconciliation, and adapter availability without secrets.

## Testing and CI

Core tests use fake clocks and cover every requested curve, offset, freeze, reset, overlay, click, persistence, reconnect, and capability behavior. Daemon integration tests use temporary SQLite and an in-process MQTT transport boundary. A black-box NixOS simulation boots the real daemon and Mosquitto, while a fake external Zigbee adapter publishes representative Zigbee2MQTT payloads and observes real command topics. Production configuration seams shorten scheduler intervals; VM wall-clock control reaches 04:00 behavior. No test-only HTTP state injection exists. The simulation exercises pairing-style discovery/state, remote clicks, command acknowledgement, overlay expiry, persistence across daemon restart, broker disconnect/reconnect, device availability recovery, health readiness, and journal output. Hardware-only coordinator startup remains a static configuration assertion because a real Ember radio cannot be meaningfully emulated.

`nix flake check` exposes Rust formatting, Clippy with warnings denied, workspace tests, package build, NixOS module evaluation, and the black-box simulated-house VM. GitHub Actions runs that single flake gate on pushes and pull requests.

## Source facts used by host integration

- Zigbee2MQTT Ember adapter: <https://www.zigbee2mqtt.io/guide/adapters/emberznet.html>
- Stable serial paths: <https://www.zigbee2mqtt.io/guide/configuration/adapter-settings.html>
- Zigbee2MQTT security: <https://www.zigbee2mqtt.io/guide/installation/14_securing.html>
- TellStick local API and bearer flow: <https://tellstick-server.readthedocs.io/en/v1.0.14/api.html> and <https://tellstick-server.readthedocs.io/en/latest/api/authentication.html>
