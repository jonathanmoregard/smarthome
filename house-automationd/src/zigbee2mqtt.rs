use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt::{self, Display},
};

use house_automation_core::{
    input::{Direction, RawInputEvent},
    reconcile::{Availability, CommandEntity, DeviceId, DispatchToken, EntityId, ReconcileAction},
    state::{ControlId, MonotonicTime},
    value::{Brightness, Capabilities, Color, DeviceTarget, Kelvin},
};
use serde_json::{Map, Value};

const MAX_TOPIC_COMPONENT_LENGTH: usize = 256;
const MAX_UNKNOWN_ACTION_LENGTH: usize = 128;
/// Long circadian changes use sparse incremental commands, so adapter-side
/// hardware transitions are deliberately bounded to one minute.
pub const MAX_COMMAND_TRANSITION_MS: u64 = 60_000;

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

    pub fn min(self) -> u16 {
        self.min
    }

    pub fn max(self) -> u16 {
        self.max
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

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceBinding {
    id: DeviceId,
    friendly_name: String,
    capabilities: Capabilities,
    mired_range: Option<MiredRange>,
    single_transition_attribute: bool,
}

impl DeviceBinding {
    pub fn new(
        id: DeviceId,
        friendly_name: impl Into<String>,
        capabilities: Capabilities,
        mired_range: Option<MiredRange>,
        single_transition_attribute: bool,
    ) -> Result<Self, AdapterError> {
        if capabilities.color_temperature.is_some() != mired_range.is_some() {
            return Err(AdapterError::configuration(
                "mired range must be present exactly when color-temperature capability is present",
            ));
        }
        Ok(Self {
            id,
            friendly_name: validate_friendly_name(friendly_name.into())?,
            capabilities,
            mired_range,
            single_transition_attribute,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupBinding {
    id: EntityId,
    friendly_name: String,
    mired_range: Option<MiredRange>,
    single_transition_attribute: bool,
}

impl GroupBinding {
    pub fn new(
        id: EntityId,
        friendly_name: impl Into<String>,
        mired_range: Option<MiredRange>,
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
        || value.len() > MAX_TOPIC_COMPONENT_LENGTH
        || value.starts_with('/')
        || value.ends_with('/')
        || value == "bridge"
        || value.starts_with("bridge/")
        || value.chars().any(char::is_control)
        || value.contains(['#', '+'])
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
        || value.len() > MAX_TOPIC_COMPONENT_LENGTH
        || value.starts_with('/')
        || value.ends_with('/')
        || value.chars().any(char::is_control)
        || value.contains(['#', '+'])
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Qos {
    AtMostOnce,
    AtLeastOnce,
    ExactlyOnce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboundMessage<'a> {
    topic: &'a str,
    payload: &'a [u8],
    retain: bool,
    duplicate: bool,
    qos: Qos,
}

impl<'a> InboundMessage<'a> {
    pub fn new(topic: &'a str, payload: &'a [u8], retain: bool, duplicate: bool, qos: Qos) -> Self {
        Self {
            topic,
            payload,
            retain,
            duplicate,
            qos,
        }
    }

    pub fn topic(self) -> &'a str {
        self.topic
    }

    pub fn payload(self) -> &'a [u8] {
        self.payload
    }

    pub fn retain(self) -> bool {
        self.retain
    }

    pub fn duplicate(self) -> bool {
        self.duplicate
    }

    pub fn qos(self) -> Qos {
        self.qos
    }
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

    pub fn parse(
        &self,
        message: &InboundMessage<'_>,
    ) -> Result<Option<InboundEvent>, AdapterError> {
        let topic = message.topic;
        let payload = message.payload;
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
            // Action topics are subscribed at QoS 0, so MQTT does not redeliver
            // them. DUP may still be set by a publisher and is not evidence that
            // this process has already handled the event. Retained actions are
            // always stale and must never replay a physical gesture.
            Some(StateBinding::Control(_)) if message.retain => Ok(None),
            Some(StateBinding::Control(binding)) => parse_control_input(binding, payload),
            None => Ok(None),
        }
    }

    pub fn subscriptions(&self) -> Vec<Subscription> {
        let mut topics = BTreeMap::from([(
            format!("{}/bridge/state", self.base_topic),
            Qos::AtLeastOnce,
        )]);
        for (topic, binding) in &self.state_topics {
            let qos = match binding {
                StateBinding::Device(_) => Qos::AtLeastOnce,
                StateBinding::Control(_) => Qos::AtMostOnce,
            };
            topics.insert(topic.clone(), qos);
        }
        for topic in self.availability_topics.keys() {
            topics.insert(topic.clone(), Qos::AtLeastOnce);
        }
        topics
            .into_iter()
            .map(|(topic, qos)| Subscription::new(topic, qos))
            .collect()
    }

    pub fn apply_actions(
        &self,
        epoch: PlanEpoch,
        actions: &[ReconcileAction],
    ) -> Result<AdapterPlan, AdapterError> {
        let mut plan = AdapterPlan {
            epoch,
            operations: Vec::new(),
            dispatch_plans: Vec::new(),
        };
        if actions
            .iter()
            .any(|action| matches!(action, ReconcileAction::Resubscribe))
        {
            plan.operations.extend(
                self.subscriptions()
                    .into_iter()
                    .map(AdapterOperation::Subscribe),
            );
        }
        for id in actions.iter().filter_map(|action| match action {
            ReconcileAction::RequestState(id) => Some(id),
            _ => None,
        }) {
            let binding = self.devices.get(id).ok_or_else(|| {
                AdapterError::configuration(format!("unbound device {}", id.as_str()))
            })?;
            plan.operations
                .push(AdapterOperation::Publish(Publication::json(
                    format!("{}/{}/get", self.base_topic, binding.friendly_name),
                    &read_request(binding.capabilities),
                    Qos::AtLeastOnce,
                    0,
                    None,
                )?));
        }
        let mut timed_commands = Vec::new();
        let mut command_sequence = 0_usize;
        for action in actions {
            if let ReconcileAction::Command {
                token,
                entity,
                target,
            } = action
            {
                let (friendly_name, mired_range, split) = match entity {
                    CommandEntity::Device(id) => {
                        let binding = self.devices.get(id).ok_or_else(|| {
                            AdapterError::configuration(format!("unbound device {}", id.as_str()))
                        })?;
                        (
                            binding.friendly_name.as_str(),
                            binding.mired_range,
                            binding.single_transition_attribute,
                        )
                    }
                    CommandEntity::Group(id) => {
                        let binding = self.groups.get(id).ok_or_else(|| {
                            AdapterError::configuration(format!("unbound group {}", id.as_str()))
                        })?;
                        (
                            binding.friendly_name.as_str(),
                            binding.mired_range,
                            binding.single_transition_attribute,
                        )
                    }
                };
                let payloads = command_payloads(*target, mired_range, split)?;
                if payloads.is_empty() {
                    return Err(AdapterError::configuration(format!(
                        "command for {friendly_name} has no controllable fields"
                    )));
                }
                for timed in payloads {
                    timed_commands.push((
                        timed.not_before_ms,
                        command_sequence,
                        AdapterOperation::Publish(Publication::json(
                            format!("{base}/{friendly_name}/set", base = self.base_topic),
                            &timed.payload,
                            Qos::AtLeastOnce,
                            timed.not_before_ms,
                            Some(*token),
                        )?),
                    ));
                    command_sequence = command_sequence
                        .checked_add(1)
                        .ok_or_else(|| AdapterError::configuration("command sequence overflow"))?;
                }
            }
        }
        timed_commands
            .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        let mut dispatch_plans = BTreeMap::<DispatchToken, (usize, u64)>::new();
        for (_, _, operation) in &mut timed_commands {
            let AdapterOperation::Publish(publication) = operation else {
                unreachable!("timed commands contain publications only")
            };
            let token = publication
                .dispatch_token
                .expect("command publications always carry a dispatch token");
            let entry = dispatch_plans.entry(token).or_insert((0, 0));
            publication.dispatch_operation_index = Some(entry.0);
            entry.0 = entry
                .0
                .checked_add(1)
                .ok_or_else(|| AdapterError::configuration("dispatch operation count overflow"))?;
            entry.1 = entry.1.max(publication.not_before_ms);
        }
        plan.dispatch_plans = dispatch_plans
            .into_iter()
            .map(
                |(token, (operation_count, max_offset_ms))| DispatchPlanMetadata {
                    token,
                    operation_count,
                    max_offset_ms,
                },
            )
            .collect();
        plan.operations.extend(
            timed_commands
                .into_iter()
                .map(|(_, _, operation)| operation),
        );
        Ok(plan)
    }
}

fn read_request(capabilities: Capabilities) -> Map<String, Value> {
    let mut read = Map::new();
    if capabilities.on_off {
        read.insert("state".to_owned(), Value::String(String::new()));
    }
    if capabilities.dimming {
        read.insert("brightness".to_owned(), Value::String(String::new()));
    }
    if capabilities.color_temperature.is_some() {
        read.insert("color_temp".to_owned(), Value::String(String::new()));
    }
    let mut color = Map::new();
    if capabilities.color_xy {
        color.insert("x".to_owned(), Value::String(String::new()));
        color.insert("y".to_owned(), Value::String(String::new()));
    }
    if capabilities.color_hs {
        color.insert("hue".to_owned(), Value::String(String::new()));
        color.insert("saturation".to_owned(), Value::String(String::new()));
    }
    if !color.is_empty() {
        read.insert("color".to_owned(), Value::Object(color));
    }
    read
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
        .filter(|_| binding.capabilities.color_temperature.is_some())
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
            let range = binding.mired_range.ok_or_else(|| {
                AdapterError::configuration(format!(
                    "device {} has CCT state without a mired range",
                    binding.id.as_str()
                ))
            })?;
            if !range.contains(raw) {
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

    let (color_temperature, color) = match (color_temperature, color) {
        (Some(color_temperature), Some(color)) => {
            match object.get("color_mode").and_then(Value::as_str) {
                Some("color_temp") => (Some(color_temperature), None),
                Some("xy" | "hs") => (None, Some(color)),
                _ => (None, None),
            }
        }
        representations => representations,
    };

    Ok(DeviceTarget {
        on,
        brightness,
        color_temperature,
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
        "toggle" => RawInputEvent::AmbiguousCenterPrefix,
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
                action: truncate_utf8(action, MAX_UNKNOWN_ACTION_LENGTH),
            }));
        }
    };
    Ok(Some(InboundEvent::Input {
        control: binding.id.clone(),
        event,
    }))
}

struct TimedPayload {
    payload: Map<String, Value>,
    not_before_ms: u64,
}

fn command_payloads(
    target: DeviceTarget,
    mired_range: Option<MiredRange>,
    single_transition_attribute: bool,
) -> Result<Vec<TimedPayload>, AdapterError> {
    if target
        .transition_ms
        .is_some_and(|transition_ms| transition_ms > MAX_COMMAND_TRANSITION_MS)
    {
        return Err(AdapterError::configuration(format!(
            "transition exceeds maximum of {MAX_COMMAND_TRANSITION_MS} ms; use sparse incremental circadian commands instead"
        )));
    }
    if target.color.is_none() && target.color_temperature.is_some() && mired_range.is_none() {
        return Err(AdapterError::configuration(
            "color-temperature command requires a configured mired range",
        ));
    }
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
        )?;
        add_transition(&mut color_temperature, target.transition_ms);
        return Ok(vec![
            TimedPayload {
                payload: brightness,
                not_before_ms: 0,
            },
            TimedPayload {
                payload: color_temperature,
                not_before_ms: target.transition_ms.unwrap_or_default(),
            },
        ]);
    }

    let mut payload = Map::new();
    add_power(&mut payload, target.on);
    add_brightness(&mut payload, target.brightness);
    if let Some(color) = target.color {
        add_color(&mut payload, color);
    } else {
        add_color_temperature(&mut payload, target.color_temperature, mired_range)?;
    }
    if target.brightness.is_some() || target.color_temperature.is_some() || target.color.is_some() {
        add_transition(&mut payload, target.transition_ms);
    }
    if payload.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![TimedPayload {
            payload,
            not_before_ms: 0,
        }])
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
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
    range: Option<MiredRange>,
) -> Result<(), AdapterError> {
    if let Some(color_temperature) = color_temperature {
        let range = range.ok_or_else(|| {
            AdapterError::configuration(
                "color-temperature command requires a configured mired range",
            )
        })?;
        let raw = range.clamp(1_000_000.0 / color_temperature.get());
        payload.insert("color_temp".to_owned(), Value::from(raw));
    }
    Ok(())
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
    qos: Qos,
}

