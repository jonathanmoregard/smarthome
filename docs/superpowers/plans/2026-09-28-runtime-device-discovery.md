# Runtime Device Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adding, naming, moving or removing a lamp needs no pull request. `house-automationd` discovers lights from Zigbee2MQTT's retained `bridge/devices` and controls each one as soon as its interview completes. A `house` command (`list`/`show`/`identify`/`rename`/`remove`/`add`) gives operators create, read, update and delete over SSH. The home server runs the daemon with a static topology that has no devices.

**Architecture:** A new pure module, `house-automationd/src/discovery.rs`, does four things: it parses `bridge/devices`, derives `Capabilities` and a `MiredRange` from Z2M `exposes`, reads optional `floor/room/device` placement, and classifies every device against the static topology (static names win). The Zigbee2MQTT adapter gains `bind_device`/`unbind_device` and a `BridgeDevices` inbound event. The core `Reconciler` gains `add_device`/`remove_device`. `HouseEngine::apply_discovery` diffs each device list against the one before it. For each device it does one of three things: adopts it, releases it, or rebinds it (release and then adopt, carrying availability). A rebind drops every staged or deferred dispatch for the old name, so a renamed lamp is never commanded under its old name. Every discovered light is owned by the most specific declared scope: room, then floor, then a house scope. If the TOML declares no house scope, the house scope is synthesized from the new top-level `default_curve`. With discovery on, scopes that have no persisted state start **on**, so new lamps follow the curve at once. `/healthz` gains `discovery: disabled|pending|synced`. A new sibling route `/devices` on the same loopback listener lists placement, owner, target and not-controlled reason; device names stay out of `/healthz`. `house` is a Bash `writeShellApplication` like `pair-zigbee`. It opens one SSH connection that forwards two Unix sockets, one to Mosquitto and one to the daemon's status listener, and `house add` calls `pair-zigbee --stop-after-first --paired-file`.

**Tech Stack:** Rust 2024 (tokio, serde_json, axum, rumqttc 0.25), Bash + OpenSSH + mosquitto clients + jq + curl, NixOS test driver, Python paho-mqtt (fake bridge). Spec: `docs/superpowers/specs/2026-09-28-runtime-devices-design.md`.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `house-automation-core/src/reconcile.rs` | modify | `Reconciler::add_device` / `remove_device`, `ReconcileError::GroupMemberRemoval` |
| `house-automation-core/src/state.rs` | modify | `ScopeMembership::room()` / `floor()` getters |
| `house-automationd/src/discovery.rs` | create | Parse `bridge/devices`, derive light capabilities, placement, classification |
| `house-automationd/src/lib.rs` | modify | `pub mod discovery;` |
| `house-automationd/tests/fixtures/bridge-devices.json` | create | Coordinator + IKEA LED2111G6 (`0x7cc6b6fffe3cef1c`) + E1810 remote |
| `house-automationd/tests/fixtures/README.md` | modify | Document the bridge-devices fixture |
| `house-automationd/tests/discovery.rs` | create | Pure invariants: mired-inside range, placement, classification |
| `house-automationd/src/config.rs` | modify | `default_curve`, `rooms` in `RuntimeConfigParts`, empty topology valid with discovery |
| `house-automationd/tests/config.rs` | modify | Empty topology valid only with discovery |
| `nixos/hosts/home-server/house.toml` | modify | `default_curve = "home-day"` |
| `house-automationd/src/zigbee2mqtt.rs` | modify | Discovery subscription, `BridgeDevices` event, runtime bind/unbind |
| `house-automationd/src/mqtt.rs` | modify | Raise incoming MQTT packet limit for `bridge/devices` |
| `house-automationd/src/health.rs` | modify | `DiscoveryStatus`, `DeviceReport`, `/devices` route |
| `house-automationd/src/runtime.rs` | modify | Engine discovery (adopt/release/rebind), synthesized house scope, idle with no devices, actor wiring |
| `house-automationd/tests/discovery_runtime.rs` | create | Actor-level: follow curve on join, rename never commands old name, removal stops commands, static wins |
| `nix/tests/fake-zigbee2mqtt.py` | modify | Retained device list, rename/remove/options, `/get` `/set`, identify log |
| `nix/pair-zigbee.sh` | modify | `--stop-after-first`, `--paired-file` |
| `nix/tests/pair-zigbee.nix` | modify | Subtest for the new flags |
| `nix/house.sh` | create | The `house` operator command |
| `nix/house.nix` | create | `writeShellApplication` packaging |
| `nix/tests/house.nix` | create | VM test: discovery, rename, identify, remove, add against the fake bridge |
| `flake.nix` | modify | `packages.house`, `apps.house`, `checks.house` |
| `nixos/hosts/home-server/default.nix` | modify | `homeServer.houseSettings = fromTOML house.toml` |
| `nixos/modules/home-server-services.nix` | modify | Assertion: Z2M device/group files stay `devices.yaml`/`groups.yaml` |
| `nixos/tests/home-server-services.nix`, `nixos/tests/home-server.nix`, `nixos/tests/fixtures/home-server-cd-module.nix` | modify | Tests that override the host's `houseSettings` use `mkForce`; eval guard for the assertion |
| `README.md` | modify | "Add a room, light, or control" describes the no-PR flow |

`.claude/skills/pair-zigbee-device/SKILL.md` is already updated on the branch (commit `5205f74`) and is not changed by this plan.

---

### Task 1: Reconciler can add and remove devices at runtime

**Files:**
- Modify: `house-automation-core/src/reconcile.rs:765-781` (insert after `force_reconcile_devices`), `:1768-1798` (enum), `:1800-1873` (Display), `:1886-1891` (test imports), test module end

- [ ] **Step 1: Write failing tests** (append inside `mod tests`, and add `ReconcileError` to the `use super::{...}` list)

```rust
    #[test]
    fn removed_device_is_never_commanded_again() {
        let mut reconciler = connected_reconciler(vec![
            DeviceDefinition::new(id("a"), capabilities()),
            DeviceDefinition::new(id("b"), capabilities()),
        ]);
        let staged = reconciler
            .set_device_desired(&id("a"), target(0.4), at(1.0))
            .unwrap();
        let token = staged
            .iter()
            .find_map(|action| match action {
                ReconcileAction::Command { token, .. } => Some(*token),
                _ => None,
            })
            .expect("an online device is commanded");
        reconciler
            .set_device_desired(&id("b"), target(0.6), at(1.0))
            .unwrap();

        reconciler.remove_device(&id("a"), at(2.0)).unwrap();

        assert!(!reconciler.is_dispatch_token_valid(token));
        assert!(reconciler.device_state(&id("a")).is_err());
        let mut later = reconciler.retry_due(at(60.0)).unwrap();
        reconciler.broker_disconnected(at(61.0)).unwrap();
        later.extend(connect_with_online_bridge(&mut reconciler, 62.0));
        assert!(later.iter().all(|action| match action {
            ReconcileAction::RequestState(device) => device != &id("a"),
            ReconcileAction::Command { entity, .. } => {
                entity != &CommandEntity::Device(id("a"))
            }
            ReconcileAction::Resubscribe => true,
        }));
        assert!(later.iter().any(|action| matches!(
            action,
            ReconcileAction::Command { entity: CommandEntity::Device(device), .. }
                if device == &id("b")
        )));
    }

    #[test]
    fn added_device_waits_for_availability_then_reconciles() {
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(id("a"), capabilities())]);

        let added = reconciler
            .add_device(DeviceDefinition::new(id("new"), capabilities()), at(1.0))
            .unwrap();

        assert_eq!(added, vec![ReconcileAction::RequestState(id("new"))]);
        assert!(
            reconciler
                .set_device_desired(&id("new"), target(0.5), at(2.0))
                .unwrap()
                .is_empty()
        );
        let online = reconciler
            .set_device_availability(&id("new"), Availability::Online, at(3.0))
            .unwrap();
        assert!(matches!(
            online.as_slice(),
            [ReconcileAction::Command { entity: CommandEntity::Device(device), .. }]
                if device == &id("new")
        ));
        assert!(matches!(
            reconciler.add_device(DeviceDefinition::new(id("new"), capabilities()), at(4.0)),
            Err(ReconcileError::DuplicateDevice(_))
        ));
    }
```

- [ ] **Step 2: Run the tests**

Run: `nix develop -c cargo test -p house-automation-core device_is_never_commanded_again added_device_waits`
Expected: FAIL to compile with `error[E0599]: no method named 'remove_device'` and `no method named 'add_device'`.

- [ ] **Step 3: Implement.** Insert after `force_reconcile_devices`:

```rust
    /// Starts tracking a device discovered at runtime.
    ///
    /// Availability starts unknown, so nothing is commanded until
    /// Zigbee2MQTT reports the device online. A connected reconciler asks for
    /// its current state immediately.
    pub fn add_device(
        &mut self,
        definition: DeviceDefinition,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, _| {
            let id = definition.id.clone();
            match next.devices.entry(id.clone()) {
                btree_map::Entry::Occupied(_) => return Err(ReconcileError::DuplicateDevice(id)),
                btree_map::Entry::Vacant(slot) => {
                    slot.insert(DeviceState::new(
                        definition.capabilities,
                        definition.color_policy,
                    ));
                }
            }
            if next.transport == TransportStatus::Connected {
                Ok(vec![ReconcileAction::RequestState(id)])
            } else {
                Ok(Vec::new())
            }
        })
    }

    /// Stops tracking a device and drops all of its reconciliation state.
    ///
    /// Work staged together with other devices is restaged for them alone, so
    /// no publication for the removed device can still be claimed.
    pub fn remove_device(
        &mut self,
        id: &DeviceId,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            if !next.devices.contains_key(id) {
                return Err(ReconcileError::UnknownDevice(id.clone()));
            }
            if next
                .groups
                .values()
                .any(|group| group.definition.members.contains(id))
            {
                return Err(ReconcileError::GroupMemberRemoval(id.clone()));
            }
            let mut canceled = next.cancel_work_for_device(id);
            canceled.remove(id);
            next.devices.remove(id);
            next.stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now)
        })
    }
```

Add the variant `GroupMemberRemoval(DeviceId),` after `DeviceInMultipleGroups(DeviceId),` in `ReconcileError`, and this Display arm:

```rust
            Self::GroupMemberRemoval(id) => write!(
                formatter,
                "device {} belongs to a native group and cannot be removed at runtime",
                id.as_str()
            ),
```

- [ ] **Step 4: Run the tests**

Run: `nix develop -c cargo test -p house-automation-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add house-automation-core/src/reconcile.rs
git commit -m "feat(core): add and remove reconciled devices at runtime"
```

### Task 2: Expose room and floor of a membership

**Files:**
- Modify: `house-automation-core/src/state.rs:102-114`

Trivial accessors; no test.

- [ ] **Step 1: Implement.** Inside `impl ScopeMembership`, after `new`:

```rust
    pub fn room(&self) -> &ScopeId {
        &self.room
    }

    pub fn floor(&self) -> &ScopeId {
        &self.floor
    }
```

- [ ] **Step 2: Build**

Run: `nix develop -c cargo build -p house-automation-core`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add house-automation-core/src/state.rs
git commit -m "feat(core): expose scope membership room and floor"
```

### Task 3: Discovery module (parse, derive, place, classify)

**Files:**
- Create: `house-automationd/src/discovery.rs`, `house-automationd/tests/fixtures/bridge-devices.json`, `house-automationd/tests/discovery.rs`
- Modify: `house-automationd/src/lib.rs:1`, `house-automationd/tests/fixtures/README.md`

- [x] **Step 1: Fixture (already committed)**

`house-automationd/tests/fixtures/bridge-devices.json` is a real capture of
home-server's retained `zigbee2mqtt/bridge/devices` (coordinator + the IKEA
LED2111G6 `0x7cc6b6fffe3cef1c`, E12/E14/E17 colour/white spectrum), pretty-
printed with `jq --indent 2`, plus one synthetic E1810 remote
(`0x000d6ffffea1b2c3`) so non-light handling is covered. Do not rewrite it.
The string `"friendly_name": "0x7cc6b6fffe3cef1c"` appears exactly once.

Append to `house-automationd/tests/fixtures/README.md`:

```markdown
`bridge-devices.json` is a retained `zigbee2mqtt/bridge/devices` list in Zigbee2MQTT 2.x shape. It holds a coordinator, the home server's IKEA LED2111G6 bulb (its real IEEE address `0x7cc6b6fffe3cef1c`, which is not secret and names the lamp in operator docs), and an anonymous E1810 remote. The VM check `house` seeds its fake bridge from this file. Reference: <https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html#zigbee2mqtt-bridge-devices>.
```

- [ ] **Step 2: Write the failing tests** `house-automationd/tests/discovery.rs`

```rust
use std::collections::{BTreeMap, BTreeSet};

use house_automation_core::{
    reconcile::DeviceId,
    state::{ScopeId, ScopeMembership},
    value::Capabilities,
};
use house_automationd::{
    discovery::{
        BridgeDevice, DiscoveryError, Disposition, MAX_BRIDGE_DEVICES_BYTES, PlacementNote,
        StaticTopology, UncontrolledReason, classify, derive_light, kelvin_range_inside,
        parse_bridge_devices, placement,
    },
    zigbee2mqtt::{DeviceBinding, MiredRange},
};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/bridge-devices.json");
const BULB: &str = "0x7cc6b6fffe3cef1c";
const REMOTE: &str = "0x000d6ffffea1b2c3";

fn scope(value: &str) -> ScopeId {
    ScopeId::new(value).unwrap()
}

fn bulb_id() -> DeviceId {
    DeviceId::new(BULB).unwrap()
}

fn devices_named(bulb_name: &str) -> Vec<BridgeDevice> {
    let original = format!("\"friendly_name\": \"{BULB}\"");
    assert_eq!(FIXTURE.matches(&original).count(), 1, "fixture drift");
    let renamed = FIXTURE.replace(&original, &format!("\"friendly_name\": \"{bulb_name}\""));
    parse_bridge_devices(renamed.as_bytes()).unwrap()
}

fn on_off_only() -> Capabilities {
    Capabilities {
        on_off: true,
        dimming: false,
        color_temperature: None,
        color_xy: false,
        color_hs: false,
        input: false,
        occupancy: false,
        temperature: false,
        power_metering: false,
    }
}

#[test]
fn derived_kelvin_range_is_inside_every_reported_mired_range() {
    let mut checked = 0;
    for minimum in (50_u16..=1000).step_by(7) {
        for maximum in (minimum..=1000).step_by(13) {
            let mired = MiredRange::new(minimum, maximum).unwrap();
            let Some(kelvin) = kelvin_range_inside(mired) else {
                continue;
            };
            assert!(1_000_000.0 / kelvin.max().get() >= f64::from(minimum), "{mired:?} -> {kelvin:?}");
            assert!(1_000_000.0 / kelvin.min().get() <= f64::from(maximum), "{mired:?} -> {kelvin:?}");
            checked += 1;
        }
    }
    assert!(checked > 1_000);

    for device in devices_named(BULB) {
        let Some(definition) = device.definition.as_ref() else {
            continue;
        };
        let Ok(Some(light)) = derive_light(definition) else {
            continue;
        };
        if let (Some(kelvin), Some(mired)) = (light.capabilities.color_temperature, light.mired_range) {
            assert!(1_000_000.0 / kelvin.max().get() >= f64::from(mired.min()));
            assert!(1_000_000.0 / kelvin.min().get() <= f64::from(mired.max()));
        }
    }
}

#[test]
fn led2111g6_interview_maps_to_a_dimmable_tunable_ikea_light() {
    let devices = devices_named(BULB);
    let bulb = devices.iter().find(|device| device.ieee_address == BULB).unwrap();
    let light = derive_light(bulb.definition.as_ref().unwrap()).unwrap().unwrap();

    assert!(light.capabilities.on_off && light.capabilities.dimming);
    assert!(light.capabilities.color_xy && light.capabilities.color_hs);
    assert_eq!(light.mired_range, Some(MiredRange::new(250, 454).unwrap()));
    assert!(light.single_transition_attribute);
}

