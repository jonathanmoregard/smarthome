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

Fixed-time anchors use monotone cubic interpolation so smooth curves do not overshoot. Sparse updates occur only when the composed target changes beyond configured brightness or temperature thresholds, plus a bounded maximum refresh interval. Zigbee groups receive synchronized commands when declared; unavailable members and unsupported capabilities fall back per device. A physical device may belong to at most one configured Zigbee synchronization group, which prevents overlapping group commands from racing. Logical room, floor, and house scopes remain unrestricted and fan out through that command plan.

Freeze captures current baseline, not output after offsets or overlays. Offsets remain editable while frozen. Unfreeze creates a configurable convergence interval rather than an instantaneous jump.

At configured local time, default `04:00`, one atomic state transition unfreezes every frozen scope through normal smooth convergence and records reset date. Already-following scopes stay FOLLOW; scopes already converging are already unfrozen and continue uninterrupted. Before accepting commands, first startup initializes and persists the latest completed reset marker; later startups compare it with latest scheduled reset so downtime across 04:00 cannot preserve stale freezes.

## Input classification and scopes

Remote mappings translate adapter events into declarative actions. Initial E1810 mapping is up/down brightness offset, left/right warmth offset, center single-click on/off, and center double-click freeze toggle.

Center short-click classification holds first click until the configurable double-click window closes. Second eligible click inside the inclusive boundary emits only double-click. E1524/E1810 `toggle` is classified as a protocol-neutral ambiguous center prefix and uses a separately validated, longer hold window because `toggle_hold` can arrive after the double-click window; the later hold cancels the prefix without emitting a single click. A second prefix after the double-click boundary resolves the first as a single and starts a new sequence. Release is reported separately and never consumes or breaks a pending double click. Tests inject monotonic and wall clocks; no test sleeps.

Actions target configured room, floor, or house scopes. Runtime-selected scope is persisted only when selection is enabled. Normal configurations can map each remote directly to one scope.

## Overlays and reconciliation

Overlays are in-memory layers with key, priority, start, expiry, and replacement policy. Same-key overlays replace deterministically; different keys compose by priority then insertion sequence. Expiry always recomputes from current baseline, offsets, and remaining overlays. Transient overlays never persist.

The hourly example adds a small brightness delta for 500 ms on each whole hour. It never saves/restores a stale target.

Per device, the engine stores desired target, last observed state, availability, last command, and correlation deadline. A command batch is staged under an opaque token; attempts and retry deadlines are recorded only after every MQTT publication in that batch has been accepted by the client. Local encoding/enqueue failures restage without spending the bounded on-wire retry budget, and broker disconnect invalidates unaccepted staged tokens. MQTT reconnect causes resubscription and deterministic reconciliation. Device availability recovery reconciles current desired state. Native Zigbee2MQTT event and command topics remain unchanged; application topics use `house/v1/...`. Subscriptions, reads, and commands use explicit MQTT QoS 1. Input events and commands use `retain=false`; retained or duplicate control events are ignored while retained state and availability remain valid reconciliation input. Observed reports do not mutate user offsets unless a configured input action explicitly does so, preventing report-command oscillation.

## Persistence

SQLite lives in systemd-managed `/var/lib/house-automation/state.sqlite3`. Embedded numbered migrations run transactionally before MQTT starts. Persisted data includes shared scope offsets, durable follow/frozen mode, frozen baseline, per-control runtime-selected scope, power intent, and last completed daily reset. Runtime convergence restores as FOLLOW because it contains boot-relative monotonic time. Ephemeral overlays, connection state, convergence progress, and partial animations are excluded.

## Protocol boundaries

Zigbee2MQTT adapter requires JSON output and parses native action/state/availability payloads with unknown-field/action tolerance. It maps configured friendly names exactly because Zigbee2MQTT names may contain `/`, while rejecting reserved bridge names, MQTT wildcard/control characters, and oversized names. E1524/E1810 actions are normalized from the documented open action enum; no native double-click is assumed. Capability-specific `/get` payloads request only readable attributes; color is requested with Zigbee2MQTT's nested `color` shape. LED2111G6 brightness maps to `0..254`, Kelvin maps inversely to device mired bounds, and commands/reads are never retained. Devices configured as single-transition-attribute split simultaneous brightness and color-temperature transitions instead of relying on unsupported IKEA behavior; the second operation has an explicit not-before delay equal to the first transition rather than being published back-to-back. HS and XY observations compare through a documented sRGB/D65 approximation with tolerance for device gamut. No vendor model match enters core semantics.

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
