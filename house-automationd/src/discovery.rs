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
            Self::TooLarge => write!(
                formatter,
                "device list exceeds {MAX_BRIDGE_DEVICES_BYTES} bytes"
            ),
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
    let (Some(floor), Some(room), Some(device), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
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
                vendor: device
                    .definition
                    .as_ref()
                    .map(|definition| definition.vendor.clone()),
                model: device
                    .definition
                    .as_ref()
                    .map(|definition| definition.model.clone()),
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