#[test]
fn every_accepted_placement_is_a_usable_topic_and_names_its_room() {
    for name in [
        "upper-floor/upper-hallway/lamp",
        "a/b/c",
        "ground_floor/kitchen-2/ceiling_1",
        BULB,
        "Upper/hall/lamp",
        "a/b",
        "a/b/c/d",
        "a//c",
        "a/b/set",
        "a/b/availability",
        "a/b/42",
        "a/b/-lamp",
        "a/b/lamp ",
    ] {
        if let Some(place) = placement(name) {
            let mut segments = name.split('/');
            assert_eq!(segments.next(), Some(place.floor.as_str()));
            assert_eq!(segments.next(), Some(place.room.as_str()));
            assert!(
                DeviceBinding::new(DeviceId::new("probe").unwrap(), name, on_off_only(), None, false).is_ok(),
                "{name} is placed but cannot be an MQTT topic"
            );
        }
    }
    assert!(placement("upper-floor/upper-hallway/lamp").is_some());
    for rejected in [BULB, "Upper/hall/lamp", "a/b/c/d", "a/b/set", "a/b/42"] {
        assert!(placement(rejected).is_none(), "{rejected}");
    }
}

#[test]
fn every_mappable_light_is_controlled_whatever_its_name() {
    let (names, ids, rooms) = (BTreeSet::new(), BTreeSet::new(), BTreeMap::new());
    let topology = StaticTopology { friendly_names: &names, device_ids: &ids, declared_rooms: &rooms };
    for bulb_name in [BULB, "upper-floor/upper-hallway/lamp", "Kitchen lamp", "a/b/c/d"] {
        let discovered = classify(&devices_named(bulb_name), &topology);
        assert!(
            matches!(discovered[&bulb_id()].disposition, Disposition::Controlled(_)),
            "{bulb_name}: {:?}",
            discovered[&bulb_id()].disposition
        );
    }
    let placed = classify(&devices_named("upper-floor/upper-hallway/lamp"), &topology);
    assert_eq!(
        placed[&bulb_id()].membership,
        Some(ScopeMembership::new(scope("upper-hallway"), scope("upper-floor")))
    );
    assert_eq!(classify(&devices_named(BULB), &topology)[&bulb_id()].membership, None);
}

#[test]
fn non_lights_are_listed_but_not_controlled_and_the_coordinator_is_not_listed() {
    let (names, ids, rooms) = (BTreeSet::new(), BTreeSet::new(), BTreeMap::new());
    let topology = StaticTopology { friendly_names: &names, device_ids: &ids, declared_rooms: &rooms };
    let discovered = classify(&devices_named(BULB), &topology);

    assert_eq!(discovered.len(), 2);
    assert_eq!(
        discovered[&DeviceId::new(REMOTE).unwrap()].disposition,
        Disposition::NotControlled(UncontrolledReason::NotALight)
    );
}

#[test]
fn a_static_declaration_wins_and_a_declared_room_keeps_its_floor() {
    let names = BTreeSet::from(["demo/living-room/reading-light".to_owned()]);
    let (no_names, ids) = (BTreeSet::new(), BTreeSet::new());
    let rooms = BTreeMap::from([(scope("upper-hallway"), scope("upper-floor"))]);

    let shadowed = classify(
        &devices_named("demo/living-room/reading-light"),
        &StaticTopology { friendly_names: &names, device_ids: &ids, declared_rooms: &rooms },
    );
    assert_eq!(
        shadowed[&bulb_id()].disposition,
        Disposition::NotControlled(UncontrolledReason::DeclaredStatically)
    );

    let elsewhere = classify(
        &devices_named("ground-floor/upper-hallway/lamp"),
        &StaticTopology { friendly_names: &no_names, device_ids: &ids, declared_rooms: &rooms },
    );
    let bulb = &elsewhere[&bulb_id()];
    assert!(matches!(bulb.disposition, Disposition::Controlled(_)));
    assert_eq!(bulb.membership, None);
    assert_eq!(bulb.note, Some(PlacementNote::RoomDeclaredOnAnotherFloor));
}

#[test]
fn a_light_without_writable_state_is_not_controlled_and_says_why() {
    let mut devices = devices_named(BULB);
    let bulb = devices.iter_mut().find(|device| device.ieee_address == BULB).unwrap();
    let definition = bulb.definition.as_mut().unwrap();
    definition.exposes[0]["features"]
        .as_array_mut()
        .unwrap()
        .retain(|feature| feature["name"] != "state");

    assert_eq!(derive_light(definition), Err(UncontrolledReason::NoWritableState));
}

#[test]
fn a_malformed_entry_does_not_hide_the_rest_but_a_malformed_list_is_rejected() {
    let mut entries: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    entries.push(json!({ "type": "Router" }));

    assert_eq!(parse_bridge_devices(&serde_json::to_vec(&entries).unwrap()).unwrap().len(), 3);
    assert_eq!(parse_bridge_devices(b"{}"), Err(DiscoveryError::Malformed));
    assert_eq!(
        parse_bridge_devices(&vec![b' '; MAX_BRIDGE_DEVICES_BYTES + 1]),
        Err(DiscoveryError::TooLarge)
    );
}
```

- [ ] **Step 3: Run the tests**

Run: `nix develop -c cargo test -p house-automationd --test discovery`
Expected: FAIL to compile with `error[E0432]: unresolved import house_automationd::discovery`.

- [ ] **Step 4: Implement** `house-automationd/src/discovery.rs`

```rust
//! Runtime device discovery from Zigbee2MQTT's retained `bridge/devices`.
//!
//! Pure functions only; the runtime decides what to do with the result. Every
//! mappable light is controlled whatever its name. A `floor/room/device` name
//! only adds room membership, for remotes and per-room overrides.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

use house_automation_core::{
    reconcile::DeviceId,
    state::{ScopeId, ScopeMembership},
    value::{Capabilities, KelvinRange},
};
use serde::Deserialize;
use serde_json::Value;

use crate::zigbee2mqtt::MiredRange;

/// Largest accepted `bridge/devices` payload; the MQTT incoming limit.
pub const MAX_BRIDGE_DEVICES_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BridgeDevice {
    pub ieee_address: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub friendly_name: String,
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default = "interview_completed_default")]
    pub interview_completed: bool,
    #[serde(default)]
    pub definition: Option<BridgeDefinition>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BridgeDefinition {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub exposes: Vec<Value>,
}

fn interview_completed_default() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryError {
    TooLarge,
    Malformed,
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge => write!(formatter, "device list exceeds {MAX_BRIDGE_DEVICES_BYTES} bytes"),
            Self::Malformed => formatter.write_str("device list is not a JSON array"),
        }
    }
}

impl Error for DiscoveryError {}