impl Subscription {
    fn new(topic: String, qos: Qos) -> Self {
        Self { topic, qos }
    }

    pub fn topic(&self) -> &str {
        &self.topic
    }

    pub fn qos(&self) -> Qos {
        self.qos
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publication {
    topic: String,
    payload: Vec<u8>,
    retain: bool,
    qos: Qos,
    not_before_ms: u64,
    dispatch_token: Option<DispatchToken>,
    dispatch_operation_index: Option<usize>,
}

impl Publication {
    fn json(
        topic: String,
        payload: &Map<String, Value>,
        qos: Qos,
        not_before_ms: u64,
        dispatch_token: Option<DispatchToken>,
    ) -> Result<Self, AdapterError> {
        Ok(Self {
            topic,
            payload: serde_json::to_vec(payload).map_err(|error| {
                AdapterError::configuration(format!("cannot encode command: {error}"))
            })?,
            retain: false,
            qos,
            not_before_ms,
            dispatch_token,
            dispatch_operation_index: None,
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

    pub fn qos(&self) -> Qos {
        self.qos
    }

    /// Minimum delay from the containing `AdapterPlan` epoch, not from the
    /// previous operation.
    pub fn not_before_ms(&self) -> u64 {
        self.not_before_ms
    }

    /// Correlates all command publications in one reconciler batch. Pair this
    /// with `dispatch_operation_index` when claiming the enqueue permit.
    pub fn dispatch_token(&self) -> Option<DispatchToken> {
        self.dispatch_token
    }

    /// Zero-based operation index within this publication's dispatch token.
    /// Reads carry no dispatch token and therefore no operation index.
    pub fn dispatch_operation_index(&self) -> Option<usize> {
        self.dispatch_operation_index
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterOperation {
    Subscribe(Subscription),
    Publish(Publication),
}

impl AdapterOperation {
    pub fn publication(&self) -> Option<&Publication> {
        match self {
            Self::Publish(publication) => Some(publication),
            Self::Subscribe(_) => None,
        }
    }

    pub fn subscription(&self) -> Option<&Subscription> {
        match self {
            Self::Subscribe(subscription) => Some(subscription),
            Self::Publish(_) => None,
        }
    }

    pub fn qos(&self) -> Qos {
        match self {
            Self::Subscribe(subscription) => subscription.qos(),
            Self::Publish(publication) => publication.qos(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct PlanEpoch(MonotonicTime);

impl PlanEpoch {
    pub fn new(monotonic_time: MonotonicTime) -> Self {
        Self(monotonic_time)
    }

    pub fn monotonic_time(self) -> MonotonicTime {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DispatchPlanMetadata {
    token: DispatchToken,
    operation_count: usize,
    max_offset_ms: u64,
}

impl DispatchPlanMetadata {
    pub fn token(self) -> DispatchToken {
        self.token
    }

    pub fn operation_count(self) -> usize {
        self.operation_count
    }

    pub fn max_offset_ms(self) -> u64 {
        self.max_offset_ms
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdapterPlan {
    epoch: PlanEpoch,
    operations: Vec<AdapterOperation>,
    dispatch_plans: Vec<DispatchPlanMetadata>,
}

impl AdapterPlan {
    /// Identifies the instant from which every operation's `not_before_ms` is
    /// measured. Executors must not reinterpret offsets relative to each prior
    /// publication.
    pub fn epoch(&self) -> PlanEpoch {
        self.epoch
    }

    /// Per-token registration data derived from the final globally ordered
    /// command publications. Register every entry with the reconciler before
    /// enqueueing any operation from this plan.
    pub fn dispatch_plans(&self) -> &[DispatchPlanMetadata] {
        &self.dispatch_plans
    }

    /// Ordered execution plan: subscriptions, reads, zero-delay commands, then
    /// delayed command phases. Equal offsets preserve input/action order.
    /// Before enqueueing every command, executors must claim its token and
    /// `dispatch_operation_index` with `Reconciler::claim_next_operation`, hold
    /// the returned permit across MQTT enqueue, and skip benign stale/already
    /// accepted claims.
    pub fn operations(&self) -> &[AdapterOperation] {
        &self.operations
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterError {
    context: String,
    reason: String,
    permanent: bool,
}

impl AdapterError {
    fn configuration(reason: impl Into<String>) -> Self {
        Self {
            context: "configuration".to_owned(),
            reason: reason.into(),
            permanent: true,
        }
    }

    fn message(context: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            context: context.into(),
            reason: reason.into(),
            permanent: false,
        }
    }

    /// Permanent errors are invalid adapter configuration/encoding and must
    /// cancel the staged token. Transient MQTT enqueue errors occur outside the
    /// adapter and use the reconciler's bounded dispatch backoff instead.
    pub fn is_permanent(&self) -> bool {
        self.permanent
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
        reconcile::{
            Availability, CommandEntity, DeviceDefinition, DeviceId, DispatchClaim, DispatchToken,
            EntityId, ReconcileAction, Reconciler, RetryPolicy,
        },
        state::{ControlId, MonotonicTime},
        value::{Brightness, Capabilities, Color, DeviceTarget, Kelvin, KelvinRange, LightTarget},
    };
    use serde_json::{Value, json};

    use super::{
        AdapterOperation, AdapterPlan, DeviceBinding, GroupBinding, InboundEvent, InboundMessage,
        MiredRange, PlanEpoch, Publication, Qos, Zigbee2MqttAdapter,
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

    fn capabilities() -> Capabilities {
        Capabilities {
            on_off: true,
            dimming: true,
            color_temperature: Some(KelvinRange::new(2200.0, 6500.0).unwrap()),
            color_xy: true,
            color_hs: true,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        }
    }

    fn dispatch_token() -> DispatchToken {
        let lamp = device_id("token_lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            RetryPolicy::new(2.0, 3).unwrap(),
        )
        .unwrap();
        reconciler
            .broker_connected(MonotonicTime::from_seconds(0.0).unwrap())
            .unwrap();
        let actions = reconciler
            .set_device_desired(
                &lamp,
                LightTarget {
                    on: true,
                    brightness: None,
                    color_temperature: None,
                    color: None,
                    transition_ms: None,
                },
                MonotonicTime::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        token
    }

    fn distinct_dispatch_tokens() -> (DispatchToken, DispatchToken) {
        let first = device_id("first_token_lamp");
        let second = device_id("second_token_lamp");
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(first.clone(), capabilities()),
                DeviceDefinition::new(second.clone(), capabilities()),
            ],
            Vec::new(),
            RetryPolicy::new(2.0, 3).unwrap(),
        )
        .unwrap();
        reconciler
            .broker_connected(MonotonicTime::from_seconds(0.0).unwrap())
            .unwrap();
        let first_actions = reconciler
            .set_device_desired(
                &first,
                LightTarget {
                    on: true,
                    brightness: None,
                    color_temperature: None,
                    color: None,
                    transition_ms: None,
                },
                MonotonicTime::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        let second_actions = reconciler
            .set_device_desired(
                &second,
                LightTarget {
                    on: true,
                    brightness: None,
                    color_temperature: None,
                    color: None,
                    transition_ms: None,
                },
                MonotonicTime::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        let ReconcileAction::Command { token: first, .. } = first_actions[0] else {
            unreachable!()
        };
        let ReconcileAction::Command { token: second, .. } = second_actions[0] else {
            unreachable!()
        };
        (first, second)
    }

    fn plan_epoch() -> PlanEpoch {
        PlanEpoch::new(MonotonicTime::from_seconds(42.0).unwrap())
    }

    fn parse(
        adapter: &Zigbee2MqttAdapter,
        topic: &str,
        payload: &[u8],
    ) -> Result<Option<InboundEvent>, super::AdapterError> {
        adapter.parse(&InboundMessage::new(
            topic,
            payload,
            false,
            false,
            Qos::AtLeastOnce,
        ))
    }

    fn publications(plan: &AdapterPlan) -> Vec<&Publication> {
        plan.operations()
            .iter()
            .filter_map(AdapterOperation::publication)
            .collect()
    }

    fn subscriptions(plan: &AdapterPlan) -> Vec<&super::Subscription> {
        plan.operations()
            .iter()
            .filter_map(AdapterOperation::subscription)
            .collect()
    }

    fn adapter(single_transition_attribute: bool) -> Zigbee2MqttAdapter {
        Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            vec![
                DeviceBinding::new(
                    device_id("ikea_lamp"),
                    "living/ikea lamp",
                    capabilities(),
                    Some(MiredRange::new(250, 454).unwrap()),
                    single_transition_attribute,
                )
                .unwrap(),
                DeviceBinding::new(
                    device_id("hue_lamp"),
                    "living/hue lamp",
                    capabilities(),
                    Some(MiredRange::new(153, 500).unwrap()),
                    false,
                )
                .unwrap(),
            ],
            vec![
                GroupBinding::new(
                    entity_id("living_group"),
                    "living/all lights",
                    Some(MiredRange::new(153, 500).unwrap()),
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

    fn target_for_test(brightness: f64) -> LightTarget {
        LightTarget {
            on: true,
            brightness: Some(Brightness::new(brightness).unwrap()),
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
        let event = parse(
            &adapter,
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
                GroupBinding::new(entity_id("group_a"), "same/topic", Some(range), false).unwrap(),
                GroupBinding::new(entity_id("group_b"), "same/topic", Some(range), false).unwrap(),
            ],
            Vec::new(),
        );
        assert!(duplicate_groups.is_err());

        assert!(
            DeviceBinding::new(
                device_id("looks_like_availability"),
                "room/lamp/availability",
                capabilities(),
                Some(range),
                false,
            )
            .is_err()
        );

        for forbidden in ["1234", "room/1234", "room/left", "room/right", "room/set"] {
            assert!(
                DeviceBinding::new(
                    device_id("lamp"),
                    forbidden,
                    capabilities(),
                    Some(range),
                    false,
                )
                .is_err(),
                "accepted forbidden terminal segment {forbidden:?}"
            );
        }
    }

    #[test]
    fn partial_hue_state_ignores_unknown_fields() {
        let event = parse(
            &adapter(false),
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
    fn cached_color_representations_follow_reported_active_color_mode() {
        let fixture: Vec<Value> =
            serde_json::from_slice(include_bytes!("../tests/fixtures/color-mode-states.json"))
                .unwrap();
        let mut states = Vec::new();
        for case in fixture {
            let payload = serde_json::to_vec(&case["payload"]).unwrap();
            let event = parse(&adapter(false), "zigbee2mqtt/living/hue lamp", &payload)
                .unwrap()
                .unwrap();
            let InboundEvent::DeviceState { state, .. } = event else {
                panic!("expected device state for {}", case["name"])
            };
            states.push(state);
        }

        assert!(states[0].color_temperature.is_some());
        assert!(states[0].color.is_none());
        assert!(states[1].color_temperature.is_none());
        assert_eq!(states[1].color.unwrap().xy_components(), Some((0.31, 0.33)));
        assert!(states[2].color_temperature.is_none());
        assert_eq!(
            states[2].color.unwrap().hs_components(),
            Some((210.0, 0.65))
        );
        for ambiguous in &states[3..] {
            assert!(ambiguous.color_temperature.is_none());
            assert!(ambiguous.color.is_none());
        }
    }

    #[test]
    fn bridge_and_device_availability_are_parsed() {
        let adapter = adapter(false);
        assert_eq!(
            parse(
                &adapter,
                "zigbee2mqtt/bridge/state",
                include_bytes!("../tests/fixtures/bridge-online.json"),
            )
            .unwrap(),
            Some(InboundEvent::BridgeAvailability(Availability::Online))
        );
        assert_eq!(
            parse(
                &adapter,
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
            RawInputEvent::AmbiguousCenterPrefix,
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
                parse(
                    &adapter(false),
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
            parse(
                &adapter(false),
                "zigbee2mqtt/living/remote",
                br#"{"action":"future_gesture"}"#,
            )
            .unwrap(),
            Some(InboundEvent::UnknownInputAction {
                control: control_id("living_remote"),
                action: "future_gesture".to_owned(),
            })
        );

        let long_action = "é".repeat(100);
        let payload = serde_json::to_vec(&json!({"action": long_action})).unwrap();
        let event = parse(&adapter(false), "zigbee2mqtt/living/remote", &payload)
            .unwrap()
            .unwrap();
        let InboundEvent::UnknownInputAction { action, .. } = event else {
            panic!("expected bounded unknown action")
        };
        assert!(action.len() <= super::MAX_UNKNOWN_ACTION_LENGTH);
        assert!(action.is_char_boundary(action.len()));
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
            let error = parse(&adapter, "zigbee2mqtt/living/ikea lamp", payload).unwrap_err();
            assert!(error.to_string().contains("living/ikea lamp"), "{error}");
        }
    }

    #[test]
    fn combined_capable_command_uses_exact_fields_and_is_never_retained() {
        let plan = adapter(false)
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token: dispatch_token(),
                    entity: CommandEntity::Device(device_id("ikea_lamp")),
                    target: command_target(),
                }],
            )
            .unwrap();
        let publications = publications(&plan);
        assert_eq!(publications.len(), 1);
        let publication = publications[0];
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
    fn empty_command_is_a_permanent_adapter_error_not_an_unregistered_plan() {
        let error = adapter(false)
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token: dispatch_token(),
                    entity: CommandEntity::Device(device_id("ikea_lamp")),
                    target: DeviceTarget {
                        on: None,
                        brightness: None,
                        color_temperature: None,
                        color: None,
                        transition_ms: None,
                    },
                }],
            )
            .unwrap_err();

        assert!(error.is_permanent());
    }

    #[test]
    fn single_attribute_transition_splits_brightness_and_cct_sparsely() {
        let plan = adapter(true)
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token: dispatch_token(),
                    entity: CommandEntity::Device(device_id("ikea_lamp")),
                    target: command_target(),
                }],
            )
            .unwrap();
        let publications = publications(&plan);
        assert_eq!(publications.len(), 2);
        assert_eq!(
            object(publications[0]),
            json!({"state":"ON", "brightness":127, "transition":0.75})
        );
        assert_eq!(
            object(publications[1]),
            json!({"color_temp":370, "transition":0.75})
        );
        assert!(publications.iter().all(|publication| !publication.retain()));
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
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token: dispatch_token(),
                    entity: CommandEntity::Device(device_id("hue_lamp")),
                    target,
                }],
            )
            .unwrap();
        let publications = publications(&plan);
        assert_eq!(
            object(publications[0]),
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
                .apply_actions(
                    plan_epoch(),
                    &[ReconcileAction::Command {
                        token: dispatch_token(),
                        entity: CommandEntity::Device(device_id("ikea_lamp")),
                        target,
                    }],
                )
                .unwrap();
            assert_eq!(object(publications(&plan)[0])["color_temp"], expected);
        }
    }

    #[test]
    fn reconnect_plan_subscribes_and_nonretained_reads_exact_topics() {
        let adapter = adapter(false);
        let plan: AdapterPlan = adapter
            .apply_actions(
                plan_epoch(),
                &[
                    ReconcileAction::Resubscribe,
                    ReconcileAction::RequestState(device_id("ikea_lamp")),
                ],
            )
            .unwrap();
        let subscriptions = subscriptions(&plan);
        let publications = publications(&plan);
        assert!(
            subscriptions
                .iter()
                .any(|subscription| subscription.topic() == "zigbee2mqtt/bridge/state")
        );
        assert!(
            subscriptions
                .iter()
                .any(|subscription| subscription.topic() == "zigbee2mqtt/living/ikea lamp")
        );
        assert_eq!(publications[0].topic(), "zigbee2mqtt/living/ikea lamp/get");
        assert_eq!(
            object(publications[0]),
            json!({
                "state":"",
                "brightness":"",
                "color_temp":"",
                "color":{"hue":"", "saturation":"", "x":"", "y":""}
            })
        );
        assert!(!publications[0].retain());
    }

    #[test]
    fn group_command_uses_configured_group_topic() {
        let plan = adapter(false)
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token: dispatch_token(),
                    entity: CommandEntity::Group(entity_id("living_group")),
                    target: command_target(),
                }],
            )
            .unwrap();
        let publications = publications(&plan);
        assert_eq!(publications[0].topic(), "zigbee2mqtt/living/all lights/set");
    }

    #[test]
    fn group_mired_range_is_optional_until_a_cct_target_is_emitted() {
        let adapter = Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            Vec::new(),
            vec![GroupBinding::new(entity_id("rgb_group"), "rgb group", None, false).unwrap()],
            Vec::new(),
        )
        .unwrap();
        let token = dispatch_token();
        let rgb = DeviceTarget {
            on: Some(true),
            brightness: None,
            color_temperature: Some(Kelvin::new(2700.0).unwrap()),
            color: Some(Color::xy(0.2, 0.3).unwrap()),
            transition_ms: None,
        };
        assert!(
            adapter
                .apply_actions(
                    plan_epoch(),
                    &[ReconcileAction::Command {
                        token,
                        entity: CommandEntity::Group(entity_id("rgb_group")),
                        target: rgb,
                    }],
                )
                .is_ok()
        );

        let cct = DeviceTarget {
            on: None,
            brightness: None,
            color_temperature: Some(Kelvin::new(2700.0).unwrap()),
            color: None,
            transition_ms: None,
        };
        let error = adapter
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token,
                    entity: CommandEntity::Group(entity_id("rgb_group")),
                    target: cct,
                }],
            )
            .unwrap_err();
        assert!(error.is_permanent());
    }

    #[test]
    fn retained_controls_are_ignored_but_qos0_dup_controls_and_retained_state_are_accepted() {
        let adapter = adapter(false);
        let control = InboundMessage::new(
            "zigbee2mqtt/living/remote",
            br#"{"action":"toggle"}"#,
            true,
            false,
            Qos::AtMostOnce,
        );
        assert_eq!(adapter.parse(&control).unwrap(), None);
        let duplicate = InboundMessage::new(
            "zigbee2mqtt/living/remote",
            br#"{"action":"toggle"}"#,
            false,
            true,
            Qos::AtMostOnce,
        );
        assert_eq!(
            adapter.parse(&duplicate).unwrap(),
            Some(InboundEvent::Input {
                control: control_id("living_remote"),
                event: RawInputEvent::AmbiguousCenterPrefix,
            })
        );

        let state = InboundMessage::new(
            "zigbee2mqtt/living/ikea lamp",
            include_bytes!("../tests/fixtures/ikea-light-state.json"),
            true,
            false,
            Qos::AtLeastOnce,
        );
        assert!(matches!(
            adapter.parse(&state).unwrap(),
            Some(InboundEvent::DeviceState { .. })
        ));
        let availability = InboundMessage::new(
            "zigbee2mqtt/living/ikea lamp/availability",
            include_bytes!("../tests/fixtures/device-offline.json"),
            true,
            false,
            Qos::AtLeastOnce,
        );
        assert!(matches!(
            adapter.parse(&availability).unwrap(),
            Some(InboundEvent::DeviceAvailability { .. })
        ));
    }

    #[test]
    fn plan_has_strict_subscribe_read_command_phases_and_explicit_qos() {
        let actions = [
            ReconcileAction::Command {
                token: dispatch_token(),
                entity: CommandEntity::Device(device_id("ikea_lamp")),
                target: command_target(),
            },
            ReconcileAction::RequestState(device_id("ikea_lamp")),
            ReconcileAction::Resubscribe,
        ];
        let plan = adapter(false)
            .apply_actions(plan_epoch(), &actions)
            .unwrap();
        assert_eq!(plan.epoch(), plan_epoch());
        let operations = plan.operations();
        let first_publish = operations
            .iter()
            .position(|operation| matches!(operation, AdapterOperation::Publish(_)))
            .unwrap();
        assert!(
            operations[..first_publish]
                .iter()
                .all(|operation| matches!(operation, AdapterOperation::Subscribe(_)))
        );
        let publications: Vec<_> = operations
            .iter()
            .filter_map(AdapterOperation::publication)
            .collect();
        assert!(publications[0].topic().ends_with("/get"));
        assert!(publications[1].topic().ends_with("/set"));
        let subscriptions: Vec<_> = operations
            .iter()
            .filter_map(AdapterOperation::subscription)
            .collect();
        assert_eq!(
            subscriptions
                .iter()
                .find(|subscription| subscription.topic() == "zigbee2mqtt/living/remote")
                .unwrap()
                .qos(),
            Qos::AtMostOnce
        );
        assert!(
            subscriptions
                .iter()
                .filter(|subscription| { subscription.topic() != "zigbee2mqtt/living/remote" })
                .all(|subscription| subscription.qos() == Qos::AtLeastOnce)
        );
        assert!(
            publications
                .iter()
                .all(|publication| publication.qos() == Qos::AtLeastOnce)
        );
        assert_eq!(publications[1].dispatch_token(), Some(dispatch_token()));
    }

    #[test]
    fn split_transition_delays_second_attribute_until_first_transition_finishes() {
        let token = dispatch_token();
        let plan = adapter(true)
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token,
                    entity: CommandEntity::Device(device_id("ikea_lamp")),
                    target: command_target(),
                }],
            )
            .unwrap();
        let publications: Vec<_> = plan
            .operations()
            .iter()
            .filter_map(AdapterOperation::publication)
            .collect();
        assert_eq!(publications[0].not_before_ms(), 0);
        assert_eq!(publications[1].not_before_ms(), 750);
        assert_eq!(publications[0].dispatch_operation_index(), Some(0));
        assert_eq!(publications[1].dispatch_operation_index(), Some(1));
        assert_eq!(plan.dispatch_plans().len(), 1);
        assert_eq!(plan.dispatch_plans()[0].token(), token);
        assert_eq!(plan.dispatch_plans()[0].operation_count(), 2);
        assert_eq!(plan.dispatch_plans()[0].max_offset_ms(), 750);
    }

    #[test]
    fn transition_delay_accepts_the_documented_limit_and_rejects_overflow() {
        let token = dispatch_token();
        let mut boundary = command_target();
        boundary.transition_ms = Some(super::MAX_COMMAND_TRANSITION_MS);
        let plan = adapter(true)
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token,
                    entity: CommandEntity::Device(device_id("ikea_lamp")),
                    target: boundary,
                }],
            )
            .unwrap();
        assert_eq!(
            plan.dispatch_plans()[0].max_offset_ms(),
            super::MAX_COMMAND_TRANSITION_MS
        );

        for invalid in [super::MAX_COMMAND_TRANSITION_MS + 1, u64::MAX] {
            let mut target = command_target();
            target.transition_ms = Some(invalid);
            let error = adapter(true)
                .apply_actions(
                    plan_epoch(),
                    &[ReconcileAction::Command {
                        token,
                        entity: CommandEntity::Device(device_id("ikea_lamp")),
                        target,
                    }],
                )
                .unwrap_err();
            assert!(error.is_permanent());
        }
    }

