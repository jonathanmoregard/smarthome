use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt::{self, Display},
};

use house_automation_core::{
    input::{Direction, RawInputEvent},
    reconcile::{Availability, CommandEntity, DeviceId, EntityId, ReconcileAction},
    state::ControlId,
    value::{Brightness, Color, DeviceTarget, Kelvin},
};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MiredRange {
    min: u16,
    max: u16,
}

impl MiredRange {
    pub fn new(min: u16, max: u16) -> Result<Self, AdapterError> {
        if min == 0 || min > max {
            return Err(AdapterError::configuration(
                "mired range must be positive and ordered",
            ));
        }
        Ok(Self { min, max })
    }

    fn contains(self, value: u16) -> bool {
        (self.min..=self.max).contains(&value)
    }

    fn clamp(self, value: f64) -> u16 {
        value
            .round()
            .clamp(f64::from(self.min), f64::from(self.max)) as u16
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceBinding {
    id: DeviceId,
    friendly_name: String,
    mired_range: MiredRange,
    single_transition_attribute: bool,
}

impl DeviceBinding {
    pub fn new(
        id: DeviceId,
        friendly_name: impl Into<String>,
        mired_range: MiredRange,
        single_transition_attribute: bool,
    ) -> Result<Self, AdapterError> {
        Ok(Self {
            id,
            friendly_name: validate_friendly_name(friendly_name.into())?,
            mired_range,
            single_transition_attribute,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupBinding {
    id: EntityId,
    friendly_name: String,
    mired_range: MiredRange,
    single_transition_attribute: bool,
}

impl GroupBinding {
    pub fn new(
        id: EntityId,
        friendly_name: impl Into<String>,
        mired_range: MiredRange,
        single_transition_attribute: bool,
    ) -> Result<Self, AdapterError> {
        Ok(Self {
            id,
            friendly_name: validate_friendly_name(friendly_name.into())?,
            mired_range,
            single_transition_attribute,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlBinding {
    id: ControlId,
    friendly_name: String,
}

impl ControlBinding {
    pub fn new(id: ControlId, friendly_name: impl Into<String>) -> Result<Self, AdapterError> {
        Ok(Self {
            id,
            friendly_name: validate_friendly_name(friendly_name.into())?,
        })
    }
}

fn validate_friendly_name(value: String) -> Result<String, AdapterError> {
    let terminal = value.rsplit('/').next().unwrap_or_default();
    let forbidden_terminal = matches!(terminal, "left" | "right" | "set" | "get" | "availability")
        || terminal.chars().all(|character| character.is_ascii_digit());
    if value.is_empty()
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\0', '#', '+'])
        || forbidden_terminal
    {
        return Err(AdapterError::configuration(
            "invalid Zigbee2MQTT friendly name",
        ));
    }
    Ok(value)
}

fn validate_base_topic(value: &str) -> Result<(), AdapterError> {
    if value.is_empty()
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\0', '#', '+'])
    {
        return Err(AdapterError::configuration(
            "invalid Zigbee2MQTT base topic",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
enum StateBinding {
    Device(DeviceBinding),
    Control(ControlBinding),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Zigbee2MqttAdapter {
    base_topic: String,
    state_topics: BTreeMap<String, StateBinding>,
    availability_topics: BTreeMap<String, DeviceBinding>,
    devices: BTreeMap<DeviceId, DeviceBinding>,
    groups: BTreeMap<EntityId, GroupBinding>,
}

impl Zigbee2MqttAdapter {
    pub fn new(
        base_topic: impl Into<String>,
        devices: Vec<DeviceBinding>,
        groups: Vec<GroupBinding>,
        controls: Vec<ControlBinding>,
    ) -> Result<Self, AdapterError> {
        let base_topic = base_topic.into();
        validate_base_topic(&base_topic)?;
        let bridge_topic = format!("{base_topic}/bridge/state");
        let mut state_topics = BTreeMap::new();
        let mut availability_topics = BTreeMap::new();
        let mut device_map = BTreeMap::new();
        let mut group_map = BTreeMap::new();
        let mut friendly_names = BTreeSet::new();
        let mut inbound_topics = BTreeSet::from([bridge_topic.clone()]);

        for binding in devices {
            let state_topic = format!("{base_topic}/{}", binding.friendly_name);
            let availability_topic = format!("{state_topic}/availability");
            if !friendly_names.insert(binding.friendly_name.clone())
                || !inbound_topics.insert(state_topic.clone())
                || !inbound_topics.insert(availability_topic.clone())
                || state_topics
                    .insert(state_topic, StateBinding::Device(binding.clone()))
                    .is_some()
                || availability_topics
                    .insert(availability_topic, binding.clone())
                    .is_some()
                || device_map.insert(binding.id.clone(), binding).is_some()
            {
                return Err(AdapterError::configuration(
                    "duplicate or reserved Zigbee2MQTT device binding",
                ));
            }
        }
        for binding in controls {
            let topic = format!("{base_topic}/{}", binding.friendly_name);
            if !friendly_names.insert(binding.friendly_name.clone())
                || !inbound_topics.insert(topic.clone())
                || state_topics
                    .insert(topic, StateBinding::Control(binding))
                    .is_some()
            {
                return Err(AdapterError::configuration(
                    "duplicate or reserved Zigbee2MQTT control binding",
                ));
            }
        }
        for binding in groups {
            let topic = format!("{base_topic}/{}", binding.friendly_name);
            if !friendly_names.insert(binding.friendly_name.clone())
                || inbound_topics.contains(&topic)
                || group_map.insert(binding.id.clone(), binding).is_some()
            {
                return Err(AdapterError::configuration(
                    "duplicate or reserved Zigbee2MQTT group binding",
                ));
            }
        }

        Ok(Self {
            base_topic,
            state_topics,
            availability_topics,
            devices: device_map,
            groups: group_map,
        })
    }

    pub fn parse(&self, topic: &str, payload: &[u8]) -> Result<Option<InboundEvent>, AdapterError> {
        if topic == format!("{}/bridge/state", self.base_topic) {
            return parse_availability(topic, payload)
                .map(|availability| Some(InboundEvent::BridgeAvailability(availability)));
        }
        if let Some(binding) = self.availability_topics.get(topic) {
            return parse_availability(&binding.friendly_name, payload).map(|availability| {
                Some(InboundEvent::DeviceAvailability {
                    device: binding.id.clone(),
                    availability,
                })
            });
        }
        match self.state_topics.get(topic) {
            Some(StateBinding::Device(binding)) => {
                parse_device_state(binding, payload).map(|state| {
                    Some(InboundEvent::DeviceState {
                        device: binding.id.clone(),
                        state,
                    })
                })
            }
            Some(StateBinding::Control(binding)) => parse_control_input(binding, payload),
            None => Ok(None),
        }
    }

    pub fn subscriptions(&self) -> Vec<Subscription> {
        let topics: BTreeSet<_> = std::iter::once(format!("{}/bridge/state", self.base_topic))
            .chain(self.state_topics.keys().cloned())
            .chain(self.availability_topics.keys().cloned())
            .collect();
        topics.into_iter().map(Subscription::new).collect()
    }

    pub fn apply_actions(&self, actions: &[ReconcileAction]) -> Result<AdapterPlan, AdapterError> {
        let mut plan = AdapterPlan::default();
        for action in actions {
            match action {
                ReconcileAction::Resubscribe => plan.subscriptions.extend(self.subscriptions()),
                ReconcileAction::RequestState(id) => {
                    let binding = self.devices.get(id).ok_or_else(|| {
                        AdapterError::configuration(format!("unbound device {}", id.as_str()))
                    })?;
                    let read = Map::from_iter([
                        ("state".to_owned(), Value::String(String::new())),
                        ("brightness".to_owned(), Value::String(String::new())),
                        ("color_temp".to_owned(), Value::String(String::new())),
                    ]);
                    plan.publications.push(Publication::json(
                        format!("{}/{}/get", self.base_topic, binding.friendly_name),
                        &read,
                    )?);
                }
                ReconcileAction::Command { entity, target } => {
                    let (friendly_name, mired_range, split) = match entity {
                        CommandEntity::Device(id) => {
                            let binding = self.devices.get(id).ok_or_else(|| {
                                AdapterError::configuration(format!(
                                    "unbound device {}",
                                    id.as_str()
                                ))
                            })?;
                            (
                                binding.friendly_name.as_str(),
                                binding.mired_range,
                                binding.single_transition_attribute,
                            )
                        }
                        CommandEntity::Group(id) => {
                            let binding = self.groups.get(id).ok_or_else(|| {
                                AdapterError::configuration(format!(
                                    "unbound group {}",
                                    id.as_str()
                                ))
                            })?;
                            (
                                binding.friendly_name.as_str(),
                                binding.mired_range,
                                binding.single_transition_attribute,
                            )
                        }
                    };
                    for payload in command_payloads(*target, mired_range, split) {
                        plan.publications.push(Publication::json(
                            format!("{base}/{friendly_name}/set", base = self.base_topic),
                            &payload,
                        )?);
                    }
                }
            }
        }
        Ok(plan)
    }
}

fn parse_json_object(context: &str, payload: &[u8]) -> Result<Map<String, Value>, AdapterError> {
    let value: Value = serde_json::from_slice(payload)
        .map_err(|error| AdapterError::message(context, format!("invalid JSON: {error}")))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| AdapterError::message(context, "payload must be a JSON object"))
}

fn parse_availability(context: &str, payload: &[u8]) -> Result<Availability, AdapterError> {
    let state = match serde_json::from_slice::<Value>(payload) {
        Ok(Value::String(state)) => state,
        Ok(Value::Object(object)) => object
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::message(context, "availability.state must be a string"))?
            .to_owned(),
        Ok(_) => {
            return Err(AdapterError::message(
                context,
                "availability payload must be a string or object",
            ));
        }
        Err(_) => std::str::from_utf8(payload)
            .map_err(|_| AdapterError::message(context, "availability payload is not UTF-8"))?
            .to_owned(),
    };
    match state.as_str() {
        "online" => Ok(Availability::Online),
        "offline" => Ok(Availability::Offline),
        "unknown" => Ok(Availability::Unknown),
        _ => Err(AdapterError::message(context, "unknown availability state")),
    }
}

fn parse_device_state(
    binding: &DeviceBinding,
    payload: &[u8],
) -> Result<DeviceTarget, AdapterError> {
    let context = binding.friendly_name.as_str();
    let object = parse_json_object(context, payload)?;
    let on = object
        .get("state")
        .map(|value| match value.as_str() {
            Some("ON") => Ok(true),
            Some("OFF") => Ok(false),
            _ => Err(AdapterError::message(context, "state must be ON or OFF")),
        })
        .transpose()?;
    let brightness = object
        .get("brightness")
        .map(|value| {
            let raw = value.as_u64().ok_or_else(|| {
                AdapterError::message(context, "brightness must be an integer from 0 to 254")
            })?;
            if raw > 254 {
                return Err(AdapterError::message(
                    context,
                    "brightness must be an integer from 0 to 254",
                ));
            }
            Brightness::new(raw as f64 / 254.0)
                .map_err(|error| AdapterError::message(context, error.to_string()))
        })
        .transpose()?;
    let color_temperature = object
        .get("color_temp")
        .map(|value| {
            let raw = value
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .ok_or_else(|| {
                    AdapterError::message(
                        context,
                        "color_temp must be a positive integer mired value",
                    )
                })?;
            if !binding.mired_range.contains(raw) {
                return Err(AdapterError::message(
                    context,
                    "color_temp is outside configured mired range",
                ));
            }
            Kelvin::new(1_000_000.0 / f64::from(raw))
                .map_err(|error| AdapterError::message(context, error.to_string()))
        })
        .transpose()?;
    let color = object
        .get("color")
        .map(|value| parse_color(context, value))
        .transpose()?;
    let transition_ms = object
        .get("transition")
        .map(|value| parse_transition(context, value))
        .transpose()?;

    Ok(DeviceTarget {
        on,
        brightness,
        color_temperature: if color.is_some() {
            None
        } else {
            color_temperature
        },
        color,
        transition_ms,
    })
}

fn parse_color(context: &str, value: &Value) -> Result<Color, AdapterError> {
    let object = value
        .as_object()
        .ok_or_else(|| AdapterError::message(context, "color must be an object"))?;
    if object.contains_key("x") || object.contains_key("y") {
        let x = finite_number(context, object.get("x"), "color.x")?;
        let y = finite_number(context, object.get("y"), "color.y")?;
        Color::xy(x, y).map_err(|error| AdapterError::message(context, error.to_string()))
    } else if object.contains_key("hue") || object.contains_key("saturation") {
        let hue = finite_number(context, object.get("hue"), "color.hue")?;
        let saturation = finite_number(context, object.get("saturation"), "color.saturation")?;
        Color::hs(hue, saturation / 100.0)
            .map_err(|error| AdapterError::message(context, error.to_string()))
    } else {
        Err(AdapterError::message(
            context,
            "color needs x/y or hue/saturation",
        ))
    }
}

fn finite_number(context: &str, value: Option<&Value>, field: &str) -> Result<f64, AdapterError> {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| AdapterError::message(context, format!("{field} must be finite number")))?;
    Ok(value)
}

fn parse_transition(context: &str, value: &Value) -> Result<u64, AdapterError> {
    let seconds = value
        .as_f64()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .ok_or_else(|| AdapterError::message(context, "transition must be nonnegative seconds"))?;
    let milliseconds = seconds * 1000.0;
    if milliseconds > u64::MAX as f64 {
        return Err(AdapterError::message(context, "transition is too large"));
    }
    Ok(milliseconds.round() as u64)
}

fn parse_control_input(
    binding: &ControlBinding,
    payload: &[u8],
) -> Result<Option<InboundEvent>, AdapterError> {
    let object = parse_json_object(&binding.friendly_name, payload)?;
    let Some(action) = object.get("action") else {
        return Ok(None);
    };
    let action = action
        .as_str()
        .ok_or_else(|| AdapterError::message(&binding.friendly_name, "action must be a string"))?;
    let event = match action {
        "toggle" => RawInputEvent::CenterShort,
        "toggle_hold" => RawInputEvent::CenterLong,
        "brightness_up_click" => RawInputEvent::Up,
        "brightness_up_hold" => RawInputEvent::DirectionHold(Direction::Up),
        "brightness_up_release" => RawInputEvent::DirectionRelease(Direction::Up),
        "brightness_down_click" => RawInputEvent::Down,
        "brightness_down_hold" => RawInputEvent::DirectionHold(Direction::Down),
        "brightness_down_release" => RawInputEvent::DirectionRelease(Direction::Down),
        "arrow_left_click" => RawInputEvent::Left,
        "arrow_left_hold" => RawInputEvent::DirectionHold(Direction::Left),
        "arrow_left_release" => RawInputEvent::DirectionRelease(Direction::Left),
        "arrow_right_click" => RawInputEvent::Right,
        "arrow_right_hold" => RawInputEvent::DirectionHold(Direction::Right),
        "arrow_right_release" => RawInputEvent::DirectionRelease(Direction::Right),
        _ => {
            return Ok(Some(InboundEvent::UnknownInputAction {
                control: binding.id.clone(),
                action: action.to_owned(),
            }));
        }
    };
    Ok(Some(InboundEvent::Input {
        control: binding.id.clone(),
        event,
    }))
}

fn command_payloads(
    target: DeviceTarget,
    mired_range: MiredRange,
    single_transition_attribute: bool,
) -> Vec<Map<String, Value>> {
    let split = single_transition_attribute
        && target.transition_ms.is_some()
        && target.brightness.is_some()
        && target.color_temperature.is_some()
        && target.color.is_none();
    if split {
        let mut brightness = Map::new();
        add_power(&mut brightness, target.on);
        add_brightness(&mut brightness, target.brightness);
        add_transition(&mut brightness, target.transition_ms);
        let mut color_temperature = Map::new();
        add_color_temperature(
            &mut color_temperature,
            target.color_temperature,
            mired_range,
        );
        add_transition(&mut color_temperature, target.transition_ms);
        return vec![brightness, color_temperature];
    }

    let mut payload = Map::new();
    add_power(&mut payload, target.on);
    add_brightness(&mut payload, target.brightness);
    if let Some(color) = target.color {
        add_color(&mut payload, color);
    } else {
        add_color_temperature(&mut payload, target.color_temperature, mired_range);
    }
    if target.brightness.is_some() || target.color_temperature.is_some() || target.color.is_some() {
        add_transition(&mut payload, target.transition_ms);
    }
    if payload.is_empty() {
        Vec::new()
    } else {
        vec![payload]
    }
}

fn add_power(payload: &mut Map<String, Value>, on: Option<bool>) {
    if let Some(on) = on {
        payload.insert(
            "state".to_owned(),
            Value::String(if on { "ON" } else { "OFF" }.to_owned()),
        );
    }
}

fn add_brightness(payload: &mut Map<String, Value>, brightness: Option<Brightness>) {
    if let Some(brightness) = brightness {
        let raw = (brightness.get() * 254.0).round() as u64;
        payload.insert("brightness".to_owned(), Value::from(raw));
    }
}

fn add_color_temperature(
    payload: &mut Map<String, Value>,
    color_temperature: Option<Kelvin>,
    range: MiredRange,
) {
    if let Some(color_temperature) = color_temperature {
        let raw = range.clamp(1_000_000.0 / color_temperature.get());
        payload.insert("color_temp".to_owned(), Value::from(raw));
    }
}

fn add_color(payload: &mut Map<String, Value>, color: Color) {
    let mut encoded = Map::new();
    if let Some((x, y)) = color.xy_components() {
        encoded.insert("x".to_owned(), Value::from(x));
        encoded.insert("y".to_owned(), Value::from(y));
    } else if let Some((hue, saturation)) = color.hs_components() {
        encoded.insert("hue".to_owned(), Value::from(hue));
        encoded.insert("saturation".to_owned(), Value::from(saturation * 100.0));
    }
    payload.insert("color".to_owned(), Value::Object(encoded));
}

fn add_transition(payload: &mut Map<String, Value>, transition_ms: Option<u64>) {
    if let Some(transition_ms) = transition_ms {
        payload.insert(
            "transition".to_owned(),
            Value::from(transition_ms as f64 / 1000.0),
        );
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum InboundEvent {
    BridgeAvailability(Availability),
    DeviceAvailability {
        device: DeviceId,
        availability: Availability,
    },
    DeviceState {
        device: DeviceId,
        state: DeviceTarget,
    },
    Input {
        control: ControlId,
        event: RawInputEvent,
    },
    UnknownInputAction {
        control: ControlId,
        action: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    topic: String,
}

impl Subscription {
    fn new(topic: String) -> Self {
        Self { topic }
    }

    pub fn topic(&self) -> &str {
        &self.topic
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publication {
    topic: String,
    payload: Vec<u8>,
    retain: bool,
}

impl Publication {
    fn json(topic: String, payload: &Map<String, Value>) -> Result<Self, AdapterError> {
        Ok(Self {
            topic,
            payload: serde_json::to_vec(payload).map_err(|error| {
                AdapterError::configuration(format!("cannot encode command: {error}"))
            })?,
            retain: false,
        })
    }

    pub fn topic(&self) -> &str {
        &self.topic
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    pub fn retain(&self) -> bool {
        self.retain
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdapterPlan {
    subscriptions: Vec<Subscription>,
    publications: Vec<Publication>,
}

impl AdapterPlan {
    pub fn subscriptions(&self) -> &[Subscription] {
        &self.subscriptions
    }

    pub fn publications(&self) -> &[Publication] {
        &self.publications
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterError {
    context: String,
    reason: String,
}

impl AdapterError {
    fn configuration(reason: impl Into<String>) -> Self {
        Self {
            context: "configuration".to_owned(),
            reason: reason.into(),
        }
    }

    fn message(context: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            context: context.into(),
            reason: reason.into(),
        }
    }
}

impl Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.context, self.reason)
    }
}

impl Error for AdapterError {}

#[cfg(test)]
mod tests {
    use house_automation_core::{
        input::{Direction, Gesture, RawInputEvent},
        reconcile::{Availability, CommandEntity, DeviceId, EntityId, ReconcileAction},
        state::ControlId,
        value::{Brightness, Color, DeviceTarget, Kelvin},
    };
    use serde_json::{Value, json};

    use super::{
        AdapterPlan, DeviceBinding, GroupBinding, InboundEvent, MiredRange, Publication,
        Zigbee2MqttAdapter,
    };

    fn device_id(value: &str) -> DeviceId {
        DeviceId::new(value).unwrap()
    }

    fn control_id(value: &str) -> ControlId {
        ControlId::new(value).unwrap()
    }

    fn entity_id(value: &str) -> EntityId {
        EntityId::new(value).unwrap()
    }

    fn adapter(single_transition_attribute: bool) -> Zigbee2MqttAdapter {
        Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            vec![
                DeviceBinding::new(
                    device_id("ikea_lamp"),
                    "living/ikea lamp",
                    MiredRange::new(250, 454).unwrap(),
                    single_transition_attribute,
                )
                .unwrap(),
                DeviceBinding::new(
                    device_id("hue_lamp"),
                    "living/hue lamp",
                    MiredRange::new(153, 500).unwrap(),
                    false,
                )
                .unwrap(),
            ],
            vec![
                GroupBinding::new(
                    entity_id("living_group"),
                    "living/all lights",
                    MiredRange::new(153, 500).unwrap(),
                    false,
                )
                .unwrap(),
            ],
            vec![super::ControlBinding::new(control_id("living_remote"), "living/remote").unwrap()],
        )
        .unwrap()
    }

    fn command_target() -> DeviceTarget {
        DeviceTarget {
            on: Some(true),
            brightness: Some(Brightness::new(0.5).unwrap()),
            color_temperature: Some(Kelvin::new(2700.0).unwrap()),
            color: None,
            transition_ms: Some(750),
        }
    }

    fn object(publication: &Publication) -> Value {
        serde_json::from_slice(publication.payload()).unwrap()
    }

    #[test]
    fn exact_configured_friendly_names_may_contain_slashes() {
        let adapter = adapter(false);
        let event = adapter
            .parse(
                "zigbee2mqtt/living/ikea lamp",
                include_bytes!("../tests/fixtures/ikea-light-state.json"),
            )
            .unwrap();

        let InboundEvent::DeviceState { device, state } = event.unwrap() else {
            panic!("expected device state");
        };
        assert_eq!(device, device_id("ikea_lamp"));
        assert_eq!(state.on, Some(true));
        assert_eq!(state.brightness.unwrap().get(), 0.5);
        assert!((state.color_temperature.unwrap().get() - (1_000_000.0 / 370.0)).abs() < 0.01);
    }

    #[test]
    fn ambiguous_external_topics_are_rejected_at_configuration_time() {
        let range = MiredRange::new(250, 454).unwrap();
        let duplicate_groups = Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            Vec::new(),
            vec![
                GroupBinding::new(entity_id("group_a"), "same/topic", range, false).unwrap(),
                GroupBinding::new(entity_id("group_b"), "same/topic", range, false).unwrap(),
            ],
            Vec::new(),
        );
        assert!(duplicate_groups.is_err());

        assert!(
            DeviceBinding::new(
                device_id("looks_like_availability"),
                "room/lamp/availability",
                range,
                false,
            )
            .is_err()
        );

        for forbidden in ["1234", "room/1234", "room/left", "room/right", "room/set"] {
            assert!(
                DeviceBinding::new(device_id("lamp"), forbidden, range, false).is_err(),
                "accepted forbidden terminal segment {forbidden:?}"
            );
        }
    }

    #[test]
    fn partial_hue_state_ignores_unknown_fields() {
        let event = adapter(false)
            .parse(
                "zigbee2mqtt/living/hue lamp",
                include_bytes!("../tests/fixtures/hue-partial-state.json"),
            )
            .unwrap()
            .unwrap();
        let InboundEvent::DeviceState { state, .. } = event else {
            panic!("expected device state");
        };
        assert_eq!(state.on, None);
        assert_eq!(state.brightness, None);
        assert_eq!(state.color.unwrap().hs_components(), Some((210.0, 0.65)));
    }

    #[test]
    fn bridge_and_device_availability_are_parsed() {
        let adapter = adapter(false);
        assert_eq!(
            adapter
                .parse(
                    "zigbee2mqtt/bridge/state",
                    include_bytes!("../tests/fixtures/bridge-online.json"),
                )
                .unwrap(),
            Some(InboundEvent::BridgeAvailability(Availability::Online))
        );
        assert_eq!(
            adapter
                .parse(
                    "zigbee2mqtt/living/ikea lamp/availability",
                    include_bytes!("../tests/fixtures/device-offline.json"),
                )
                .unwrap(),
            Some(InboundEvent::DeviceAvailability {
                device: device_id("ikea_lamp"),
                availability: Availability::Offline,
            })
        );
    }

    #[test]
    fn all_verified_remote_actions_normalize_without_vendor_strings() {
        let fixture: Vec<Value> =
            serde_json::from_slice(include_bytes!("../tests/fixtures/remote-actions.json"))
                .unwrap();
        let expected = [
            RawInputEvent::CenterShort,
            RawInputEvent::CenterLong,
            RawInputEvent::Up,
            RawInputEvent::DirectionHold(Direction::Up),
            RawInputEvent::DirectionRelease(Direction::Up),
            RawInputEvent::Down,
            RawInputEvent::DirectionHold(Direction::Down),
            RawInputEvent::DirectionRelease(Direction::Down),
            RawInputEvent::Left,
            RawInputEvent::DirectionHold(Direction::Left),
            RawInputEvent::DirectionRelease(Direction::Left),
            RawInputEvent::Right,
            RawInputEvent::DirectionHold(Direction::Right),
            RawInputEvent::DirectionRelease(Direction::Right),
        ];
        assert_eq!(fixture.len(), expected.len());

        for (payload, expected) in fixture.iter().zip(expected) {
            assert_eq!(
                adapter(false)
                    .parse(
                        "zigbee2mqtt/living/remote",
                        serde_json::to_vec(payload).unwrap().as_slice(),
                    )
                    .unwrap(),
                Some(InboundEvent::Input {
                    control: control_id("living_remote"),
                    event: expected,
                })
            );
        }

        let _: Gesture = Gesture::DirectionHold(Direction::Left);
    }

    #[test]
    fn unknown_remote_action_is_reportable_not_a_stream_error() {
        assert_eq!(
            adapter(false)
                .parse(
                    "zigbee2mqtt/living/remote",
                    br#"{"action":"future_gesture"}"#,
                )
                .unwrap(),
            Some(InboundEvent::UnknownInputAction {
                control: control_id("living_remote"),
                action: "future_gesture".to_owned(),
            })
        );
    }

    #[test]
    fn invalid_protocol_values_have_contextual_errors() {
        let adapter = adapter(false);
        for payload in [
            br#"{"brightness":255}"#.as_slice(),
            br#"{"color_temp":249}"#.as_slice(),
            br#"{"color":{"x":1.2,"y":0.4}}"#.as_slice(),
            br#"{"state":"TOGGLE"}"#.as_slice(),
            br#"{"brightness":"bright"}"#.as_slice(),
        ] {
            let error = adapter
                .parse("zigbee2mqtt/living/ikea lamp", payload)
                .unwrap_err();
            assert!(error.to_string().contains("living/ikea lamp"), "{error}");
        }
    }

    #[test]
    fn combined_capable_command_uses_exact_fields_and_is_never_retained() {
        let plan = adapter(false)
            .apply_actions(&[ReconcileAction::Command {
                entity: CommandEntity::Device(device_id("ikea_lamp")),
                target: command_target(),
            }])
            .unwrap();
        assert_eq!(plan.publications().len(), 1);
        let publication = &plan.publications()[0];
        assert_eq!(publication.topic(), "zigbee2mqtt/living/ikea lamp/set");
        assert!(!publication.retain());
        assert_eq!(
            object(publication),
            json!({
                "state": "ON",
                "brightness": 127,
                "color_temp": 370,
                "transition": 0.75,
            })
        );
    }

    #[test]
    fn single_attribute_transition_splits_brightness_and_cct_sparsely() {
        let plan = adapter(true)
            .apply_actions(&[ReconcileAction::Command {
                entity: CommandEntity::Device(device_id("ikea_lamp")),
                target: command_target(),
            }])
            .unwrap();
        assert_eq!(plan.publications().len(), 2);
        assert_eq!(
            object(&plan.publications()[0]),
            json!({"state":"ON", "brightness":127, "transition":0.75})
        );
        assert_eq!(
            object(&plan.publications()[1]),
            json!({"color_temp":370, "transition":0.75})
        );
        assert!(
            plan.publications()
                .iter()
                .all(|publication| !publication.retain())
        );
    }

    #[test]
    fn explicit_color_wins_over_cct_and_hs_saturation_scales_to_percent() {
        let target = DeviceTarget {
            on: Some(true),
            brightness: None,
            color_temperature: Some(Kelvin::new(3000.0).unwrap()),
            color: Some(Color::hs(120.0, 0.25).unwrap()),
            transition_ms: None,
        };
        let plan = adapter(false)
            .apply_actions(&[ReconcileAction::Command {
                entity: CommandEntity::Device(device_id("hue_lamp")),
                target,
            }])
            .unwrap();
        assert_eq!(
            object(&plan.publications()[0]),
            json!({"state":"ON", "color":{"hue":120.0,"saturation":25.0}})
        );
    }

    #[test]
    fn kelvin_to_mired_rounds_and_clamps_to_configured_device_bounds() {
        let adapter = adapter(false);
        for (kelvin, expected) in [(4000.0, 250), (2700.0, 370), (1800.0, 454), (6500.0, 250)] {
            let target = DeviceTarget {
                on: None,
                brightness: None,
                color_temperature: Some(Kelvin::new(kelvin).unwrap()),
                color: None,
                transition_ms: None,
            };
            let plan = adapter
                .apply_actions(&[ReconcileAction::Command {
                    entity: CommandEntity::Device(device_id("ikea_lamp")),
                    target,
                }])
                .unwrap();
            assert_eq!(object(&plan.publications()[0])["color_temp"], expected);
        }
    }

    #[test]
    fn reconnect_plan_subscribes_and_nonretained_reads_exact_topics() {
        let adapter = adapter(false);
        let plan: AdapterPlan = adapter
            .apply_actions(&[
                ReconcileAction::Resubscribe,
                ReconcileAction::RequestState(device_id("ikea_lamp")),
            ])
            .unwrap();
        assert!(
            plan.subscriptions()
                .iter()
                .any(|subscription| subscription.topic() == "zigbee2mqtt/bridge/state")
        );
        assert!(
            plan.subscriptions()
                .iter()
                .any(|subscription| subscription.topic() == "zigbee2mqtt/living/ikea lamp")
        );
        assert_eq!(
            plan.publications()[0].topic(),
            "zigbee2mqtt/living/ikea lamp/get"
        );
        assert_eq!(
            object(&plan.publications()[0]),
            json!({"state":"", "brightness":"", "color_temp":""})
        );
        assert!(!plan.publications()[0].retain());
    }

    #[test]
    fn group_command_uses_configured_group_topic() {
        let plan = adapter(false)
            .apply_actions(&[ReconcileAction::Command {
                entity: CommandEntity::Group(entity_id("living_group")),
                target: command_target(),
            }])
            .unwrap();
        assert_eq!(
            plan.publications()[0].topic(),
            "zigbee2mqtt/living/all lights/set"
        );
    }
}