/// Parses the device list. Entries that do not parse are skipped so one
/// malformed device cannot hide the rest.
pub fn parse_bridge_devices(payload: &[u8]) -> Result<Vec<BridgeDevice>, DiscoveryError> {
    if payload.len() > MAX_BRIDGE_DEVICES_BYTES {
        return Err(DiscoveryError::TooLarge);
    }
    let entries: Vec<Value> =
        serde_json::from_slice(payload).map_err(|_| DiscoveryError::Malformed)?;
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DerivedLight {
    pub capabilities: Capabilities,
    pub mired_range: Option<MiredRange>,
    pub single_transition_attribute: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UncontrolledReason {
    NotALight,
    Unsupported,
    InterviewIncomplete,
    Disabled,
    MultiEndpointLight,
    NoWritableState,
    BrightnessRangeUnsupported,
    ColorTemperatureRangeUnsupported,
    DeclaredStatically,
    IdentifierClash,
    TopicUnusable,
}

impl UncontrolledReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotALight => "not a light; only lights are controlled",
            Self::Unsupported => "Zigbee2MQTT does not support this model",
            Self::InterviewIncomplete => "Zigbee2MQTT has not finished identifying it",
            Self::Disabled => "disabled in Zigbee2MQTT",
            Self::MultiEndpointLight => "light has several endpoints; not supported yet",
            Self::NoWritableState => "light exposes no writable on/off state",
            Self::BrightnessRangeUnsupported => "brightness range is not 0..254",
            Self::ColorTemperatureRangeUnsupported => "colour temperature range is not usable",
            Self::DeclaredStatically => "declared in house.toml; the static entry wins",
            Self::IdentifierClash => "its address clashes with a house.toml device id",
            Self::TopicUnusable => "its name cannot be used as an MQTT topic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementNote {
    RoomDeclaredOnAnotherFloor,
}

impl PlacementNote {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RoomDeclaredOnAnotherFloor => {
                "house.toml declares this room on another floor; the device has no room"
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Disposition {
    Controlled(DerivedLight),
    NotControlled(UncontrolledReason),
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredDevice {
    pub friendly_name: String,
    pub vendor: Option<String>,
    pub model: Option<String>,
    pub membership: Option<ScopeMembership>,
    pub note: Option<PlacementNote>,
    pub disposition: Disposition,
}

impl DiscoveredDevice {
    pub fn light(&self) -> Option<&DerivedLight> {
        match &self.disposition {
            Disposition::Controlled(light) => Some(light),
            Disposition::NotControlled(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub floor: ScopeId,
    pub room: ScopeId,
}

/// Reads `<floor>/<room>/<device>`; any other name has no room.
pub fn placement(friendly_name: &str) -> Option<Placement> {
    let mut segments = friendly_name.split('/');
    let (Some(floor), Some(room), Some(device), None) =
        (segments.next(), segments.next(), segments.next(), segments.next())
    else {
        return None;
    };
    DeviceId::new(device).ok()?;
    if matches!(device, "set" | "get" | "availability" | "left" | "right")
        || device.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(Placement {
        floor: ScopeId::new(floor).ok()?,
        room: ScopeId::new(room).ok()?,
    })
}

/// Kelvin bounds for a mired range, rounded inward so every Kelvin value in
/// the result converts to a mired value the bulb accepts.
pub fn kelvin_range_inside(mired: MiredRange) -> Option<KelvinRange> {
    let minimum = (1_000_000.0 / f64::from(mired.max())).ceil();
    let maximum = (1_000_000.0 / f64::from(mired.min())).floor();
    KelvinRange::new(minimum, maximum).ok()
}

/// Maps a definition's `exposes`; `Ok(None)` means it is not a light.
pub fn derive_light(
    definition: &BridgeDefinition,
) -> Result<Option<DerivedLight>, UncontrolledReason> {
    let lights: Vec<&Value> = definition
        .exposes
        .iter()
        .filter(|expose| expose.get("type").and_then(Value::as_str) == Some("light"))
        .collect();
    let light = match lights.as_slice() {
        [] => return Ok(None),
        [light] => *light,
        _ => return Err(UncontrolledReason::MultiEndpointLight),
    };
    if light.get("endpoint").is_some() {
        return Err(UncontrolledReason::MultiEndpointLight);
    }
    let features = light
        .get("features")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let feature = |name: &str| {
        features
            .iter()
            .find(|feature| feature.get("name").and_then(Value::as_str) == Some(name))
    };
    let writable = |feature: &&Value| {
        feature
            .get("access")
            .and_then(Value::as_u64)
            .is_some_and(|access| access & 2 != 0)
    };
    let property_is = |feature: &Value, property: &str| {
        feature.get("property").and_then(Value::as_str) == Some(property)
    };
    let number = |feature: &Value, key: &str| feature.get(key).and_then(Value::as_u64);

    feature("state")
        .filter(writable)
        .filter(|state| property_is(state, "state"))
        .ok_or(UncontrolledReason::NoWritableState)?;
    let dimming = match feature("brightness").filter(writable) {
        None => false,
        Some(brightness)
            if property_is(brightness, "brightness")
                && number(brightness, "value_min") == Some(0)
                && number(brightness, "value_max") == Some(254) =>
        {
            true
        }
        Some(_) => return Err(UncontrolledReason::BrightnessRangeUnsupported),
    };
    let (color_temperature, mired_range) = match feature("color_temp").filter(writable) {
        None => (None, None),
        Some(color_temp) => {
            let unit_is_mired = color_temp
                .get("unit")
                .and_then(Value::as_str)
                .is_none_or(|unit| unit == "mired");
            let bounds = number(color_temp, "value_min")
                .zip(number(color_temp, "value_max"))
                .and_then(|(min, max)| u16::try_from(min).ok().zip(u16::try_from(max).ok()));
            let mired = bounds
                .filter(|_| unit_is_mired && property_is(color_temp, "color_temp"))
                .and_then(|(min, max)| MiredRange::new(min, max).ok())
                .ok_or(UncontrolledReason::ColorTemperatureRangeUnsupported)?;
            let kelvin = kelvin_range_inside(mired)
                .ok_or(UncontrolledReason::ColorTemperatureRangeUnsupported)?;
            (Some(kelvin), Some(mired))
        }
    };
    let capabilities = Capabilities {
        on_off: true,
        dimming,
        color_temperature,
        color_xy: feature("color_xy").is_some_and(|f| writable(&f)),
        color_hs: feature("color_hs").is_some_and(|f| writable(&f)),
        input: false,
        occupancy: false,
        temperature: false,
        power_metering: false,
    };
    Ok(Some(DerivedLight {
        capabilities,
        mired_range,
        single_transition_attribute: definition.vendor == "IKEA"
            && dimming
            && color_temperature.is_some(),
    }))
}

/// Static configuration that discovery must not override.
pub struct StaticTopology<'a> {
    pub friendly_names: &'a BTreeSet<String>,
    pub device_ids: &'a BTreeSet<DeviceId>,
    /// Declared room -> its floor.
    pub declared_rooms: &'a BTreeMap<ScopeId, ScopeId>,
}

/// Classifies every non-coordinator device, keyed by IEEE address.
pub fn classify(
    devices: &[BridgeDevice],
    topology: &StaticTopology<'_>,
) -> BTreeMap<DeviceId, DiscoveredDevice> {
    let mut discovered = BTreeMap::new();
    for device in devices {
        if device.kind == "Coordinator" {
            continue;
        }
        let Ok(id) = DeviceId::new(device.ieee_address.to_ascii_lowercase()) else {
            continue;
        };
        let (membership, note) = match placement(&device.friendly_name) {
            None => (None, None),
            Some(place) => match topology.declared_rooms.get(&place.room) {
                Some(floor) if floor != &place.floor => {
                    (None, Some(PlacementNote::RoomDeclaredOnAnotherFloor))
                }
                _ => (Some(ScopeMembership::new(place.room, place.floor)), None),
            },
        };
        let disposition = if topology.friendly_names.contains(&device.friendly_name) {
            Disposition::NotControlled(UncontrolledReason::DeclaredStatically)
        } else if topology.device_ids.contains(&id) {
            Disposition::NotControlled(UncontrolledReason::IdentifierClash)
        } else {
            match light_of(device) {
                Ok(light) => Disposition::Controlled(light),
                Err(reason) => Disposition::NotControlled(reason),
            }
        };
        discovered.insert(
            id,
            DiscoveredDevice {
                friendly_name: device.friendly_name.clone(),
                vendor: device.definition.as_ref().map(|definition| definition.vendor.clone()),
                model: device.definition.as_ref().map(|definition| definition.model.clone()),
                membership,
                note,
                disposition,
            },
        );
    }
    discovered
}

fn light_of(device: &BridgeDevice) -> Result<DerivedLight, UncontrolledReason> {
    if device.disabled {
        return Err(UncontrolledReason::Disabled);
    }
    if !device.interview_completed {
        return Err(UncontrolledReason::InterviewIncomplete);
    }
    let Some(definition) = device.definition.as_ref().filter(|_| device.supported) else {
        return Err(UncontrolledReason::Unsupported);
    };
    if !matches!(device.kind.as_str(), "Router" | "EndDevice") {
        return Err(UncontrolledReason::NotALight);
    }
    derive_light(definition)?.ok_or(UncontrolledReason::NotALight)
}
```

Add `pub mod discovery;` to `house-automationd/src/lib.rs`, in alphabetical order after `pub mod config;`.

- [ ] **Step 5: Run the tests**

Run: `nix develop -c cargo test -p house-automationd --test discovery`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add house-automationd/src/discovery.rs house-automationd/src/lib.rs house-automationd/tests/discovery.rs house-automationd/tests/fixtures/bridge-devices.json house-automationd/tests/fixtures/README.md
git commit -m "feat(daemon): classify Zigbee2MQTT devices for runtime discovery"
```

### Task 4: `default_curve` and an empty static topology in configuration

**Files:**
- Modify: `house-automationd/src/config.rs:100-111` (accessor), `:130-147` (`RuntimeConfigParts`), `:303-329` (`RawConfig`), `:657-720` (`validate`), `:1042-1078` (floors/rooms), `:1265-1271` (devices), `:1446-1516` (scopes), `:1518-1526` and `:1600-1615` (controls)
- Modify: `house-automationd/src/runtime.rs:116-133` (destructuring only)
- Modify: `nixos/hosts/home-server/house.toml:1`
- Test: `house-automationd/tests/config.rs`

- [ ] **Step 1: Write the failing test** (append to `house-automationd/tests/config.rs`)

```rust
#[test]
fn an_empty_static_topology_is_valid_only_with_discovery() {
    let production = ValidatedConfig::parse(PRODUCTION).unwrap();
    assert!(production.device_discovery());
    assert_eq!(production.device_count(), 0);
    assert_eq!(production.control_count(), 0);

    let without_discovery = replace(PRODUCTION, "default_curve = \"home-day\"\n", "");
    assert!(reject(&without_discovery).contains("must not be empty"));

    let unknown_curve = replace(
        PRODUCTION,
        "default_curve = \"home-day\"",
        "default_curve = \"missing-curve\"",
    );
    assert_eq!(reject(&unknown_curve), "invalid default_curve: references unknown curve");
}
```

- [ ] **Step 2: Run the tests**

Run: `nix develop -c cargo test -p house-automationd --test config`
Expected: FAIL. `production_topology_validates` fails with `devices must not be empty`, and the new test fails to compile (`no method named 'device_discovery'`).

- [ ] **Step 3: Implement.**

In `house.toml`, insert on line 2, directly after `schema_version = 1`:

```toml
default_curve = "home-day"
```

In `RuntimeConfigParts`, after `pub curves: BTreeMap<ScopeId, CircadianSchedule>,` add:

```rust
    /// Curve for the house scope discovery synthesizes; `Some` enables discovery.
    pub default_curve: Option<ScopeId>,
    /// Declared room -> its floor.
    pub rooms: BTreeMap<ScopeId, ScopeId>,
```

Add to `impl ValidatedConfig`:

```rust
    pub fn device_discovery(&self) -> bool {
        self.parts.default_curve.is_some()
    }
```

In `RawConfig`, add `default_curve: Option<String>,` after `schema_version: u32,`. Add `#[serde(default)]` above `floors`, `rooms`, `scopes`, `devices` and `controls`.

In `RawConfig::validate`, replace the lines from `let floors = validate_floors(self.floors)?;` through `validate_controls(...)` with:

```rust
        let curves = validate_curves(self.curves, location.as_ref())?;
        let default_curve = self
            .default_curve
            .map(|raw| {
                let id = scope_id(raw, "default_curve")?;
                if curves.contains_key(&id) {
                    Ok(id)
                } else {
                    Err(ConfigError::validation("default_curve", "references unknown curve"))
                }
            })
            .transpose()?;
        // Discovery fills the topology at runtime, so an empty static topology
        // is valid only when it is enabled.
        let discovery = default_curve.is_some();
        let floors = validate_floors(self.floors, discovery)?;
        let rooms = validate_rooms(self.rooms, &floors, discovery)?;
        let (devices, device_caps, device_ids, aliases, device_bindings) =
            validate_devices(self.devices, &rooms, discovery)?;
        let (groups, group_bindings) = validate_groups(self.groups, &device_caps, &device_ids)?;
        let scopes = validate_scopes(self.scopes, &floors, &rooms, &curves, &devices, discovery)?;
        let (controls, control_bindings) =
            validate_controls(self.controls, &scopes, &devices, aliases, discovery)?;
```

In the returned `RuntimeConfigParts { .. }`, add `default_curve,` and `rooms,` after `curves,`.

Change these signatures and empty checks:

- `fn validate_floors(raw: Vec<RawFloor>, discovery: bool)`: `if raw.is_empty() && !discovery {`
- `fn validate_rooms(raw: Vec<RawRoom>, floors: &BTreeSet<ScopeId>, discovery: bool)`: `if raw.is_empty() && !discovery {`
- `fn validate_devices(raw: Vec<RawDevice>, rooms: &BTreeMap<ScopeId, ScopeId>, discovery: bool)`: `if raw.is_empty() && !discovery {`
- `fn validate_scopes(..., devices: &[DeviceConfiguration], discovery: bool)`: `if raw.is_empty() && !discovery {` and `if member_count == 0 && !discovery {`
- `fn validate_controls(..., mut all_names: BTreeSet<String>, discovery: bool)`: `if raw.is_empty() && !discovery {` and `if !supported && !discovery {`

In `runtime.rs` `HouseEngine::initialize`, add `default_curve: _,` and `rooms: _,` after `curves: configured_curves,` in the `RuntimeConfigParts { .. }` pattern. Task 8 uses both fields.

- [ ] **Step 4: Run the tests**

Run: `nix develop -c cargo test -p house-automationd`
Expected: PASS, including `production_topology_validates` and the existing strict-topology tests.

- [ ] **Step 5: Commit**

```bash
git add house-automationd/src/config.rs house-automationd/src/runtime.rs house-automationd/tests/config.rs nixos/hosts/home-server/house.toml
git commit -m "feat(config): default_curve enables discovery and an empty static topology"
```

### Task 5: Adapter binds devices at runtime and emits the device list

**Files:**
- Modify: `house-automationd/src/zigbee2mqtt.rs:217-224` (struct), `:287-293` (constructor tail), `:296-331` (`parse`), `:333-352` (`subscriptions`), after `:479` (new methods), `:849-869` (`InboundEvent`), test module
- Modify: `house-automationd/src/config.rs:688-699` (enable discovery on the adapter)
- Modify: `house-automationd/src/runtime.rs:1115` (temporary match arm)

- [ ] **Step 1: Write the failing tests** (append inside `mod tests` in `zigbee2mqtt.rs`)

```rust
    #[test]
    fn rebinding_a_device_moves_every_topic_to_the_new_name() {
        let mut adapter = adapter(false);
        let command = [ReconcileAction::Command {
            token: dispatch_token(),
            entity: CommandEntity::Device(device_id("ikea_lamp")),
            target: command_target(),
        }];

        assert!(adapter.unbind_device(&device_id("ikea_lamp")));
        assert!(adapter.apply_actions(plan_epoch(), &command).unwrap_err().is_permanent());
        let subscriptions = adapter
            .bind_device(
                DeviceBinding::new(
                    device_id("ikea_lamp"),
                    "upstairs/hall/lamp",
                    capabilities(),
                    Some(MiredRange::new(250, 454).unwrap()),
                    false,
                )
                .unwrap(),
            )
            .unwrap();

        let topics: Vec<_> = subscriptions.iter().map(|subscription| subscription.topic()).collect();
        assert_eq!(topics, ["zigbee2mqtt/upstairs/hall/lamp", "zigbee2mqtt/upstairs/hall/lamp/availability"]);
        for old in ["zigbee2mqtt/living/ikea lamp", "zigbee2mqtt/living/ikea lamp/availability"] {
            assert_eq!(parse(&adapter, old, br#"{"state":"ON"}"#).unwrap(), None);
        }
        assert!(matches!(
            parse(&adapter, "zigbee2mqtt/upstairs/hall/lamp", br#"{"state":"ON"}"#).unwrap(),
            Some(InboundEvent::DeviceState { .. })
        ));
        let plan = adapter.apply_actions(plan_epoch(), &command).unwrap();
        assert!(publications(&plan).iter().all(|publication| publication.topic() == "zigbee2mqtt/upstairs/hall/lamp/set"));
        for taken in ["living/hue lamp", "living/all lights", "living/remote"] {
            let binding = DeviceBinding::new(device_id("intruder"), taken, capabilities(), Some(MiredRange::new(250, 454).unwrap()), false).unwrap();
            assert!(adapter.bind_device(binding).is_err(), "{taken}");
        }
        assert!(adapter.friendly_names().contains("living/remote"));
    }

    #[test]
    fn bridge_device_list_is_an_event_only_when_discovery_is_enabled() {
        let payload = include_bytes!("../tests/fixtures/bridge-devices.json");
        assert_eq!(parse(&adapter(false), "zigbee2mqtt/bridge/devices", payload).unwrap(), None);

        let discovering = adapter(false).with_device_discovery();

        assert!(matches!(
            parse(&discovering, "zigbee2mqtt/bridge/devices", payload).unwrap(),
            Some(InboundEvent::BridgeDevices(devices)) if devices.len() == 3
        ));
        assert!(discovering.subscriptions().iter().any(|subscription| subscription.topic() == "zigbee2mqtt/bridge/devices"));
        assert!(!parse(&discovering, "zigbee2mqtt/bridge/devices", b"not json").unwrap_err().is_permanent());
    }
```

- [ ] **Step 2: Run the tests**

Run: `nix develop -c cargo test -p house-automationd --lib zigbee2mqtt`
Expected: FAIL to compile (`no method named 'unbind_device'`, `no variant BridgeDevices`).

- [ ] **Step 3: Implement.**

Add `device_discovery: bool,` as the last field of `Zigbee2MqttAdapter`, and `device_discovery: false,` in the `Ok(Self { .. })` of `new`.

At the top of `parse`, after `let payload = message.payload;`:

```rust
        if self.device_discovery && topic == format!("{}/bridge/devices", self.base_topic) {
            return crate::discovery::parse_bridge_devices(payload)
                .map(|devices| Some(InboundEvent::BridgeDevices(devices)))
                .map_err(|error| AdapterError::message(topic, error.to_string()));
        }
```

In `subscriptions`, before `for (topic, binding) in &self.state_topics`:

```rust
        if self.device_discovery {
            topics.insert(format!("{}/bridge/devices", self.base_topic), Qos::AtLeastOnce);
        }
```

Add these methods to `impl Zigbee2MqttAdapter`, after `apply_actions`:

```rust
    /// Also subscribes to and parses Zigbee2MQTT's retained device list.
    pub fn with_device_discovery(mut self) -> Self {
        self.device_discovery = true;
        self
    }

    pub fn device_discovery(&self) -> bool {
        self.device_discovery
    }

    /// Every friendly name currently bound to a device, control or group.
    pub fn friendly_names(&self) -> BTreeSet<String> {
        let controls = self.state_topics.values().filter_map(|binding| match binding {
            StateBinding::Control(control) => Some(control.friendly_name.clone()),
            StateBinding::Device(_) => None,
        });
        self.devices
            .values()
            .map(|binding| binding.friendly_name.clone())
            .chain(controls)
            .chain(self.groups.values().map(|binding| binding.friendly_name.clone()))
            .collect()
    }

    pub fn device_friendly_name(&self, id: &DeviceId) -> Option<&str> {
        self.devices.get(id).map(|binding| binding.friendly_name.as_str())
    }

    /// Binds a device discovered at runtime and returns the subscriptions it
    /// needs. A name or topic collision changes nothing.
    pub fn bind_device(&mut self, binding: DeviceBinding) -> Result<Vec<Subscription>, AdapterError> {
        let state_topic = format!("{}/{}", self.base_topic, binding.friendly_name);
        let availability_topic = format!("{state_topic}/availability");
        if self.devices.contains_key(&binding.id)
            || self.state_topics.contains_key(&state_topic)
            || self.state_topics.contains_key(&availability_topic)
            || self.availability_topics.contains_key(&state_topic)
            || self.availability_topics.contains_key(&availability_topic)
            || self.groups.values().any(|group| group.friendly_name == binding.friendly_name)
        {
            return Err(AdapterError::configuration(
                "duplicate or reserved Zigbee2MQTT device binding",
            ));
        }
        self.state_topics.insert(state_topic.clone(), StateBinding::Device(binding.clone()));
        self.availability_topics.insert(availability_topic.clone(), binding.clone());
        self.devices.insert(binding.id.clone(), binding);
        Ok(vec![
            Subscription::new(state_topic, Qos::AtLeastOnce),
            Subscription::new(availability_topic, Qos::AtLeastOnce),
        ])
    }

    /// Forgets a device binding; later messages on its topics are ignored and
    /// commands for it are refused.
    pub fn unbind_device(&mut self, id: &DeviceId) -> bool {
        let Some(binding) = self.devices.remove(id) else {
            return false;
        };
        let state_topic = format!("{}/{}", self.base_topic, binding.friendly_name);
        self.availability_topics.remove(&format!("{state_topic}/availability"));
        self.state_topics.remove(&state_topic);
        true
    }
```

Add this variant to `InboundEvent`:

```rust
    BridgeDevices(Vec<crate::discovery::BridgeDevice>),
```

In `config.rs` `RawConfig::validate`, change `let zigbee2mqtt = Zigbee2MqttAdapter::new(` to `let mut zigbee2mqtt = Zigbee2MqttAdapter::new(`, and after its `.map_err(...)?;` add:

```rust
        if discovery {
            zigbee2mqtt = zigbee2mqtt.with_device_discovery();
        }
```

In `runtime.rs` `handle_inbound`, add this arm next to `InboundEvent::UnknownInputAction { .. } => Vec::new(),`. Task 8 replaces it:

```rust
            InboundEvent::BridgeDevices(_) => Vec::new(),
```

- [ ] **Step 4: Run the tests**

Run: `nix develop -c cargo test -p house-automationd`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add house-automationd/src/zigbee2mqtt.rs house-automationd/src/config.rs house-automationd/src/runtime.rs
git commit -m "feat(adapter): bind devices at runtime and parse bridge/devices"
```

### Task 6: MQTT accepts the device list

**Files:**
- Modify: `house-automationd/src/mqtt.rs:490-511`, test module (after `:1094`)

rumqttc's default incoming limit is 10 KiB. A bigger `bridge/devices` payload would break the connection on every reconnect.

- [ ] **Step 1: Write the failing test** (after `transport_uses_a_clean_session_...`)

```rust
    #[test]
    fn transport_accepts_the_largest_device_list_discovery_parses() {
        let settings =
            crate::config::ValidatedConfig::parse(include_str!("../../examples/house.toml"))
                .unwrap()
                .into_runtime_parts()
                .mqtt;

        let options = super::build_mqtt_options(&settings, None);

        assert!(options.max_packet_size() >= crate::discovery::MAX_BRIDGE_DEVICES_BYTES);
    }
```

- [ ] **Step 2: Run the test**

Run: `nix develop -c cargo test -p house-automationd --lib transport_accepts_the_largest`
Expected: FAIL (`10240 >= 4194304` assertion).

- [ ] **Step 3: Implement.** In `build_mqtt_options`, after `options.set_clean_session(true);`:

```rust
    // Zigbee2MQTT's retained device list carries every device's exposes and
    // outgrows rumqttc's 10 KiB default; outgoing commands stay small.
    options.set_max_packet_size(crate::discovery::MAX_BRIDGE_DEVICES_BYTES, 10 * 1024);
```

- [ ] **Step 4: Run the test**

Run: `nix develop -c cargo test -p house-automationd --lib transport_accepts_the_largest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add house-automationd/src/mqtt.rs
git commit -m "fix(mqtt): accept Zigbee2MQTT device lists above 10 KiB"
```

### Task 7: Discovery status and device reports on the status listener

**Files:**
- Modify: `house-automationd/src/health.rs` (whole file)

- [ ] **Step 1: Write the failing test.** In `mod tests`, rename `request` to `request_path(address, path)` and keep `request(address)` as a wrapper. Then add:

```rust
    async fn request(address: std::net::SocketAddr) -> String {
        request_path(address, "/healthz").await
    }

    async fn request_path(address: std::net::SocketAddr, path: &'static str) -> String {
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            write!(stream, "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn device_names_are_served_only_on_the_devices_route() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(HealthState::new());
        state.set_discovery(
            DiscoveryStatus::Synced,
            vec![DeviceReport {
                id: "0x7cc6b6fffe3cef1c".to_owned(),
                friendly_name: "upper-floor/upper-hallway/lamp".to_owned(),
                source: DeviceSource::Discovered,
                vendor: Some("IKEA".to_owned()),
                model: Some("LED2111G6".to_owned()),
                floor: Some("upper-floor".to_owned()),
                room: Some("upper-hallway".to_owned()),
                owner: Some("room upper-hallway".to_owned()),
                controlled: true,
                reason: None,
                note: None,
                target: Some(TargetReport {
                    on: true,
                    brightness_percent: Some(62),
                    color_temperature_kelvin: Some(2900),
                }),
            }],
        );
        let (shutdown, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(serve(listener, state.clone(), async {
            let _ = receiver.await;
        }));

        let health = request_path(address, "/healthz").await;
        assert!(health.contains("\"discovery\":\"synced\""), "{health}");
        assert!(!health.contains("upper-hallway"), "{health}");
        let devices = request_path(address, "/devices").await;
        assert!(devices.starts_with("HTTP/1.1 200"), "{devices}");
        assert!(devices.contains("\"friendly_name\":\"upper-floor/upper-hallway/lamp\""), "{devices}");

        let _ = shutdown.send(());
        task.await.unwrap().unwrap();
    }
```

Change the test imports to `use super::{DeviceReport, DeviceSource, DiscoveryStatus, HealthState, TargetReport, serve};`.

- [ ] **Step 2: Run the test**

Run: `nix develop -c cargo test -p house-automationd --lib health`
Expected: FAIL to compile (`cannot find type DiscoveryStatus`).

- [ ] **Step 3: Implement.** Add `use house_automation_core::value::LightTarget;` and these types after the imports:

```rust
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryStatus {
    #[default]
    Disabled,
    Pending,
    Synced,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceSource {
    Static,
    Discovered,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct TargetReport {
    pub on: bool,
    pub brightness_percent: Option<u8>,
    pub color_temperature_kelvin: Option<u32>,
}

impl TargetReport {
    pub fn from_target(target: &LightTarget) -> Self {
        Self {
            on: target.on,
            brightness_percent: target
                .brightness
                .map(|brightness| (brightness.get() * 100.0).round() as u8),
            color_temperature_kelvin: target
                .color_temperature
                .map(|kelvin| kelvin.get().round() as u32),
        }
    }
}

/// One device as the daemon sees it. Served on `/devices` only, so
/// `/healthz` never carries topology.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeviceReport {
    pub id: String,
    pub friendly_name: String,
    pub source: DeviceSource,
    pub vendor: Option<String>,
    pub model: Option<String>,
    pub floor: Option<String>,
    pub room: Option<String>,
    pub owner: Option<String>,
    pub controlled: bool,
    pub reason: Option<&'static str>,
    pub note: Option<&'static str>,
    pub target: Option<TargetReport>,
}
```

Add `discovery: DiscoveryStatus,` as the last field of `HealthSnapshot`, `discovery: values.discovery,` in `snapshot()`, and this accessor:

```rust
    pub fn discovery(&self) -> DiscoveryStatus {
        self.discovery
    }
```

Add `discovery: DiscoveryStatus,` and `devices: Vec<DeviceReport>,` to `HealthValues`. Add to `impl HealthState`:

```rust
    pub fn set_discovery(&self, status: DiscoveryStatus, devices: Vec<DeviceReport>) {
        let mut values = self.values.write().expect("health lock poisoned");
        values.discovery = status;
        values.devices = devices;
    }

    pub fn devices(&self) -> Vec<DeviceReport> {
        self.values.read().expect("health lock poisoned").devices.clone()
    }
```

In `serve`, add `.route("/devices", get(devices))` after the `/healthz` route, and this handler:

```rust
async fn devices(
    axum::extract::State(state): axum::extract::State<Arc<HealthState>>,
) -> Json<Vec<DeviceReport>> {
    Json(state.devices())
}
```

- [ ] **Step 4: Run the tests**

Run: `nix develop -c cargo test -p house-automationd`
Expected: PASS. The existing `health_is_ready_only_after_...` still proves `/healthz` omits device names.

- [ ] **Step 5: Commit**

```bash
git add house-automationd/src/health.rs
git commit -m "feat(health): report discovery status and serve /devices"
```

### Task 8: Runtime applies discovery

**Files:**
- Create: `house-automationd/tests/discovery_runtime.rs`
- Modify: `house-automationd/src/runtime.rs:1-37` (imports), `:71-76` (`DeviceRuntime`), `:86-108` (`HouseEngine`), `:111-249` (`initialize`), `:394-399` (empty target), `:495-505` (`affected_owners`), `:737-740` (new engine methods), `:925-968` (`RuntimeActor::new`), `:1115` (arm), `:1164` (`tick` tail), `:1580-1655` (`normalize_state`), `:1679-1692` (`resolve_owner`)

- [ ] **Step 1: Write the failing tests** `house-automationd/tests/discovery_runtime.rs`

```rust
//! Discovery through the runtime actor: what reaches MQTT when Zigbee2MQTT's
//! device list changes.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use async_trait::async_trait;
use chrono::TimeZone;
use chrono_tz::Europe::Stockholm;
use house_automation_core::{
    reconcile::DeviceId,
    state::{AutomationState, LocalDate, MonotonicTime, Scope, ScopeId},
};
use house_automationd::{
    config::ValidatedConfig,
    discovery::parse_bridge_devices,
    health::{DiscoveryStatus, HealthState},
    mqtt::{MqttError, MqttTransport, OwnedInboundMessage, TransportEvent},
    runtime::{DurableStateWriter, HouseEngine, RuntimeActor, RuntimeError, RuntimeInstant},
    scheduler::{Clock, ClockSample},
    zigbee2mqtt::Qos,
};

const PRODUCTION: &str = include_str!("../../nixos/hosts/home-server/house.toml");
const EXAMPLE: &str = include_str!("../../examples/house.toml");
const BRIDGE_DEVICES: &str = include_str!("fixtures/bridge-devices.json");
const BULB: &str = "0x7cc6b6fffe3cef1c";
const LAMP: &str = "upper-floor/upper-hallway/lamp";

#[derive(Clone, Default)]
struct Wire {
    delivered: Arc<Mutex<Vec<String>>>,
    refused: Arc<Mutex<Vec<String>>>,
    blocked: Arc<AtomicBool>,
}

impl Wire {
    fn delivered(&self) -> Vec<String> {
        self.delivered.lock().unwrap().clone()
    }

    fn refused(&self) -> Vec<String> {
        self.refused.lock().unwrap().clone()
    }
}

struct WireTransport(Wire);

#[async_trait]
impl MqttTransport for WireTransport {
    async fn next_event(&mut self) -> Result<TransportEvent, MqttError> {
        std::future::pending().await
    }

    async fn subscribe(&mut self, _topic: &str, _qos: Qos) -> Result<(), MqttError> {
        if self.0.blocked.load(Ordering::SeqCst) {
            return Err(MqttError::transport("simulated broker backpressure"));
        }
        Ok(())
    }

    async fn publish(&mut self, topic: &str, _payload: &[u8], _qos: Qos, _retain: bool) -> Result<(), MqttError> {
        if self.0.blocked.load(Ordering::SeqCst) {
            self.0.refused.lock().unwrap().push(topic.to_owned());
            return Err(MqttError::transport("simulated broker backpressure"));
        }
        self.0.delivered.lock().unwrap().push(topic.to_owned());
        Ok(())
    }

    async fn shutdown(&mut self, _status_topic: &str) -> Result<(), MqttError> {
        Ok(())
    }
}

#[derive(Clone)]
struct TestClock(Arc<Mutex<ClockSample>>);

impl Clock for TestClock {
    fn sample(&self) -> ClockSample {
        self.0.lock().unwrap().clone()
    }
}

struct NoopWriter;

#[async_trait]
impl DurableStateWriter for NoopWriter {
    async fn save(&mut self, _state: AutomationState) -> Result<(), RuntimeError> {
        Ok(())
    }
}

fn sample(seconds: f64) -> ClockSample {
    let whole = seconds as u32;
    let wall = Stockholm.with_ymd_and_hms(2026, 9, 13, 12, 0, 0).unwrap()
        + chrono::Duration::milliseconds((seconds * 1000.0) as i64);
    ClockSample {
        wall,
        runtime: RuntimeInstant::new(
            LocalDate::new(2026, 9, 13).unwrap(),
            12,
            (whole / 60) as u8,
            (whole % 60) as u8,
            MonotonicTime::from_seconds(seconds).unwrap(),
        )
        .unwrap(),
        unix_seconds: wall.timestamp(),
    }
}

fn message(topic: &str, payload: &[u8]) -> TransportEvent {
    TransportEvent::Publish(OwnedInboundMessage {
        topic: topic.to_owned(),
        payload: payload.to_vec(),
        retain: false,
        duplicate: false,
        qos: Qos::AtLeastOnce,
    })
}

fn bridge_devices(bulb_name: &str) -> Vec<u8> {
    let original = format!("\"friendly_name\": \"{BULB}\"");
    assert_eq!(BRIDGE_DEVICES.matches(&original).count(), 1, "fixture drift");
    BRIDGE_DEVICES
        .replace(&original, &format!("\"friendly_name\": \"{bulb_name}\""))
        .into_bytes()
}

fn bulb() -> DeviceId {
    DeviceId::new(BULB).unwrap()
}

struct House {
    actor: RuntimeActor<WireTransport, TestClock, NoopWriter>,
    wire: Wire,
    clock: Arc<Mutex<ClockSample>>,
    health: Arc<HealthState>,
}

impl House {
    fn production() -> Self {
        let parts = ValidatedConfig::parse(PRODUCTION).unwrap().into_runtime_parts();
        let engine = HouseEngine::initialize(parts, AutomationState::default(), sample(0.0).runtime).unwrap();
        let wire = Wire::default();
        let clock = Arc::new(Mutex::new(sample(0.0)));
        let health = Arc::new(HealthState::new());
        let actor = RuntimeActor::new(engine, WireTransport(wire.clone()), TestClock(clock.clone()), NoopWriter, health.clone()).unwrap();
        Self { actor, wire, clock, health }
    }

    async fn receive(&mut self, topic: &str, payload: &[u8]) {
        self.actor.handle_transport_event(message(topic, payload)).await.unwrap();
    }

    async fn run_until(&mut self, seconds: f64) {
        let mut now = self.clock.lock().unwrap().runtime.monotonic.as_seconds();
        while now < seconds {
            now = (now + 0.5).min(seconds);
            *self.clock.lock().unwrap() = sample(now);
            self.actor.tick().await.unwrap();
        }
    }
}

#[tokio::test]
async fn a_light_follows_the_curve_on_join_and_is_never_commanded_under_an_old_name() {
    let mut house = House::production();
    assert_eq!(house.health.snapshot().discovery(), DiscoveryStatus::Pending);
    house.actor.handle_transport_event(TransportEvent::Connected).await.unwrap();
    house.receive("zigbee2mqtt/bridge/state", br#"{"state":"online"}"#).await;
    house.receive("zigbee2mqtt/bridge/devices", &bridge_devices(BULB)).await;
    house.receive(&format!("zigbee2mqtt/{BULB}/availability"), br#"{"state":"online"}"#).await;
    house.run_until(2.0).await;

    let old_set = format!("zigbee2mqtt/{BULB}/set");
    assert!(house.wire.delivered().contains(&old_set), "an unnamed light must follow the curve at once");
    assert_eq!(house.health.snapshot().discovery(), DiscoveryStatus::Synced);
    assert_eq!(house.actor.engine().owner_scope(&bulb()).unwrap(), &Scope::House);

    // Retries pile up while the broker refuses them, as they would in flight.
    house.wire.blocked.store(true, Ordering::SeqCst);
    house.run_until(20.0).await;
    assert!(house.wire.refused().contains(&old_set), "a retry must be in flight when the rename lands");

    let renamed_at = house.wire.delivered().len();
    house.receive("zigbee2mqtt/bridge/devices", &bridge_devices(LAMP)).await;
    house.wire.blocked.store(false, Ordering::SeqCst);
    house.run_until(60.0).await;
    let after_rename = house.wire.delivered()[renamed_at..].to_vec();
    assert!(!after_rename.contains(&old_set), "commanded under its old name: {after_rename:?}");
    assert!(after_rename.contains(&format!("zigbee2mqtt/{LAMP}/set")), "{after_rename:?}");
    assert_eq!(
        house.actor.engine().owner_scope(&bulb()).unwrap(),
        &Scope::Room(ScopeId::new("upper-hallway").unwrap())
    );

    let removed_at = house.wire.delivered().len();
    house.receive("zigbee2mqtt/bridge/devices", b"[]").await;
    house.run_until(100.0).await;
    let after_removal = house.wire.delivered()[removed_at..].to_vec();
    assert!(after_removal.iter().all(|topic| !topic.ends_with("/set")), "{after_removal:?}");
    assert!(house.actor.engine().owner_scope(&bulb()).is_err());
}

#[test]
fn a_static_declaration_wins_over_a_discovered_light_with_the_same_name() {
    let source = EXAMPLE.replacen("schema_version = 1\n", "schema_version = 1\ndefault_curve = \"default-day\"\n", 1);
    let mut engine = HouseEngine::initialize(
        ValidatedConfig::parse(&source).unwrap().into_runtime_parts(),
        AutomationState::default(),
        sample(0.0).runtime,
    )
    .unwrap();
    let devices = parse_bridge_devices(&bridge_devices("demo/living-room/reading-light")).unwrap();

    let outcome = engine.apply_discovery(&devices, sample(1.0).runtime).unwrap();

    assert_eq!(outcome.adopted, 0);
    assert!(engine.owner_scope(&bulb()).is_err());
    assert!(engine.owner_scope(&DeviceId::new("reading-light").unwrap()).is_ok());
    let report = engine.device_reports().into_iter().find(|report| report.id == BULB).unwrap();
    assert!(!report.controlled);
    assert_eq!(report.reason, Some("declared in house.toml; the static entry wins"));
}
```

- [ ] **Step 2: Run the tests**

Run: `nix develop -c cargo test -p house-automationd --test discovery_runtime`
Expected: FAIL to compile (`no method named 'apply_discovery'`, `'device_reports'`).

- [ ] **Step 3: Implement in `runtime.rs`.**

Imports: add `DeviceDefinition` to the `reconcile::{..}` list and `ScopeId` to `state::{..}`. Add:

```rust
use crate::discovery::{
    BridgeDevice, DerivedLight, DiscoveredDevice, Disposition, PlacementNote, StaticTopology,
    UncontrolledReason, classify,
};
use crate::health::{DeviceReport, DeviceSource, DiscoveryStatus, TargetReport};
```

Extend the zigbee2mqtt import to `zigbee2mqtt::{AdapterOperation, DeviceBinding, InboundEvent, PlanEpoch, Subscription, Zigbee2MqttAdapter}`.

In `DeviceRuntime`, replace `membership: ScopeMembership,` with:

```rust
    /// `None` for a discovered light without a `floor/room/device` name; it
    /// is a member of the house scope only.
    membership: Option<ScopeMembership>,
```

Add these fields at the end of `HouseEngine`:

```rust
    scopes: BTreeSet<Scope>,
    discovery: DiscoveryStatus,
    static_names: BTreeSet<String>,
    static_device_ids: BTreeSet<DeviceId>,
    declared_rooms: BTreeMap<ScopeId, ScopeId>,
    discovered: BTreeMap<DeviceId, DiscoveredDevice>,
```

Add this public type before `pub struct HouseEngine`:

```rust
#[derive(Debug, Default)]
pub struct DiscoveryOutcome {
    pub subscriptions: Vec<Subscription>,
    pub adopted: usize,
    pub released: usize,
}
```

Replace the body of `HouseEngine::initialize` from the `RuntimeConfigParts` destructuring through the `devices.is_empty()` check with:

```rust
        let RuntimeConfigParts {
            time_zone: _,
            mqtt,
            input,
            circadian,
            acknowledgement,
            acknowledgement_duration_ms: _,
            whole_hour,
            retry_policy,
            reconciliation_timing,
            health: _,
            curves: configured_curves,
            default_curve,
            rooms: declared_rooms,
            scopes,
            devices: configured_devices,
            groups: configured_groups,
            controls: configured_controls,
            zigbee2mqtt,
        } = parts;
        let discovery_enabled = default_curve.is_some();

        let mut curves = BTreeMap::new();
        for configured_scope in &scopes {
            let curve = configured_curves
                .get(&configured_scope.curve)
                .ok_or(RuntimeError::InvalidTopology("scope curve is missing"))?;
            curves.insert(configured_scope.scope.clone(), curve.clone());
        }
        if let Some(default_curve) = &default_curve {
            // Every discovered light needs an owner, so discovery always has a
            // house scope; a declared one keeps its own curve.
            let curve = configured_curves
                .get(default_curve)
                .ok_or(RuntimeError::InvalidTopology("default curve is missing"))?;
            curves.entry(Scope::House).or_insert_with(|| curve.clone());
        }
        let configured_scopes: BTreeSet<_> = curves.keys().cloned().collect();

        let persisted_snapshot = persisted.snapshot();
        let mut state = normalize_state(
            persisted,
            &configured_scopes,
            &configured_controls,
            discovery_enabled,
        )?;
        let normalized_changed = persisted_snapshot != state.snapshot();
        let before_reset = state.snapshot();
        let reset = state.reset_circadian_if_due(
            now.local_date,
            now.local_time,
            circadian.daily_reset_time,
            now.monotonic,
            circadian.convergence_duration,
        )?;
        let startup_state_changed =
            normalized_changed || before_reset != state.snapshot() || reset.durable_state_changed();

        let mut devices = BTreeMap::new();
        let mut device_aliases = BTreeMap::new();
        let mut static_device_ids = BTreeSet::new();
        let mut definitions = Vec::new();
        for device in configured_devices {
            static_device_ids.insert(device.id.clone());
            for alias in &device.aliases {
                static_device_ids.insert(alias.clone());
                device_aliases.insert(alias.clone(), device.id.clone());
            }
            let capabilities = device.definition.capabilities();
            definitions.push(device.definition);
            if !capabilities.on_off {
                continue;
            }
            let owner = resolve_owner(&configured_scopes, Some(&device.membership))?;
            devices.insert(
                device.id,
                DeviceRuntime {
                    membership: Some(device.membership),
                    capabilities,
                    owner,
                },
            );
        }
        if devices.is_empty() && !discovery_enabled {
            return Err(RuntimeError::InvalidTopology(
                "at least one controllable device is required",
            ));
        }
```

The rest of `initialize` is unchanged: owners, overlays, groups, reconciler and controls. In the final `Ok(Self { .. })`, append:

```rust
            scopes: configured_scopes,
            discovery: if discovery_enabled {
                DiscoveryStatus::Pending
            } else {
                DiscoveryStatus::Disabled
            },
            static_names: zigbee2mqtt.friendly_names(),
            static_device_ids,
            declared_rooms,
            discovered: BTreeMap::new(),
```

Evaluate `static_names` before `adapter: zigbee2mqtt` moves the adapter: add `let static_names = zigbee2mqtt.friendly_names();` just before `Ok(Self {` and use `static_names,` in the struct.

In `apply_action`, replace the `if affected.is_empty() { return Err(...) }` block with:

```rust
        if affected.is_empty() {
            // With discovery a declared scope may have no lights yet; a remote
            // press there is a no-op, never a daemon failure.
            tracing::warn!(source = "control", action = ?action, scope = ?target, "ignored control action for a scope without lights");
            return Ok(ActionSummary {
                affected_owner_count: 0,
                acknowledged_owner_count: 0,
                recomputed_devices: 0,
                durable_state_changed: false,
            });
        }
```

In `affected_owners`, replace `device.membership.is_in(target)` with `is_member(device.membership.as_ref(), target)`.

Add these methods to `impl HouseEngine`, after `reconciliation_timing()`:

```rust
    pub fn discovery_status(&self) -> DiscoveryStatus {
        self.discovery
    }

    /// Applies one Zigbee2MQTT device list. A light that disappeared, stopped
    /// being controllable, or changed name or room is released: its dispatch
    /// work is dropped so its old name can never be commanded again. It is
    /// then adopted under its current name, keeping its known availability.
    pub fn apply_discovery(
        &mut self,
        devices: &[BridgeDevice],
        now: RuntimeInstant,
    ) -> Result<DiscoveryOutcome, RuntimeError> {
        if self.discovery == DiscoveryStatus::Disabled {
            return Err(RuntimeError::InvalidTopology("device discovery is disabled"));
        }
        let mut next = classify(
            devices,
            &StaticTopology {
                friendly_names: &self.static_names,
                device_ids: &self.static_device_ids,
                declared_rooms: &self.declared_rooms,
            },
        );
        let previous = std::mem::take(&mut self.discovered);
        let mut outcome = DiscoveryOutcome::default();
        let mut carried = BTreeMap::new();
        for (id, old) in &previous {
            if old.light().is_none() || same_binding(old, next.get(id)) {
                continue;
            }
            carried.insert(id.clone(), self.release_device(id, now)?);
            outcome.released += 1;
        }
        for (id, device) in &mut next {
            let Some(light) = device.light().copied() else {
                if device.disposition
                    == Disposition::NotControlled(UncontrolledReason::DeclaredStatically)
                    && previous.get(id).is_none_or(|old| old.disposition != device.disposition)
                {
                    tracing::info!(source = "discovery", device = id.as_str(), "ignored discovered device; house.toml declares the same name");
                }
                continue;
            };
            if same_binding(device, previous.get(id)) {
                continue;
            }
            let availability = carried.get(id).copied().flatten();
            match self.adopt_device(id, &device.friendly_name, light, device.membership.clone(), availability, now) {
                Ok(subscriptions) => {
                    outcome.subscriptions.extend(subscriptions);
                    outcome.adopted += 1;
                }
                Err(RuntimeError::Adapter(error)) if error.is_permanent() => {
                    tracing::warn!(source = "discovery", device = id.as_str(), "discovered light name cannot be used as an MQTT topic");
                    device.disposition = Disposition::NotControlled(UncontrolledReason::TopicUnusable);
                }
                Err(error) => return Err(error),
            }
        }
        self.discovered = next;
        self.discovery = DiscoveryStatus::Synced;
        self.refresh_owners();
        let (actions, _) = self.recompute_desired(now)?;
        self.queue_reconcile_actions(actions, now)?;
        Ok(outcome)
    }

    fn release_device(
        &mut self,
        id: &DeviceId,
        now: RuntimeInstant,
    ) -> Result<Option<Availability>, RuntimeError> {
        let availability = self.reconciler.device_state(id).ok().map(|state| state.availability());
        let actions = self.reconciler.remove_device(id, now.monotonic)?;
        self.queue_reconcile_actions(actions, now)?;
        self.adapter.unbind_device(id);
        self.devices.remove(id);
        self.last_targets.remove(id);
        self.last_reconciled_at.remove(id);
        tracing::info!(source = "discovery", device = id.as_str(), "released discovered light");
        Ok(availability)
    }

    fn adopt_device(
        &mut self,
        id: &DeviceId,
        friendly_name: &str,
        light: DerivedLight,
        membership: Option<ScopeMembership>,
        availability: Option<Availability>,
        now: RuntimeInstant,
    ) -> Result<Vec<Subscription>, RuntimeError> {
        let binding = DeviceBinding::new(
            id.clone(),
            friendly_name,
            light.capabilities,
            light.mired_range,
            light.single_transition_attribute,
        )?;
        let owner = resolve_owner(&self.scopes, membership.as_ref())?;
        let subscriptions = self.adapter.bind_device(binding)?;
        let mut actions = self
            .reconciler
            .add_device(DeviceDefinition::new(id.clone(), light.capabilities), now.monotonic)?;
        if availability == Some(Availability::Online) {
            actions.extend(self.reconciler.set_device_availability(id, Availability::Online, now.monotonic)?);
        }
        self.queue_reconcile_actions(actions, now)?;
        tracing::info!(source = "discovery", device = id.as_str(), owner = ?owner, "controlling discovered light");
        self.devices.insert(id.clone(), DeviceRuntime { membership, capabilities: light.capabilities, owner });
        Ok(subscriptions)
    }

    fn refresh_owners(&mut self) {
        let owners: BTreeSet<Scope> = self.devices.values().map(|device| device.owner.clone()).collect();
        self.overlays.retain(|scope, _| owners.contains(scope));
        for owner in &owners {
            self.overlays.entry(owner.clone()).or_insert_with(OverlaySet::new);
        }
        self.owners = owners;
    }

    /// Every controlled static light and every discovered device, for `/devices`.
    pub fn device_reports(&self) -> Vec<DeviceReport> {
        let discovered_light = |id: &DeviceId| {
            self.discovered.get(id).is_some_and(|device| device.light().is_some())
        };
        let mut reports = Vec::with_capacity(self.devices.len() + self.discovered.len());
        for (id, device) in &self.devices {
            if discovered_light(id) {
                continue;
            }
            reports.push(DeviceReport {
                id: id.as_str().to_owned(),
                friendly_name: self.adapter.device_friendly_name(id).unwrap_or_default().to_owned(),
                source: DeviceSource::Static,
                vendor: None,
                model: None,
                floor: device.membership.as_ref().map(|m| m.floor().as_str().to_owned()),
                room: device.membership.as_ref().map(|m| m.room().as_str().to_owned()),
                owner: Some(scope_label(&device.owner)),
                controlled: true,
                reason: None,
                note: None,
                target: self.last_targets.get(id).map(TargetReport::from_target),
            });
        }
        for (id, device) in &self.discovered {
            let runtime = discovered_light(id).then(|| self.devices.get(id)).flatten();
            reports.push(DeviceReport {
                id: id.as_str().to_owned(),
                friendly_name: device.friendly_name.clone(),
                source: DeviceSource::Discovered,
                vendor: device.vendor.clone(),
                model: device.model.clone(),
                floor: device.membership.as_ref().map(|m| m.floor().as_str().to_owned()),
                room: device.membership.as_ref().map(|m| m.room().as_str().to_owned()),
                owner: runtime.map(|runtime| scope_label(&runtime.owner)),
                controlled: runtime.is_some(),
                reason: match device.disposition {
                    Disposition::NotControlled(reason) => Some(reason.as_str()),
                    Disposition::Controlled(_) => None,
                },
                note: device.note.map(PlacementNote::as_str),
                target: runtime.and_then(|_| self.last_targets.get(id)).map(TargetReport::from_target),
            });
        }
        reports
    }
```

Add these free functions next to `resolve_owner`, and replace `resolve_owner` with the version below:

```rust
fn same_binding(current: &DiscoveredDevice, other: Option<&DiscoveredDevice>) -> bool {
    current.light().is_some()
        && other.is_some_and(|other| {
            other.friendly_name == current.friendly_name
                && other.membership == current.membership
                && other.disposition == current.disposition
        })
}

fn is_member(membership: Option<&ScopeMembership>, scope: &Scope) -> bool {
    membership.map_or(matches!(scope, Scope::House), |membership| membership.is_in(scope))
}

fn scope_label(scope: &Scope) -> String {
    match scope {
        Scope::Room(room) => format!("room {}", room.as_str()),
        Scope::Floor(floor) => format!("floor {}", floor.as_str()),
        Scope::House => "house".to_owned(),
    }
}

fn resolve_owner(
    scopes: &BTreeSet<Scope>,
    membership: Option<&ScopeMembership>,
) -> Result<Scope, RuntimeError> {
    let mut matching: Vec<_> = scopes
        .iter()
        .filter(|scope| is_member(membership, scope))
        .cloned()
        .collect();
    matching.sort_by_key(scope_rank);
    matching.pop().ok_or(RuntimeError::InvalidTopology(
        "controllable device has no configured physical owner",
    ))
}

fn backlog_limit_for(engine: &HouseEngine) -> Result<usize, RuntimeError> {
    engine
        .adapter
        .subscriptions()
        .len()
        .checked_add(engine.devices.len())
        .and_then(|count| count.checked_add(engine.groups.len()))
        .and_then(|count| count.checked_add(1))
        .ok_or(RuntimeError::InvalidTopology("transport backlog topology overflow"))?
        .checked_mul(TRANSPORT_BACKLOG_OPERATIONS_PER_TOPOLOGY_UNIT)
        .ok_or(RuntimeError::InvalidTopology("transport backlog capacity overflow"))
}
```

In `normalize_state`, add the parameter `new_scopes_on: bool` after `controls`. Replace the comment and `.unwrap_or_else(|| ScopeState::new(false))` with:

```rust
            // Without discovery a newly configured scope starts off until a
            // control turns it on. With discovery every light follows its curve
            // as soon as it joins, so a scope without persisted state starts on.
            .unwrap_or_else(|| ScopeState::new(new_scopes_on));
```

In `RuntimeActor::new`, replace the `topology_units`/`transport_backlog_limit` computation with the lines below. Put the health line before `Ok(Self {`:

```rust
        let transport_backlog_limit = backlog_limit_for(&engine)?;
        health.set_discovery(engine.discovery_status(), engine.device_reports());
```

Add to `impl RuntimeActor`:

```rust
    fn publish_discovery_health(&self) {
        self.health
            .set_discovery(self.engine.discovery_status(), self.engine.device_reports());
    }
```

In `handle_inbound`, replace the temporary `InboundEvent::BridgeDevices(_) => Vec::new(),` arm with:

```rust
            InboundEvent::BridgeDevices(devices) => {
                let mut next = self.engine.clone();
                let outcome = next.apply_discovery(&devices, sample.runtime)?;
                self.engine = next;
                // Never shrink: work queued for released devices drains later.
                self.transport_backlog_limit =
                    self.transport_backlog_limit.max(backlog_limit_for(&self.engine)?);
                tracing::info!(source = "discovery", device_count = devices.len(), adopted = outcome.adopted, released = outcome.released, "applied Zigbee2MQTT device list");
                for subscription in outcome.subscriptions {
                    self.enqueue_transport_operation(PendingTransportOperation::Adapter(
                        AdapterOperation::Subscribe(subscription),
                    ))
                    .await?;
                }
                self.publish_discovery_health();
                self.drain_engine_actions(sample.runtime).await?;
                return Ok(());
            }
```

At the end of `tick`, replace `self.drain_pending_transport().await` with:

```rust
        self.drain_pending_transport().await?;
        self.publish_discovery_health();
        Ok(())
```

- [ ] **Step 4: Run all Rust tests, formatting and clippy**

Run: `nix develop -c sh -c 'cargo fmt --all && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings'`
Expected: PASS, including `discovery_runtime` (2 tests) and every existing runtime/actor test.

- [ ] **Step 5: Commit**

```bash
git add house-automationd/src/runtime.rs house-automationd/tests/discovery_runtime.rs
git commit -m "feat(daemon): control discovered lights and follow renames without restart"
```

### Task 9: Fake bridge serves a device registry

**Files:**
- Modify: `nix/tests/fake-zigbee2mqtt.py` (whole file)

`writers.writePython3Bin` runs flake8. Keep every line at most 79 characters.

- [ ] **Step 1: Replace the file**

```python
"""Minimal stand-in for the Zigbee2MQTT 2.x bridge API.

Serves the pair-zigbee and house checks. It publishes the retained bridge
state only after its subscription is acknowledged, then a retained device
list and each device's availability. It answers permit_join, device/rename,
device/remove and device/options with the request's transaction, simulates
one IKEA bulb joining whenever joining is permitted, and answers /get and
/set for known devices. Identify and effect commands are logged.
"""

import json
import os
import signal
import threading

import paho.mqtt.client as mqtt

BASE = "zigbee2mqtt"
STATE = "/var/lib/fake-zigbee2mqtt"
REQUESTS = f"{STATE}/requests.jsonl"
DEVICES = f"{STATE}/devices.json"
OPTIONS = f"{STATE}/options.jsonl"
IDENTIFY = f"{STATE}/identify.jsonl"
REJECT = "/run/fake-zigbee2mqtt/reject"
REFUSE_REMOVE = "/run/fake-zigbee2mqtt/refuse-remove"
SEED = os.environ.get("FAKE_Z2M_SEED")
BULB = "0x000b57fffe123456"
LIGHT = {
    "type": "light",
    "features": [
        {"type": "binary", "name": "state", "property": "state",
         "access": 7, "value_on": "ON", "value_off": "OFF"},
        {"type": "numeric", "name": "brightness",
         "property": "brightness", "access": 7,
         "value_min": 0, "value_max": 254},
        {"type": "numeric", "name": "color_temp",
         "property": "color_temp", "access": 7, "unit": "mired",
         "value_min": 250, "value_max": 454},
    ],
}
EFFECT = {
    "type": "enum", "name": "effect", "property": "effect", "access": 2,
    "values": ["blink", "breathe", "okay", "channel_change",
               "finish_effect", "stop_effect"],
}
DEFINITION = {
    "vendor": "IKEA",
    "model": "LED2201G8",
    "description": "TRADFRI bulb E27, white spectrum, globe, opal, 1055 lm",
    "exposes": [LIGHT, EFFECT],
}
COORDINATOR = {
    "ieee_address": "0x00124b0000000001",
    "type": "Coordinator",
    "friendly_name": "Coordinator",
    "supported": True,
    "disabled": False,
    "interview_completed": True,
    "definition": None,
}
LIVE_STATE = {"state": "OFF", "brightness": 127, "color_temp": 333}
OFFLINE = json.dumps({"state": "offline"})
lock = threading.Lock()


def load_devices():
    for path in (DEVICES, SEED):
        if path and os.path.exists(path):
            with open(path) as source:
                return json.load(source)
    return [COORDINATOR]


devices = load_devices()


def publish(client, topic, payload, retain=False):
    client.publish(f"{BASE}/{topic}", json.dumps(payload), qos=1,
                   retain=retain)


def log(path, entry):
    with open(path, "a") as target:
        target.write(json.dumps(entry) + "\n")


def find(name):
    for device in devices:
        if device["type"] == "Coordinator":
            continue
        if name in (device["friendly_name"], device["ieee_address"]):
            return device
    return None


def set_availability(client, name, online):
    if online:
        publish(client, f"{name}/availability", {"state": "online"},
                retain=True)
    else:
        client.publish(f"{BASE}/{name}/availability", b"", qos=1,
                       retain=True)


def publish_devices(client):
    with open(DEVICES, "w") as target:
        json.dump(devices, target)
    publish(client, "bridge/devices", devices, retain=True)


def respond(client, name, request, response):
    if "transaction" in request:
        response["transaction"] = request["transaction"]
    publish(client, f"bridge/response/{name}", response)


def refuse(client, name, request, reason):
    respond(client, name, request,
            {"data": {}, "status": "error", "error": reason})


def on_connect(client, userdata, flags, reason_code, properties):
    client.subscribe(f"{BASE}/#", qos=1)


def on_subscribe(client, userdata, mid, reason_codes, properties):
    with lock:
        publish(client, "bridge/state", {"state": "online"}, retain=True)
        publish_devices(client)
        for device in devices:
            if device["type"] != "Coordinator":
                set_availability(client, device["friendly_name"], True)


def permit_join(client, request):
    log(REQUESTS, request)
    if os.path.exists(REJECT) and request["time"] > 0:
        refuse(client, "permit_join", request, "simulated adapter failure")
        return
    respond(client, "permit_join", request,
            {"data": {"time": request["time"]}, "status": "ok"})
    if request["time"] == 0:
        return
    names = {"friendly_name": BULB, "ieee_address": BULB}
    publish(client, "bridge/event", {"type": "device_joined", "data": names})
    publish(client, "bridge/event", {
        "type": "device_interview",
        "data": {**names, "status": "started"},
    })
    if find(BULB) is None:
        devices.append({**names, "type": "Router", "supported": True,
                        "disabled": False, "interview_completed": True,
                        "definition": DEFINITION})
        publish_devices(client)
        set_availability(client, BULB, True)
    publish(client, "bridge/event", {
        "type": "device_interview",
        "data": {**names, "status": "successful", "supported": True,
                 "definition": DEFINITION},
    })


def rename(client, request):
    device = find(request.get("from", ""))
    target = request.get("to", "")
    if device is None:
        refuse(client, "device/rename", request,
               f"Device '{request.get('from')}' does not exist")
        return
    if not target or find(target) is not None:
        refuse(client, "device/rename", request,
               f"Friendly name '{target}' is already in use")
        return
    old = device["friendly_name"]
    device["friendly_name"] = target
    set_availability(client, old, False)
    set_availability(client, target, True)
    publish_devices(client)
    respond(client, "device/rename", request, {
        "data": {"from": old, "to": target, "homeassistant_rename": False},
        "status": "ok",
    })


def remove(client, request):
    name = request.get("id", "")
    device = find(name)
    if device is None:
        refuse(client, "device/remove", request,
               f"Device '{name}' does not exist")
        return
    if os.path.exists(REFUSE_REMOVE) and not request.get("force"):
        refuse(client, "device/remove", request,
               "Device did not respond to the leave request")
        return
    devices.remove(device)
    set_availability(client, device["friendly_name"], False)
    publish_devices(client)
    respond(client, "device/remove", request, {
        "data": {"id": name, "block": False,
                 "force": bool(request.get("force"))},
        "status": "ok",
    })


def options(client, request):
    log(OPTIONS, request)
    if find(request.get("id", "")) is None:
        refuse(client, "device/options", request,
               f"Device '{request.get('id')}' does not exist")
        return
    respond(client, "device/options", request, {
        "data": {"id": request["id"], "from": {},
                 "to": request.get("options", {}),
                 "restart_required": False},
        "status": "ok",
    })


def command(client, path, payload):
    name, _, action = path.rpartition("/")
    device = find(name)
    if device is None or device["friendly_name"] != name:
        return
    if action == "set" and ("identify" in payload or "effect" in payload):
        log(IDENTIFY, {"device": name, **payload})
    state = dict(LIVE_STATE)
    if action == "set":
        state.update({key: value for key, value in payload.items()
                      if key in LIVE_STATE})
    publish(client, name, state)


def on_message(client, userdata, message):
    if message.retain or not message.payload:
        return
    path = message.topic.removeprefix(f"{BASE}/")
    try:
        payload = json.loads(message.payload)
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    with lock:
        if path == "bridge/request/permit_join":
            permit_join(client, payload)
        elif path == "bridge/request/device/rename":
            rename(client, payload)
        elif path == "bridge/request/device/remove":
            remove(client, payload)
        elif path == "bridge/request/device/options":
            options(client, payload)
        elif path.endswith(("/get", "/set")):
            command(client, path, payload)


def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                         client_id="fake-zigbee2mqtt")
    client.will_set(f"{BASE}/bridge/state", OFFLINE, qos=1, retain=True)
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message

    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda signum, frame: stopping.set())
    client.connect("127.0.0.1", 1883)
    client.loop_start()
    stopping.wait()
    # Mirror Zigbee2MQTT's clean shutdown: retained offline, then leave.
    info = client.publish(f"{BASE}/bridge/state", OFFLINE, qos=1,
                          retain=True)
    info.wait_for_publish(5)
    client.disconnect()
    client.loop_stop()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: The existing pairing check still passes**

Run: `nix build --no-link -L .#checks.x86_64-linux.pair-zigbee`
Expected: PASS. A VM run takes minutes; run it detached if it could hit the 10-minute tool limit.

- [ ] **Step 3: Commit**

```bash
git add nix/tests/fake-zigbee2mqtt.py
git commit -m "test(nix): fake Zigbee2MQTT keeps a device registry"
```

### Task 10: `pair-zigbee` can stop after the first device and report it

**Files:**
- Modify: `nix/pair-zigbee.sh` (usage, argument loop, `handle_message`, main loop)
- Modify: `nix/tests/pair-zigbee.nix` (argument list, new subtest)

- [ ] **Step 1: Write the failing test.** In `nix/tests/pair-zigbee.nix`, add `"--paired-file"` to the list in the "arguments are validated" subtest. After the "pairing opens, reports the bulb, and closes again" subtest, add:

```python
    with subtest("--stop-after-first closes pairing once a device paired"):
        reset_requests()
        status, out = run(
            "--host server --time 200 --stop-after-first "
            "--paired-file /tmp/paired"
        )
        assert status == 0, f"exit {status}\n{out}"
        assert "Pairing closed." in out and "1 device paired:" in out, out
        paired = client.succeed("cat /tmp/paired").strip()
        assert paired == "0x000b57fffe123456", paired
        wait_for_request_times([200, 0])
        assert_no_leftovers()
```

- [ ] **Step 2: Run it**

Run: `nix build --no-link -L .#checks.x86_64-linux.pair-zigbee`
Expected: FAIL. `--paired-file` without a value currently exits 64 as "unknown argument", so the validation list passes. The new subtest then fails with `exit 64` (`unknown argument: --stop-after-first`).

- [ ] **Step 3: Implement.** In `usage`, add after the `--time` line:

```
  --stop-after-first  close pairing as soon as one device has paired
  --paired-file FILE  append the 0x address of each paired device to FILE
```

After `seconds=180`, add `stop_after_first=0` and `paired_file=`. Add these arms before `-h | --help)`:

```bash
    --stop-after-first)
      stop_after_first=1
      shift
      ;;
    --paired-file)
      [ "$#" -ge 2 ] || usage_error "$1 needs a value"
      paired_file=$2
      shift 2
      ;;
```

In `handle_message`, directly after `paired+=("$(jq -r "$describe_paired" <<<"$payload")")`:

```bash
        if [ -n "$paired_file" ]; then
          jq -r '.data.ieee_address' <<<"$payload" >>"$paired_file"
        fi
```

At the top of the body of the final `while [ "$SECONDS" -lt "$end" ]; do` loop:

```bash
  if [ "$stop_after_first" = 1 ] && [ "${#paired[@]}" -gt 0 ]; then
    break
  fi
```

- [ ] **Step 4: Run it**

Run: `nix build --no-link -L .#checks.x86_64-linux.pair-zigbee`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add nix/pair-zigbee.sh nix/tests/pair-zigbee.nix
git commit -m "feat(pair-zigbee): stop after the first device and report its address"
```

### Task 11: The `house` command and its VM check

**Files:**
- Create: `nix/tests/house.nix`, `nix/house.nix`, `nix/house.sh`
- Modify: `flake.nix` (let binding after `pairZigbee`, `packages`, `apps`, `checks`)

- [ ] **Step 1: Write the failing VM test** `nix/tests/house.nix`

```nix
{
  pkgs,
  module,
  package,
  house,
}:

let
  sshKeys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  fakeZigbee2mqtt = pkgs.writers.writePython3Bin "fake-zigbee2mqtt" {
    libraries = [ pkgs.python3Packages.paho-mqtt ];
  } (builtins.readFile ./fake-zigbee2mqtt.py);
  production = builtins.fromTOML (builtins.readFile ../../nixos/hosts/home-server/house.toml);
in
pkgs.testers.runNixOSTest {
  name = "house";

  nodes.server =
    { lib, ... }:
    {
      imports = [ module ];

      services.openssh.enable = true;
      users.users.jonathan = {
        isNormalUser = true;
        openssh.authorizedKeys.keys = [ sshKeys.snakeOilEd25519PublicKey ];
      };

      services.mosquitto = {
        enable = true;
        listeners = [
          {
            address = "127.0.0.1";
            port = 1883;
            omitPasswordAuth = true;
            acl = [
              "topic readwrite zigbee2mqtt/#"
              "topic readwrite house/v1/#"
            ];
            settings.allow_anonymous = true;
          }
        ];
      };

      systemd.services.fake-zigbee2mqtt = {
        wantedBy = [ "multi-user.target" ];
        requires = [ "mosquitto.service" ];
        after = [ "mosquitto.service" ];
        environment.FAKE_Z2M_SEED = "${../../house-automationd/tests/fixtures/bridge-devices.json}";
        serviceConfig = {
          ExecStart = pkgs.lib.getExe fakeZigbee2mqtt;
          StateDirectory = "fake-zigbee2mqtt";
          RuntimeDirectory = "fake-zigbee2mqtt";
        };
      };

      # The shipped production topology, with a fast refresh so a stopped
      # command stream is visible within seconds.
      services.houseAutomation = {
        enable = true;
        inherit package;
        settings = lib.recursiveUpdate production {
          circadian = {
            tick_seconds = 0.5;
            maximum_refresh_seconds = 2.0;
          };
        };
      };
      systemd.services.house-automationd = {
        requires = [ "mosquitto.service" ];
        after = [ "mosquitto.service" ];
      };

      environment.systemPackages = [
        pkgs.coreutils
        pkgs.curl
        pkgs.jq
        pkgs.mosquitto
      ];
    };

  nodes.client =
    { ... }:
    {
      environment.systemPackages = [ house ];
      programs.ssh.extraConfig = ''
        Host server
          User jonathan
          IdentityFile /root/.ssh/id_ed25519
          StrictHostKeyChecking accept-new
      '';
    };

  testScript = ''
    import time

    OLD = "0x7cc6b6fffe3cef1c"
    LAMP = "upper-floor/upper-hallway/lamp"
    BULB = "upper-floor/upper-hallway/bulb"
    STATE = "/var/lib/fake-zigbee2mqtt"


    def sets(name):
        out = server.succeed(
            f"grep -c -F 'zigbee2mqtt/{name}/set {{' /tmp/mqtt.log || true"
        )
        return int(out.strip() or "0")


    def wait_for_sets(name, timeout=60):
        deadline = time.monotonic() + timeout
        while sets(name) == 0:
            assert time.monotonic() < deadline, f"no command reached {name}"
            time.sleep(0.5)


    def house(args):
        return client.succeed(f"house --host server {args} 2>&1")


    start_all()
    server.wait_for_unit("sshd.service")
    server.wait_for_unit("fake-zigbee2mqtt.service")
    server.wait_for_unit("house-automationd.service")
    server.succeed(
        "systemd-run --unit=mqtt-recorder "
        "--property=StandardOutput=append:/tmp/mqtt.log "
        "stdbuf -oL mosquitto_sub -h 127.0.0.1 -v -t 'zigbee2mqtt/#'"
    )
    client.wait_for_unit("multi-user.target")
    client.succeed(
        "install -d -m 700 /root/.ssh && "
        "install -m 600 ${sshKeys.snakeOilEd25519PrivateKey} /root/.ssh/id_ed25519"
    )
    client.wait_until_succeeds("ssh -o ConnectTimeout=3 server true", timeout=60)

    with subtest("an unnamed light follows the curve as soon as it is discovered"):
        wait_for_sets(OLD)
        server.succeed(
            "curl -sS http://127.0.0.1:9876/healthz | jq -e '.discovery == \"synced\"'"
        )

    with subtest("list shows every device, its model and whether it is controlled"):
        out = house("list")
        for expected in [
            OLD,
            "IKEA LED2111G6",
            "controlled (house)",
            "IKEA E1524/E1810",
            "not controlled: not a light",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"

    with subtest("rename moves the lamp into its room and off its old name"):
        out = house(f"rename {OLD} {LAMP}")
        assert f"Renamed {OLD} to {LAMP}." in out, out
        assert "owner: room upper-hallway" in out, out
        wait_for_sets(LAMP, timeout=30)
        before_old, before_new = sets(OLD), sets(LAMP)
        time.sleep(6)
        assert sets(OLD) == before_old, "commanded under its old name"
        assert sets(LAMP) > before_new, "the renamed lamp stopped following"
        out = house(f"show {LAMP}")
        for expected in [
            "Room:          upper-hallway on upper-floor",
            "Controlled:    yes, follows room upper-hallway",
            "Circadian:     on",
            "Availability:  online",
            "Live state:    OFF",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"

    with subtest("identify flashes a lamp through its identify expose"):
        out = house(f"identify {LAMP}")
        assert f"{LAMP} is flashing for 10 s." in out, out
        server.succeed(
            f"jq -e -s 'any(.id == \"{LAMP}\" and .options.identify_timeout == 10)' "
            f"{STATE}/options.jsonl"
        )
        server.succeed(
            f"jq -e -s 'any(.device == \"{LAMP}\" and .identify == \"identify\")' "
            f"{STATE}/identify.jsonl"
        )

    with subtest("remove stops every command to the lamp"):
        out = house(f"remove {LAMP}")
        assert f"Removed {LAMP}." in out, out
        server.wait_until_succeeds(
            f"curl -fsS http://127.0.0.1:9876/devices | "
            f"jq -e 'all(.friendly_name != \"{LAMP}\")'"
        )
        before = sets(LAMP)
        time.sleep(6)
        assert sets(LAMP) == before, "a removed lamp was still commanded"
        assert LAMP not in house("list")

    with subtest("add pairs a new lamp, names it, and it follows the curve"):
        out = house(f"add {BULB} --time 20")
        for expected in [
            "Paired: IKEA LED2201G8",
            f"Renamed 0x000b57fffe123456 to {BULB}.",
            "owner: room upper-hallway",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"
        wait_for_sets(BULB, timeout=30)

    with subtest("identify falls back to a breathe effect"):
        out = house(f"identify {BULB} --seconds 1")
        assert f"{BULB} is breathing for 1 s." in out, out
        server.succeed(
            f"jq -e -s '[.[] | select(.device == \"{BULB}\") | .effect] "
            f"== [\"breathe\", \"stop_effect\"]' {STATE}/identify.jsonl"
        )

    with subtest("a refused removal points at --force"):
        server.succeed("touch /run/fake-zigbee2mqtt/refuse-remove")
        status, out = client.execute(f"house --host server remove {BULB} 2>&1")
        assert status == 1, f"exit {status}\n{out}"
        assert f"house remove {BULB} --force" in out, out
        out = house(f"remove {BULB} --force")
        assert f"Removed {BULB}." in out, out
        server.succeed("rm /run/fake-zigbee2mqtt/refuse-remove")

    with subtest("bad input is refused before anything connects"):
        for args in [
            "",
            "bogus",
            "add kitchen",
            "add a/b/c --time 0",
            "rename x Upper/hall/lamp",
            "rename x a/b/set",
            "identify x --seconds 31",
            "show",
            "remove",
            "--host -oProxyCommand=touch list",
        ]:
            status, out = client.execute(f"house {args} 2>&1")
            assert status == 64, f"{args!r}: exit {status}\n{out}"
        status, out = client.execute("house --host server show nosuch 2>&1")
        assert status == 1 and "no device named nosuch" in out, out
  '';
}
```

In `flake.nix`, after `pairZigbee = pkgs.callPackage ./nix/pair-zigbee.nix { };`:

```nix
      house = pkgs.callPackage ./nix/house.nix { inherit pairZigbee; };
```

Add `house = house;` to `packages.${system}`. Add the app:

```nix
      apps.${system}.house = {
        type = "app";
        program = pkgs.lib.getExe house;
        meta.description = house.meta.description;
      };
```

Add this entry to `checks.${system}`:

```nix
        house = import ./nix/tests/house.nix {
          inherit pkgs package house;
          module = self.nixosModules.default;
        };
```

- [ ] **Step 2: Run it**

Run: `git add -N nix/tests/house.nix && nix build --no-link -L .#checks.x86_64-linux.house`
Expected: FAIL at evaluation: `path '.../nix/house.nix' does not exist`.

- [ ] **Step 3: Create `nix/house.nix`**

```nix
{
  coreutils,
  curl,
  jq,
  mosquitto,
  openssh,
  pairZigbee,
  util-linux,
  writeShellApplication,
}:

writeShellApplication {
  name = "house";
  runtimeInputs = [
    coreutils
    curl
    jq
    mosquitto
    openssh
    pairZigbee
    util-linux
  ];
  text = builtins.readFile ./house.sh;
  # Single-quoted jq programs use jq's own $variables, not the shell's.
  excludeShellChecks = [ "SC2016" ];
  meta.description = "List, inspect, identify, name, remove and add home-server devices";
}
```

- [ ] **Step 4: Create `nix/house.sh`**

```bash
# List, inspect, identify, rename, remove and add devices on the home server.
#
# Zigbee2MQTT is the device registry: every change here is a Zigbee2MQTT
# bridge request, and house-automationd follows the retained device list.
# One SSH connection forwards two private Unix sockets: the server's
# loopback-only Mosquitto and house-automationd's loopback status listener.

readonly base_topic=zigbee2mqtt
readonly segment='[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?'
# zigbee-herdsman refuses permit-join windows longer than 254 seconds.
readonly max_pairing_seconds=254

usage() {
  cat <<'EOF'
Usage: house [--host HOST] COMMAND [ARGUMENTS]

Commands:
  list                         every device: name, room, model, availability
  show NAME                    details, live state and circadian target
  identify NAME [--seconds S]  make a device flash for 1-30 s (default 10)
  rename OLD NEW               rename a device; a new floor/room moves it
  remove NAME [--force]        remove a device from the Zigbee network
  add [NEW] [--time S]         pair a device (1-254 s window, default 180)
                               and optionally name it NEW

NAME and OLD are a device's current name or its 0x... address. NEW is
floor/room/device in lowercase letters, digits, '-' and '_', for example
upper-floor/upper-hallway/lamp. Every light follows the circadian curve as
soon as it pairs; a name only places it in a room.

Options:
  -H, --host HOST  SSH destination (default: $SMARTHOME_HOST, else home-server)
  -h, --help       show this help
EOF
}

usage_error() {
  printf 'house: %s\n\n' "$1" >&2
  usage >&2
  exit 64
}

fail() {
  printf 'house: %s\n' "$1" >&2
  exit "${2:-1}"
}

valid_name() {
  local terminal=${1##*/}
  [[ $1 =~ ^$segment/$segment/$segment$ ]] &&
    ! [[ $terminal =~ ^(set|get|availability|left|right|[0-9]+)$ ]]
}

# True when $1 is a whole number of seconds from 1 to $2.
whole_seconds_in() {
  [[ $1 =~ ^[0-9]{1,3}$ ]] && ((10#$1 >= 1 && 10#$1 <= $2))
}

host=${SMARTHOME_HOST:-home-server}
health_port=${SMARTHOME_HEALTH_PORT:-9876}
while [ "$#" -gt 0 ]; do
  case $1 in
    -H | --host)
      [ "$#" -ge 2 ] || usage_error "$1 needs a value"
      host=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) usage_error "unknown option: $1" ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] || usage_error "missing command"
command=$1
shift

name=
old=
seconds=
force=0
new_name_hint="new name must be floor/room/device, for example upper-floor/upper-hallway/lamp"
case $command in
  list)
    [ "$#" -eq 0 ] || usage_error "list takes no arguments"
    ;;
  show)
    [ "$#" -eq 1 ] || usage_error "show needs one device name"
    name=$1
    ;;
  identify)
    [ "$#" -ge 1 ] || usage_error "identify needs a device name"
    name=$1
    seconds=10
    shift
    while [ "$#" -gt 0 ]; do
      case $1 in
        -s | --seconds)
          [ "$#" -ge 2 ] || usage_error "$1 needs a value"
          seconds=$2
          shift 2
          ;;
        *) usage_error "unknown argument: $1" ;;
      esac
    done
    whole_seconds_in "$seconds" 30 || usage_error "--seconds must be a whole number from 1 to 30"
    ;;
  rename)
    [ "$#" -eq 2 ] || usage_error "rename needs the old and the new name"
    old=$1
    name=$2
    valid_name "$name" || usage_error "$new_name_hint"
    ;;
  remove)
    [ "$#" -ge 1 ] || usage_error "remove needs a device name"
    name=$1
    shift
    while [ "$#" -gt 0 ]; do
      case $1 in
        -f | --force)
          force=1
          shift
          ;;
        *) usage_error "unknown argument: $1" ;;
      esac
    done
    ;;
  add)
    seconds=180
    if [ "$#" -gt 0 ] && [[ $1 != -* ]]; then
      name=$1
      shift
      valid_name "$name" || usage_error "$new_name_hint"
    fi
    while [ "$#" -gt 0 ]; do
      case $1 in
        -t | --time)
          [ "$#" -ge 2 ] || usage_error "$1 needs a value"
          seconds=$2
          shift 2
          ;;
        *) usage_error "unknown argument: $1" ;;
      esac
    done
    whole_seconds_in "$seconds" "$max_pairing_seconds" ||
      usage_error "--time must be a whole number of seconds from 1 to $max_pairing_seconds"
    ;;
  *) usage_error "unknown command: $command" ;;
esac
if [ -n "$seconds" ]; then
  seconds=$((10#$seconds))
fi
# A leading dash would be parsed by ssh as an option, not a destination.
if [ -z "$host" ] || [[ $host == -* ]]; then
  usage_error "invalid host: '$host'"
fi
[[ $health_port =~ ^[0-9]{1,5}$ ]] || usage_error "SMARTHOME_HEALTH_PORT must be a port number"

workdir=$(mktemp -d)
mqtt_socket=$workdir/mqtt.sock
health_socket=$workdir/health.sock
devices=$workdir/devices.json
daemon=$workdir/daemon.json
daemon_reachable=0
bridge_error=
ssh_pid=
subscriber_pid=

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$subscriber_pid" ]; then kill "$subscriber_pid" 2>/dev/null || true; fi
  if [ -n "$ssh_pid" ]; then kill "$ssh_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

open_tunnel() {
  local reason
  echo "Connecting to $host..." >&2
  ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=3 \
    -L "$mqtt_socket:127.0.0.1:1883" \
    -L "$health_socket:127.0.0.1:$health_port" \
    -- "$host" 2>"$workdir/ssh.log" &
  ssh_pid=$!
  while [ ! -S "$mqtt_socket" ] || [ ! -S "$health_socket" ]; do
    if ! kill -0 "$ssh_pid" 2>/dev/null; then
      reason=$(tail -n 3 "$workdir/ssh.log")
      fail "could not connect to $host over SSH${reason:+: $reason}" 69
    fi
    sleep 0.2
  done
}

fetch_devices() {
  timeout 15 mosquitto_sub --unix "$mqtt_socket" -q 1 -C 1 -W 10 \
    -t "$base_topic/bridge/devices" >"$devices" 2>/dev/null || true
  jq -e 'type == "array"' "$devices" >/dev/null 2>&1 ||
    fail "Zigbee2MQTT on $host has not published its device list; is it running?" 69
}

fetch_daemon_devices() {
  if curl -fsS --max-time 5 --unix-socket "$health_socket" http://localhost/devices \
    >"$daemon" 2>/dev/null && jq -e 'type == "array"' "$daemon" >/dev/null 2>&1; then
    daemon_reachable=1
  else
    daemon_reachable=0
    echo '[]' >"$daemon"
  fi
}

# Prints the Zigbee2MQTT entry whose name or 0x address is $1.
device_entry() {
  jq -ce --arg name "$1" \
    'first(.[] | select(.type != "Coordinator")
      | select(.friendly_name == $name or .ieee_address == $name))' "$devices"
}

# Sends one Zigbee2MQTT bridge request. Returns 1 with $bridge_error set when
# Zigbee2MQTT answers with an error; exits when it cannot be reached.
bridge_request() {
  local path=$1 body=$2 wait_seconds=$3
  local transaction request line status topic payload response= deadline
  transaction="house-$$-$RANDOM"
  request=$(jq -c --arg transaction "$transaction" '. + {transaction: $transaction}' <<<"$body")
  rm -f "$workdir/bridge"
  mkfifo "$workdir/bridge"
  mosquitto_sub --unix "$mqtt_socket" -q 1 -F %j \
    -t "$base_topic/bridge/state" \
    -t "$base_topic/bridge/response/$path" \
    >"$workdir/bridge" 2>/dev/null &
  subscriber_pid=$!
  exec 3<"$workdir/bridge"
  # The retained bridge state arrives after the subscription is acknowledged,
  # so the response to a request sent afterwards cannot be missed.
  IFS= read -r -t 10 -u 3 line || fail "Zigbee2MQTT on $host did not answer" 69
  [ "$(jq -r '.payload | fromjson? | .state // "unknown"' <<<"$line")" = online ] ||
    fail "Zigbee2MQTT is not running on $host" 69
  timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
    -t "$base_topic/bridge/request/$path" -m "$request" ||
    fail "could not send the $path request to $host" 1
  deadline=$((SECONDS + wait_seconds))
  while [ -z "$response" ] && [ "$SECONDS" -lt "$deadline" ]; do
    status=0
    IFS= read -r -t 1 -u 3 line || status=$?
    if [ "$status" -gt 128 ]; then continue; fi
    [ "$status" -eq 0 ] || fail "lost contact with Zigbee2MQTT on $host" 1
    topic=$(jq -r .topic <<<"$line")
    payload=$(jq -r .payload <<<"$line")
    if [ "$topic" = "$base_topic/bridge/response/$path" ] &&
      jq -e --arg t "$transaction" '.transaction == $t' <<<"$payload" >/dev/null 2>&1; then
      response=$payload
    fi
  done
  exec 3<&-
  kill "$subscriber_pid" 2>/dev/null || true
  wait "$subscriber_pid" 2>/dev/null || true
  subscriber_pid=
  [ -n "$response" ] || fail "Zigbee2MQTT on $host did not answer the $path request" 1
  if [ "$(jq -r .status <<<"$response")" != ok ]; then
    bridge_error=$(jq -r '.error // "no reason given"' <<<"$response")
    return 1
  fi
}

# Waits briefly until house-automationd reports the device under $1.
report_daemon_view() {
  local wanted=$1 entry deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    fetch_daemon_devices
    if entry=$(jq -ce --arg name "$wanted" 'first(.[] | select(.friendly_name == $name))' "$daemon"); then
      if jq -e .controlled <<<"$entry" >/dev/null; then
        echo "house-automationd controls it (owner: $(jq -r .owner <<<"$entry"))."
      else
        echo "house-automationd sees it but does not control it: $(jq -r .reason <<<"$entry")."
      fi
      return 0
    fi
    sleep 1
  done
  echo "house-automationd has not reported it yet; check with: house show $wanted" >&2
}

list_devices() {
  local names=() topics=() device
  mapfile -t names < <(jq -r '.[] | select(.type != "Coordinator") | .friendly_name' "$devices")
  if [ "${#names[@]}" -eq 0 ]; then
    echo "No devices are paired yet. Add one with: house add"
    return
  fi
  for device in "${names[@]}"; do
    topics+=(-t "$base_topic/$device/availability")
  done
  timeout 10 mosquitto_sub --unix "$mqtt_socket" -q 1 --retained-only -W 3 -F %j \
    "${topics[@]}" >"$workdir/availability" 2>/dev/null || true
  jq -n --arg prefix "$base_topic/" \
    '[inputs | {key: (.topic | ltrimstr($prefix) | rtrimstr("/availability")),
      value: ((.payload | fromjson? | .state?) // .payload)}] | from_entries' \
    "$workdir/availability" >"$workdir/availability.json"
  {
    printf 'NAME\tROOM\tMODEL\tAVAILABILITY\tCONTROL\n'
    jq -r --slurpfile daemon "$daemon" --slurpfile availability "$workdir/availability.json" \
      --argjson reachable "$daemon_reachable" '
      ($daemon[0] | map({key: .friendly_name, value: .}) | from_entries) as $reports
      | .[] | select(.type != "Coordinator")
      | . as $d | ($reports[$d.friendly_name] // null) as $r
      | [ $d.friendly_name,
          (if $r and $r.room then "\($r.floor)/\($r.room)" else "-" end),
          (if $d.definition then "\($d.definition.vendor) \($d.definition.model)" else "unknown" end),
          ($availability[0][$d.friendly_name] // "unknown"),
          (if $reachable == 0 then "house-automationd not reachable"
           elif $r == null then "not seen by house-automationd yet"
           elif $r.controlled then "controlled (\($r.owner))"
           else "not controlled: \($r.reason)" end)
        ] | @tsv' "$devices"
  } | column -t -s $'\t'
}

live_state() {
  local friendly=$1 line status topic payload ready=0 availability= state=
  local deadline=$((SECONDS + 10))
  rm -f "$workdir/live"
  mkfifo "$workdir/live"
  mosquitto_sub --unix "$mqtt_socket" -q 1 -F %j \
    -t "$base_topic/bridge/state" \
    -t "$base_topic/$friendly" \
    -t "$base_topic/$friendly/availability" \
    >"$workdir/live" 2>/dev/null &
  subscriber_pid=$!
  exec 4<"$workdir/live"
  while [ -z "$state" ] && [ "$SECONDS" -lt "$deadline" ]; do
    status=0
    IFS= read -r -t 1 -u 4 line || status=$?
    if [ "$status" -gt 128 ]; then continue; fi
    [ "$status" -eq 0 ] || break
    topic=$(jq -r .topic <<<"$line")
    payload=$(jq -r .payload <<<"$line")
    case $topic in
      "$base_topic/bridge/state")
        if [ "$ready" = 0 ]; then
          ready=1
          timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
            -t "$base_topic/$friendly/get" -m '{"state":""}' || true
        fi
        ;;
      "$base_topic/$friendly/availability")
        availability=$(jq -r '.state // empty' <<<"$payload" 2>/dev/null || echo "$payload")
        ;;
      "$base_topic/$friendly") state=$payload ;;
    esac
  done
  exec 4<&-
  kill "$subscriber_pid" 2>/dev/null || true
  wait "$subscriber_pid" 2>/dev/null || true
  subscriber_pid=
  echo "Availability:  ${availability:-unknown}"
  if [ -n "$state" ]; then
    echo "Live state:    $(jq -r '[.state // empty,
      (if .brightness then "brightness \(.brightness)/254" else empty end),
      (if .color_temp then "\(.color_temp) mired" else empty end)] | join(", ")' <<<"$state")"
  else
    echo "Live state:    no answer within 10 seconds"
  fi
}

show_device() {
  local entry friendly report
  entry=$(device_entry "$name") || fail "no device named $name on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  report=$(jq -c --arg name "$friendly" 'first(.[] | select(.friendly_name == $name)) // null' "$daemon")
  jq -r --argjson report "$report" --argjson reachable "$daemon_reachable" '
    "Name:          \(.friendly_name)",
    "Address:       \(.ieee_address)",
    "Model:         \(if .definition then "\(.definition.vendor) \(.definition.model) - \(.definition.description)" else "unknown" end)",
    "Room:          \(if $report and $report.room then "\($report.room) on \($report.floor)" else "none" end)",
    "Controlled:    \(if $reachable == 0 then "unknown (house-automationd not reachable)"
      elif $report == null then "not seen by house-automationd yet"
      elif $report.controlled then "yes, follows \($report.owner)"
      else "no: \($report.reason)" end)",
    (if $report and $report.note then "Note:          \($report.note)" else empty end),
    "Circadian:     \(if $report and $report.target then ($report.target
      | "\(if .on then "on" else "off" end)\(if .brightness_percent then ", \(.brightness_percent)%" else "" end)\(if .color_temperature_kelvin then ", \(.color_temperature_kelvin) K" else "" end)")
      else "no target" end)"
  ' <<<"$entry"
  live_state "$friendly"
}

identify_device() {
  local entry friendly effects stop
  entry=$(device_entry "$name") || fail "no device named $name on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  if jq -e '[.definition.exposes[]? | .. | objects | select(.name? == "identify")] | length > 0' \
    <<<"$entry" >/dev/null; then
    bridge_request device/options \
      "$(jq -cn --arg id "$friendly" --argjson seconds "$seconds" \
        '{id: $id, options: {identify_timeout: $seconds}}')" 15 ||
      fail "Zigbee2MQTT could not set the identify time for $friendly: $bridge_error" 1
    timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
      -t "$base_topic/$friendly/set" -m '{"identify":"identify"}' ||
      fail "could not reach $friendly" 1
    echo "$friendly is flashing for $seconds s."
    return
  fi
  effects=$(jq -c '[.definition.exposes[]? | .. | objects | select(.name? == "effect") | .values[]?]' <<<"$entry")
  jq -e 'index("breathe")' <<<"$effects" >/dev/null ||
    fail "$friendly cannot flash: it exposes neither identify nor a breathe effect" 1
  timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
    -t "$base_topic/$friendly/set" -m '{"effect":"breathe"}' ||
    fail "could not reach $friendly" 1
  echo "$friendly is breathing for $seconds s."
  sleep "$seconds"
  stop=$(jq -r 'if index("stop_effect") then "stop_effect"
    elif index("finish_effect") then "finish_effect" else empty end' <<<"$effects")
  if [ -n "$stop" ]; then
    timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
      -t "$base_topic/$friendly/set" -m "{\"effect\":\"$stop\"}" || true
  fi
}

rename_device() {
  local entry friendly
  entry=$(device_entry "$old") || fail "no device named $old on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  if [ "$friendly" = "$name" ]; then
    echo "$friendly already has that name."
    return
  fi
  if device_entry "$name" >/dev/null; then fail "$name is already taken on $host" 1; fi
  bridge_request device/rename \
    "$(jq -cn --arg from "$friendly" --arg to "$name" '{from: $from, to: $to, homeassistant_rename: false}')" 30 ||
    fail "Zigbee2MQTT refused to rename $friendly: $bridge_error" 1
  echo "Renamed $friendly to $name."
  report_daemon_view "$name"
}

remove_device() {
  local entry friendly force_json=false
  entry=$(device_entry "$name") || fail "no device named $name on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  if [ "$force" = 1 ]; then force_json=true; fi
  if ! bridge_request device/remove \
    "$(jq -cn --arg id "$friendly" --argjson force "$force_json" '{id: $id, force: $force, block: false}')" 90; then
    if [ "$force" = 0 ]; then
      fail "Zigbee2MQTT could not remove $friendly: $bridge_error. If the device is gone for good, run: house remove $friendly --force" 1
    fi
    fail "Zigbee2MQTT could not remove $friendly: $bridge_error" 1
  fi
  echo "Removed $friendly."
}

add_device() {
  local paired=$workdir/paired ieee status=0
  if [ -n "$name" ] && device_entry "$name" >/dev/null; then
    fail "$name is already taken on $host" 1
  fi
  : >"$paired"
  pair-zigbee --host "$host" --time "$seconds" --stop-after-first --paired-file "$paired" || status=$?
  ieee=$(head -n 1 "$paired")
  if [ -z "$ieee" ]; then
    [ "$status" -eq 0 ] || exit "$status"
    fail "nothing paired, so nothing was named" 1
  fi
  if [ -z "$name" ]; then
    echo "Paired $ieee. It follows the circadian curve now."
    echo "Name it with: house rename $ieee <floor/room/device>"
    report_daemon_view "$ieee"
    return
  fi
  bridge_request device/rename \
    "$(jq -cn --arg from "$ieee" --arg to "$name" '{from: $from, to: $to, homeassistant_rename: false}')" 30 ||
    fail "paired $ieee but could not name it: $bridge_error. Retry with: house rename $ieee $name" 1
  echo "Renamed $ieee to $name."
  report_daemon_view "$name"
}

open_tunnel
fetch_devices
case $command in
  list)
    fetch_daemon_devices
    list_devices
    ;;
  show)
    fetch_daemon_devices
    show_device
    ;;
  identify) identify_device ;;
  rename) rename_device ;;
  remove) remove_device ;;
  add) add_device ;;
esac
```

- [ ] **Step 5: Run it**

Run: `nix build --no-link -L .#checks.x86_64-linux.house`
Expected: PASS. Run it detached if it approaches the 10-minute tool limit, and read the log.

- [ ] **Step 6: Commit**

```bash
git add nix/house.sh nix/house.nix nix/tests/house.nix flake.nix
git commit -m "feat(house): manage home-server devices without a pull request"
```

### Task 12: Enable the daemon on home-server and guard the registry files

**Files:**
- Modify: `nixos/hosts/home-server/default.nix:13-14`
- Modify: `nixos/modules/home-server-services.nix` (inside `(mkIf zigbeeEnabled { ... })`, around `:276`)
- Modify: `nixos/tests/home-server-services.nix:33-87` (let bindings and asserts), `:133` (`mkForce`)
- Modify: `nixos/tests/home-server.nix:118`, `nixos/tests/fixtures/home-server-cd-module.nix:181` (`mkForce`)

- [ ] **Step 1: Write the failing evaluation asserts.** In `nixos/tests/home-server-services.nix`, add to the `let` block:

```nix
  registryFilesGuard = devicesFile:
    let
      evaluated = host.extendModules {
        modules = [
          { services.zigbee2mqtt.settings.devices = pkgsSystem.lib.mkForce devicesFile; }
        ];
      };
      assertion = pkgsSystem.lib.findFirst
        (assertion:
          assertion.message == "zigbee2mqtt must keep devices.yaml and groups.yaml as its device and group files so runtime renames survive restarts"
        )
        (throw "zigbee2mqtt registry file assertion is missing")
        evaluated.config.assertions;
    in assertion.assertion;
```

Replace the first three top-level asserts with:

```nix
assert host.config.homeServer.houseSettings.default_curve == "home-day";
assert host.config.services.app-auto-deploy.serviceName == "house-automationd.service";
assert host.config.services.app-auto-deploy.healthUrl == "http://127.0.0.1:9876/healthz";
assert registryFilesGuard "devices.yaml";
assert !(registryFilesGuard "configuration.yaml");
```

- [ ] **Step 2: Run it**

Run: `nix build --no-link .#checks.x86_64-linux.home-server-services --dry-run`
Expected: FAIL at evaluation. The first failing assert is `houseSettings.default_curve` (the host's `houseSettings` is null).

- [ ] **Step 3: Implement.** In `nixos/hosts/home-server/default.nix`, after the `system.configurationRevision` line:

```nix
  # Policy only: devices are discovered at runtime from Zigbee2MQTT.
  homeServer.houseSettings = builtins.fromTOML (builtins.readFile ./house.toml);
```

In `nixos/modules/home-server-services.nix`, inside `(mkIf zigbeeEnabled {`, before `services.zigbee2mqtt = {`:

```nix
      assertions = [
        {
          assertion =
            (config.services.zigbee2mqtt.settings.devices or null) == "devices.yaml"
            && (config.services.zigbee2mqtt.settings.groups or null) == "groups.yaml";
          message = "zigbee2mqtt must keep devices.yaml and groups.yaml as its device and group files so runtime renames survive restarts";
        }
      ];
```

The host now sets `houseSettings`, so test nodes that override it must force their own value. Change `houseSettings = {` to `houseSettings = lib.mkForce {` at `nixos/tests/home-server-services.nix:133`. Change `homeServer.houseSettings = {` to `homeServer.houseSettings = lib.mkForce {` at `nixos/tests/home-server.nix:118`. Change `houseSettings = {` to `houseSettings = mkForce {` at `nixos/tests/fixtures/home-server-cd-module.nix:181`. Close each with the existing `};`.

- [ ] **Step 4: Verify evaluation and the host builds**

Run: `nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel`
Expected: success.

Run (detached; VM tests): `nix build --no-link -L .#checks.x86_64-linux.home-server-services .#checks.x86_64-linux.standalone-host .#checks.x86_64-linux.vm-home-server .#checks.x86_64-linux.vm-home-server-cd`
Expected: PASS. If `standalone-host` now waits on `house-automationd.service` readiness (Zigbee2MQTT has no radio in the VM, so `/healthz` stays 503), read the failure before changing anything. The fix belongs in the test's health expectations, not in the daemon.

- [ ] **Step 5: Commit**

```bash
git add nixos/hosts/home-server/default.nix nixos/modules/home-server-services.nix nixos/tests/home-server-services.nix nixos/tests/home-server.nix nixos/tests/fixtures/home-server-cd-module.nix
git commit -m "feat(home-server): run house-automationd with runtime-discovered devices"
```

### Task 13: README describes the no-PR flow

**Files:**
- Modify: `README.md:108-137` (section "Add a room, light, or control")

A documentation-only change; no test.

- [ ] **Step 1: Replace the section body** (keep the heading and the final "Scopes compose…" paragraph):

````markdown
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
````

- [ ] **Step 2: Full gate**

Run: `nix build --no-link -L .#checks.x86_64-linux.fmt .#checks.x86_64-linux.clippy .#checks.x86_64-linux.tests .#checks.x86_64-linux.pair-zigbee .#checks.x86_64-linux.house .#checks.x86_64-linux.module-vm .#checks.x86_64-linux.simulated-house`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add, name and move lights without a pull request"
```

---

## Risks / open points

1. **Scopes start on when discovery is enabled.** This follows the user's rule that every lamp follows the curve as soon as it registers. It changes the old default, where a new scope started off. On the first deploy after merge, the already-paired LED2111G6 turns on and follows `home-day` straight away (CD deploys to home-server on merge).
2. **Availability after a rename.** On a rename the daemon keeps the device's last known availability. I did not confirm from Zigbee2MQTT source whether it republishes availability on the new topic and clears the old one; the fake bridge does both. The old retained topics stay subscribed until the next reconnect. Anything arriving there is ignored, and a `/get` read (never a `/set`) already queued under the old name may still go out.
3. **The fixture's `exposes` are reconstructed.** The LED2111G6 `exposes` follow Z2M's published definition, but the exact text (description, presets) is not from a capture. If you want a real capture, replace the fixture with `mosquitto_sub -h 127.0.0.1 -t zigbee2mqtt/bridge/devices -C 1` from home-server. The fixture uses the real IEEE address as instructed, which goes against the fixtures README ("no real IEEE addresses"); the plan amends that README.
4. **Endpoint name.** The spec says `/health`. The daemon actually serves `/healthz`, plus the new `/devices` on the same loopback listener, so that `/healthz` keeps its existing "no device names" invariant. `house` assumes port 9876 unless `SMARTHOME_HEALTH_PORT` is set.
5. **`house identify` has side effects.** It writes the device option `identify_timeout` through `bridge/request/device/options`, which persists in `devices.yaml`. A daemon refresh during a breathe effect may cut the effect short.
6. **Some devices are deliberately not controlled.** Devices with `supported: false` (including Z2M 2.x generated definitions), `disabled: true` or an incomplete interview are skipped, even when they expose a light. The spec only names unmappable exposes as a reason, so confirm this is acceptable.
7. **Relaxed control validation.** With discovery on, a control's action is no longer checked against device capabilities at config time. A press on a scope with no lights becomes a logged no-op instead of a daemon error (the old error path would have stopped the daemon).
8. **Room ids are global.** Only declared rooms enforce their floor. Two implicit rooms with the same id on different floors both act as one membership target. This is harmless today, because only declared scopes can be targeted.
9. **`standalone-host` not inspected.** I did not read `nixos/tests/standalone-host.nix`. Enabling the daemon on the host may change what it expects (see Task 12, Step 4).
10. **`mosquitto_sub` buffering.** The VM checks use `stdbuf -oL mosquitto_sub` to record traffic. If output is still block-buffered, the counts in `nix/tests/house.nix` lag behind and the timing-based asserts can flake.

### Critical Files for Implementation
- /home/jonathan/worktrees/smarthome-upper-hallway-lamp/house-automationd/src/runtime.rs
- /home/jonathan/worktrees/smarthome-upper-hallway-lamp/house-automationd/src/discovery.rs (new)
- /home/jonathan/worktrees/smarthome-upper-hallway-lamp/house-automationd/src/zigbee2mqtt.rs
- /home/jonathan/worktrees/smarthome-upper-hallway-lamp/house-automationd/src/config.rs
- /home/jonathan/worktrees/smarthome-upper-hallway-lamp/nix/house.sh (new)