    #[test]
    fn command_offsets_are_plan_relative_and_globally_phase_sorted_stably() {
        let adapter = Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            vec![
                DeviceBinding::new(
                    device_id("a"),
                    "a",
                    capabilities(),
                    Some(MiredRange::new(153, 500).unwrap()),
                    true,
                )
                .unwrap(),
                DeviceBinding::new(
                    device_id("b"),
                    "b",
                    capabilities(),
                    Some(MiredRange::new(153, 500).unwrap()),
                    true,
                )
                .unwrap(),
            ],
            Vec::new(),
            Vec::new(),
        )
        .unwrap();
        let epoch = PlanEpoch::new(MonotonicTime::from_seconds(7.0).unwrap());
        let (first_token, second_token) = distinct_dispatch_tokens();
        let plan = adapter
            .apply_actions(
                epoch,
                &[
                    ReconcileAction::Command {
                        token: first_token,
                        entity: CommandEntity::Device(device_id("a")),
                        target: command_target(),
                    },
                    ReconcileAction::Command {
                        token: second_token,
                        entity: CommandEntity::Device(device_id("b")),
                        target: command_target(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(plan.epoch(), epoch);
        assert_eq!(
            plan.epoch().monotonic_time(),
            MonotonicTime::from_seconds(7.0).unwrap()
        );
        let publications = publications(&plan);
        assert_eq!(
            publications
                .iter()
                .map(|publication| (publication.topic(), publication.not_before_ms()))
                .collect::<Vec<_>>(),
            vec![
                ("zigbee2mqtt/a/set", 0),
                ("zigbee2mqtt/b/set", 0),
                ("zigbee2mqtt/a/set", 750),
                ("zigbee2mqtt/b/set", 750),
            ]
        );
        assert_eq!(
            publications
                .iter()
                .map(|publication| publication.dispatch_operation_index())
                .collect::<Vec<_>>(),
            vec![Some(0), Some(0), Some(1), Some(1)]
        );
        assert_eq!(plan.dispatch_plans().len(), 2);
        assert!(plan.dispatch_plans().iter().all(|dispatch| {
            dispatch.operation_count() == 2 && dispatch.max_offset_ms() == 750
        }));
    }

    #[test]
    fn delayed_publications_expose_tokens_that_new_desired_state_invalidates() {
        let lamp = device_id("lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            RetryPolicy::new(2.0, 3).unwrap(),
        )
        .unwrap();
        reconciler
            .broker_connected(MonotonicTime::from_seconds(0.0).unwrap())
            .unwrap();
        let adapter = Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            vec![
                DeviceBinding::new(
                    lamp.clone(),
                    "lamp",
                    capabilities(),
                    Some(MiredRange::new(153, 500).unwrap()),
                    true,
                )
                .unwrap(),
            ],
            Vec::new(),
            Vec::new(),
        )
        .unwrap();

        let old_actions = reconciler
            .set_device_desired(
                &lamp,
                target_for_test(0.5),
                MonotonicTime::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        let ReconcileAction::Command { token: old, .. } = old_actions[0] else {
            unreachable!()
        };
        let old_plan = adapter
            .apply_actions(
                PlanEpoch::new(MonotonicTime::from_seconds(1.0).unwrap()),
                &old_actions,
            )
            .unwrap();
        assert!(
            publications(&old_plan)
                .iter()
                .all(|publication| publication.dispatch_token() == Some(old))
        );
        let old_dispatch = &old_plan.dispatch_plans()[0];
        reconciler
            .register_dispatch_plan(
                old_dispatch.token(),
                old_plan.epoch().monotonic_time(),
                old_dispatch.operation_count(),
                old_dispatch.max_offset_ms(),
            )
            .unwrap();
        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(old, 0).unwrap() else {
            panic!("expected first old-plan operation")
        };
        permit
            .accepted(MonotonicTime::from_seconds(1.0).unwrap())
            .unwrap();

        let new_actions = reconciler
            .set_device_desired(
                &lamp,
                target_for_test(0.8),
                MonotonicTime::from_seconds(1.1).unwrap(),
            )
            .unwrap();
        let ReconcileAction::Command { token: new, .. } = new_actions[0] else {
            unreachable!()
        };
        let new_plan = adapter
            .apply_actions(
                PlanEpoch::new(MonotonicTime::from_seconds(1.1).unwrap()),
                &new_actions,
            )
            .unwrap();
        assert!(!reconciler.is_dispatch_token_valid(old));
        assert!(reconciler.is_dispatch_token_valid(new));
        assert!(matches!(
            reconciler.claim_next_operation(old, 1).unwrap(),
            DispatchClaim::Stale
        ));
        assert!(
            publications(&new_plan)
                .iter()
                .all(|publication| publication.dispatch_token() == Some(new))
        );
    }

    #[test]
    fn mired_range_is_required_exactly_for_cct_capability_and_commands() {
        let no_cct = Capabilities {
            color_temperature: None,
            ..capabilities()
        };
        assert!(
            DeviceBinding::new(
                device_id("rgb"),
                "rgb",
                no_cct,
                Some(MiredRange::new(153, 500).unwrap()),
                false,
            )
            .is_err()
        );
        assert!(DeviceBinding::new(device_id("cct"), "cct", capabilities(), None, false,).is_err());

        let adapter = Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            vec![DeviceBinding::new(device_id("rgb"), "rgb", no_cct, None, false).unwrap()],
            Vec::new(),
            Vec::new(),
        )
        .unwrap();
        let error = adapter
            .apply_actions(
                plan_epoch(),
                &[ReconcileAction::Command {
                    token: dispatch_token(),
                    entity: CommandEntity::Device(device_id("rgb")),
                    target: DeviceTarget {
                        on: None,
                        brightness: None,
                        color_temperature: Some(Kelvin::new(2700.0).unwrap()),
                        color: None,
                        transition_ms: None,
                    },
                }],
            )
            .unwrap_err();
        assert!(error.is_permanent());
    }

    #[test]
    fn adapter_failure_can_be_reported_without_spending_dispatch_attempt() {
        let lamp = device_id("unbound_lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            RetryPolicy::new(2.0, 3).unwrap(),
        )
        .unwrap();
        reconciler
            .broker_connected(MonotonicTime::from_seconds(0.0).unwrap())
            .unwrap();
        let actions = reconciler
            .set_device_desired(
                &lamp,
                LightTarget {
                    on: true,
                    brightness: None,
                    color_temperature: None,
                    color: None,
                    transition_ms: None,
                },
                MonotonicTime::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        let adapter =
            Zigbee2MqttAdapter::new("zigbee2mqtt", Vec::new(), Vec::new(), Vec::new()).unwrap();

        let error = adapter.apply_actions(plan_epoch(), &actions).unwrap_err();
        assert!(error.is_permanent());
        reconciler
            .cancel_dispatch(token, MonotonicTime::from_seconds(1.1).unwrap())
            .unwrap();
        assert!(
            reconciler
                .retry_due(MonotonicTime::from_seconds(100.0).unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );
    }

    #[test]
    fn sparse_reads_follow_device_capabilities() {
        let on_only = Capabilities {
            on_off: true,
            dimming: false,
            color_temperature: None,
            color_xy: false,
            color_hs: false,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        };
        let rgb = Capabilities {
            color_xy: true,
            ..on_only
        };
        let adapter = Zigbee2MqttAdapter::new(
            "zigbee2mqtt",
            vec![
                DeviceBinding::new(device_id("switch"), "switch", on_only, None, false).unwrap(),
                DeviceBinding::new(device_id("rgb"), "rgb", rgb, None, false).unwrap(),
            ],
            Vec::new(),
            Vec::new(),
        )
        .unwrap();
        let plan = adapter
            .apply_actions(
                plan_epoch(),
                &[
                    ReconcileAction::RequestState(device_id("switch")),
                    ReconcileAction::RequestState(device_id("rgb")),
                ],
            )
            .unwrap();
        let publications: Vec<_> = plan
            .operations()
            .iter()
            .filter_map(AdapterOperation::publication)
            .collect();
        assert_eq!(object(publications[0]), json!({"state":""}));
        assert_eq!(
            object(publications[1]),
            json!({"state":"", "color":{"x":"", "y":""}})
        );
        assert!(object(publications[1]).get("color_temp").is_none());
    }

    #[test]
    fn topic_names_reject_bridge_controls_and_excessive_length() {
        let capabilities = Capabilities {
            on_off: true,
            dimming: false,
            color_temperature: Some(KelvinRange::new(2200.0, 6500.0).unwrap()),
            color_xy: false,
            color_hs: false,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        };
        for name in ["bridge", "bridge/devices", "room\nlight"] {
            assert!(
                DeviceBinding::new(
                    device_id("lamp"),
                    name,
                    capabilities,
                    Some(MiredRange::new(153, 500).unwrap()),
                    false,
                )
                .is_err()
            );
        }
        assert!(
            Zigbee2MqttAdapter::new("x".repeat(257), Vec::new(), Vec::new(), Vec::new()).is_err()
        );
        assert!(Zigbee2MqttAdapter::new("bad\nbase", Vec::new(), Vec::new(), Vec::new()).is_err());
        assert!(
            DeviceBinding::new(
                device_id("lamp"),
                "x".repeat(257),
                capabilities,
                Some(MiredRange::new(153, 500).unwrap()),
                false,
            )
            .is_err()
        );
    }
}
