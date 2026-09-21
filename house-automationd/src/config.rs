//! Strict declarative configuration boundary.
//!
//! Deserialized values stay private. [`ValidatedConfig`] exposes only values
//! accepted by domain and adapter constructors.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt, fs,
    net::SocketAddr,
    path::PathBuf,
};

use chrono_tz::{Europe::Stockholm, Tz};
use house_automation_core::{
    curve::{CircadianCurve, CurveAnchor, TimeOfDay},
    input::{
        Action, AmbiguousHoldWindow, ClickClassifier, ClickWindow, Direction, Gesture, Mapping,
        MappingEntry, ScopeTarget,
    },
    overlay::{AcknowledgementSettings, OverlayDuration, OverlayEffect, OverlayId},
    reconcile::{
        ColorComparisonPolicy, ColorGamut, DeviceDefinition, DeviceId, EntityId, GroupDefinition,
        RetryPolicy,
    },
    state::{ControlId, ConvergenceDuration, Scope, ScopeId, ScopeMembership},
    value::{Brightness, Capabilities, Kelvin, KelvinRange},
};
use serde::Deserialize;

use crate::solar::{CircadianSchedule, Coordinates, MonthDay, SolarHybridCurve, WinterHold};
use crate::zigbee2mqtt::{
    ControlBinding, DeviceBinding, GroupBinding, MiredRange, Zigbee2MqttAdapter,
};

const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_TOPIC_LENGTH: usize = 256;

/// Upper bounds keep every accepted timer practical and losslessly convertible
/// to `std::time::Duration`/Tokio timers for one always-on house process.
pub const MAX_DOUBLE_CLICK_WINDOW_MS: u64 = 2_000;
pub const MAX_AMBIGUOUS_HOLD_WINDOW_MS: u64 = 10_000;
pub const MAX_UNFREEZE_CONVERGENCE_SECONDS: f64 = 3_600.0;
pub const MAX_SPARSE_TICK_SECONDS: f64 = 3_600.0;
pub const MAX_SPARSE_REFRESH_SECONDS: f64 = 86_400.0;
pub const MAX_ACKNOWLEDGEMENT_DURATION_MS: u64 = 5_000;
pub const MAX_WHOLE_HOUR_DURATION_MS: u64 = 60_000;
pub const MAX_RECONCILE_RETRY_INTERVAL_SECONDS: f64 = 3_600.0;
pub const MAX_DISPATCH_ACCEPTANCE_MARGIN_SECONDS: f64 = 300.0;
pub const MAX_DISPATCH_FAILURE_BACKOFF_SECONDS: f64 = 300.0;
pub const MIN_OPERATIONAL_DURATION_SECONDS: f64 = 0.001;

/// Fully validated runtime configuration.
pub struct ValidatedConfig {
    parts: RuntimeConfigParts,
}

impl ValidatedConfig {
    /// Parses at most 1 MiB of strict TOML and validates every reference.
    pub fn parse(input: &str) -> Result<Self, ConfigError> {
        if input.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::TooLarge {
                maximum_bytes: MAX_CONFIG_BYTES,
            });
        }
        let raw: RawConfig = toml::from_str(input).map_err(|error| {
            let (line, column) = error
                .span()
                .map(|span| line_column(input, span.start))
                .unwrap_or((0, 0));
            ConfigError::Parse { line, column }
        })?;
        raw.validate().map(|parts| Self { parts })
    }

    pub fn application_namespace(&self) -> &str {
        &self.parts.mqtt.application_namespace
    }

    pub fn double_click_window(&self) -> ClickWindow {
        self.parts.input.double_click_window
    }

    pub fn ambiguous_hold_window(&self) -> AmbiguousHoldWindow {
        self.parts.input.ambiguous_hold_window
    }

    pub fn daily_reset_time(&self) -> TimeOfDay {
        self.parts.circadian.daily_reset_time
    }

    pub fn convergence_duration_seconds(&self) -> f64 {
        self.parts.circadian.convergence_duration_seconds
    }

    pub fn whole_hour_duration_ms(&self) -> u64 {
        self.parts.whole_hour.duration_ms
    }

    pub fn device_count(&self) -> usize {
        self.parts.devices.len()
    }

    pub fn control_count(&self) -> usize {
        self.parts.controls.len()
    }

    pub fn into_runtime_parts(self) -> RuntimeConfigParts {
        self.parts
    }
}

impl fmt::Debug for ValidatedConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedConfig")
            .field("schema_version", &1)
            .field("mqtt", &"<redacted>")
            .field("topology", &"<redacted>")
            .field("credential_source", &"<redacted>")
            .field(
                "health_is_loopback",
                &self.parts.health.bind.ip().is_loopback(),
            )
            .finish()
    }
}

/// Owned, typed values consumed by daemon runtime.
pub struct RuntimeConfigParts {
    pub time_zone: Tz,
    pub mqtt: MqttSettings,
    pub input: InputSettings,
    pub circadian: CircadianSettings,
    pub acknowledgement: AcknowledgementSettings,
    pub acknowledgement_duration_ms: u64,
    pub whole_hour: WholeHourSettings,
    pub retry_policy: RetryPolicy,
    pub reconciliation_timing: ReconciliationTiming,
    pub health: HealthSettings,
    pub curves: BTreeMap<ScopeId, CircadianSchedule>,
    pub scopes: Vec<ScopeConfiguration>,
    pub devices: Vec<DeviceConfiguration>,
    pub groups: Vec<GroupConfiguration>,
    pub controls: Vec<ControlConfiguration>,
    pub zigbee2mqtt: Zigbee2MqttAdapter,
}

#[derive(Clone)]
pub struct MqttSettings {
    pub host: String,
    pub port: u16,
    pub client_id: String,
    pub application_namespace: String,
    pub zigbee2mqtt_base_topic: String,
    pub credentials: Option<MqttCredentialSource>,
}

impl fmt::Debug for MqttSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MqttSettings")
            .field("host", &"<redacted>")
            .field("port", &self.port)
            .field("client_id", &"<redacted>")
            .field("application_namespace", &"<redacted>")
            .field("zigbee2mqtt_base_topic", &"<redacted>")
            .field(
                "credentials",
                &self.credentials.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone)]
pub struct MqttCredentialSource {
    pub environment_file: PathBuf,
    pub username_variable: String,
    pub password_variable: String,
}

impl fmt::Debug for MqttCredentialSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MqttCredentialSource(<redacted>)")
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InputSettings {
    pub double_click_window: ClickWindow,
    pub ambiguous_hold_window: AmbiguousHoldWindow,
}

#[derive(Debug, Clone, Copy)]
pub struct CircadianSettings {
    pub daily_reset_time: TimeOfDay,
    pub convergence_duration: ConvergenceDuration,
    pub convergence_duration_seconds: f64,
    pub tick_seconds: f64,
    pub brightness_change_threshold: f64,
    pub color_temperature_change_threshold_kelvin: f64,
    pub maximum_refresh_seconds: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct WholeHourSettings {
    pub brightness_delta: f64,
    pub duration_ms: u64,
    pub priority: i32,
}

#[derive(Debug, Clone, Copy)]
pub struct ReconciliationTiming {
    pub retry_interval_seconds: f64,
    pub dispatch_acceptance_margin_seconds: f64,
    pub dispatch_failure_backoff_seconds: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct HealthSettings {
    pub bind: SocketAddr,
}

pub struct ScopeConfiguration {
    pub id: ScopeId,
    pub scope: Scope,
    pub curve: ScopeId,
}

pub struct DeviceConfiguration {
    pub id: DeviceId,
    pub definition: DeviceDefinition,
    pub binding: DeviceBinding,
    pub membership: ScopeMembership,
    pub aliases: Vec<DeviceId>,
    is_controllable_light: bool,
}

pub type GroupId = EntityId;

pub struct GroupConfiguration {
    pub id: GroupId,
    pub members: Vec<DeviceId>,
    pub mired_range: Option<MiredRange>,
    pub definition: GroupDefinition,
    pub binding: GroupBinding,
}

pub struct ControlConfiguration {
    pub id: ControlId,
    pub binding: ControlBinding,
    pub selected_scope: Scope,
    pub mapping: Mapping,
    pub acknowledgement_gestures: BTreeSet<Gesture>,
    pub aliases: Vec<ControlId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    TooLarge {
        maximum_bytes: usize,
    },
    Parse {
        line: usize,
        column: usize,
    },
    Validation {
        field: &'static str,
        reason: &'static str,
    },
}

impl ConfigError {
    fn validation(field: &'static str, reason: &'static str) -> Self {
        Self::Validation { field, reason }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { maximum_bytes } => {
                write!(
                    formatter,
                    "configuration exceeds {maximum_bytes} byte limit"
                )
            }
            Self::Parse { line, column } if *line > 0 => write!(
                formatter,
                "configuration syntax or schema is invalid near line {line}, column {column}"
            ),
            Self::Parse { .. } => formatter.write_str("configuration syntax or schema is invalid"),
            Self::Validation { field, reason } => {
                write!(formatter, "invalid {field}: {reason}")
            }
        }
    }
}

impl Error for ConfigError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    schema_version: u32,
    location: Option<RawLocation>,
    mqtt: RawMqtt,
    #[serde(default)]
    input: RawInput,
    #[serde(default)]
    circadian: RawCircadian,
    #[serde(default)]
    acknowledgement: RawAcknowledgement,
    #[serde(default)]
    whole_hour: RawWholeHour,
    #[serde(default)]
    reconciliation: RawReconciliation,
    #[serde(default)]
    health: RawHealth,
    floors: Vec<RawFloor>,
    rooms: Vec<RawRoom>,
    curves: Vec<RawCurve>,
    scopes: Vec<RawScope>,
    devices: Vec<RawDevice>,
    #[serde(default)]
    groups: Vec<RawGroup>,
    controls: Vec<RawControl>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLocation {
    latitude: f64,
    longitude: f64,
    time_zone: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMqtt {
    host: String,
    port: u16,
    client_id: String,
    #[serde(default = "default_application_namespace")]
    application_namespace: String,
    #[serde(default = "default_zigbee2mqtt_topic")]
    zigbee2mqtt_base_topic: String,
    credentials: Option<RawCredentials>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCredentials {
    environment_file: String,
    username_variable: String,
    password_variable: String,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawInput {
    double_click_window_ms: u64,
    ambiguous_center_hold_window_ms: u64,
}

impl Default for RawInput {
    fn default() -> Self {
        Self {
            double_click_window_ms: 350,
            ambiguous_center_hold_window_ms: 1_200,
        }
    }
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawCircadian {
    daily_reset_time: String,
    unfreeze_convergence_seconds: f64,
    tick_seconds: f64,
    brightness_change_threshold: f64,
    color_temperature_change_threshold_kelvin: f64,
    maximum_refresh_seconds: f64,
}

impl Default for RawCircadian {
    fn default() -> Self {
        Self {
            daily_reset_time: "04:00".to_owned(),
            unfreeze_convergence_seconds: 30.0,
            tick_seconds: 30.0,
            brightness_change_threshold: 0.01,
            color_temperature_change_threshold_kelvin: 25.0,
            maximum_refresh_seconds: 300.0,
        }
    }
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawAcknowledgement {
    overlay_id: String,
    amplitude: f64,
    duration_ms: u64,
    priority: i32,
}

impl Default for RawAcknowledgement {
    fn default() -> Self {
        Self {
            overlay_id: "circadian-ack".to_owned(),
            amplitude: 0.10,
            duration_ms: 180,
            priority: 100,
        }
    }
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawWholeHour {
    brightness_delta: f64,
    duration_ms: u64,
    priority: i32,
}

impl Default for RawWholeHour {
    fn default() -> Self {
        Self {
            brightness_delta: 0.08,
            duration_ms: 500,
            priority: 10,
        }
    }
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawReconciliation {
    retry_interval_seconds: f64,
    maximum_attempts: u8,
    dispatch_acceptance_margin_seconds: f64,
    dispatch_failure_backoff_seconds: f64,
}

impl Default for RawReconciliation {
    fn default() -> Self {
        Self {
            retry_interval_seconds: 5.0,
            maximum_attempts: 3,
            dispatch_acceptance_margin_seconds: 5.0,
            dispatch_failure_backoff_seconds: 0.5,
        }
    }
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawHealth {
    bind: String,
    allow_non_loopback: bool,
}

impl Default for RawHealth {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:9876".to_owned(),
            allow_non_loopback: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFloor {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRoom {
    id: String,
    floor: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCurve {
    id: String,
    #[serde(default)]
    kind: RawCurveKind,
    anchors: Option<Vec<RawAnchor>>,
    wake_time: Option<String>,
    bed_time: Option<String>,
    night_brightness: Option<f64>,
    day_brightness: Option<f64>,
    night_color_temperature_kelvin: Option<f64>,
    day_color_temperature_kelvin: Option<f64>,
    winter_hold: Option<RawWinterHold>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawCurveKind {
    #[default]
    Fixed,
    SolarHybrid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWinterHold {
    start: String,
    end: String,
    reference: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAnchor {
    time: String,
    brightness: f64,
    color_temperature_kelvin: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
enum RawScope {
    Room {
        id: String,
        room: String,
        curve: String,
    },
    Floor {
        id: String,
        floor: String,
        curve: String,
    },
    House {
        id: String,
        curve: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDevice {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    friendly_name: String,
    room: String,
    capabilities: RawCapabilities,
    color_comparison: Option<RawColorComparison>,
    #[serde(default)]
    single_transition_attribute: bool,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawCapabilities {
    on_off: bool,
    dimming: bool,
    color_temperature: Option<RawColorTemperature>,
    color_xy: bool,
    color_hs: bool,
    input: bool,
    occupancy: bool,
    temperature: bool,
    power_metering: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawColorTemperature {
    minimum_kelvin: f64,
    maximum_kelvin: f64,
    minimum_mired: Option<u16>,
    maximum_mired: Option<u16>,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawColorComparison {
    xy_tolerance: f64,
    achromatic_saturation_threshold: f64,
    gamut: Option<RawGamut>,
}

impl Default for RawColorComparison {
    fn default() -> Self {
        Self {
            xy_tolerance: 0.03,
            achromatic_saturation_threshold: 0.02,
            gamut: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGamut {
    red: [f64; 2],
    green: [f64; 2],
    blue: [f64; 2],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGroup {
    id: String,
    friendly_name: String,
    members: Vec<String>,
    capabilities: RawCapabilities,
    #[serde(default)]
    single_transition_attribute: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawControl {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    friendly_name: String,
    selected_scope: String,
    mappings: Vec<RawMapping>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMapping {
    gesture: String,
    target: String,
    action: RawAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
enum RawAction {
    AdjustBrightnessOffset { delta: f64 },
    AdjustColorTemperatureOffset { delta_kelvin: f64 },
    TogglePower,
    ToggleCircadianWithAcknowledgement,
    SelectScope,
}

fn default_application_namespace() -> String {
    "house/v1".to_owned()
}

fn default_zigbee2mqtt_topic() -> String {
    "zigbee2mqtt".to_owned()
}

impl RawConfig {
    fn validate(self) -> Result<RuntimeConfigParts, ConfigError> {
        if self.schema_version != 1 {
            return Err(ConfigError::validation(
                "schema_version",
                "only schema version 1 is supported",
            ));
        }
        let location = self.location.map(RawLocation::validate).transpose()?;
        let time_zone = location
            .as_ref()
            .map_or(Stockholm, |location| location.time_zone);
        let mqtt = self.mqtt.validate()?;
        let input = self.input.validate()?;
        let circadian = self.circadian.validate()?;
        let acknowledgement_duration_ms = self.acknowledgement.duration_ms;
        let acknowledgement = self.acknowledgement.validate()?;
        let whole_hour = self.whole_hour.validate()?;
        let reconciliation_timing = self.reconciliation.timing();
        let retry_policy = self.reconciliation.validate()?;
        let health = self.health.validate()?;
        let floors = validate_floors(self.floors)?;
        let rooms = validate_rooms(self.rooms, &floors)?;
        let curves = validate_curves(self.curves, location.as_ref())?;
        let (devices, device_caps, device_ids, aliases, device_bindings) =
            validate_devices(self.devices, &rooms)?;
        let (groups, group_bindings) = validate_groups(self.groups, &device_caps, &device_ids)?;
        let scopes = validate_scopes(self.scopes, &floors, &rooms, &curves, &devices)?;
        let (controls, control_bindings) =
            validate_controls(self.controls, &scopes, &devices, aliases)?;

        let zigbee2mqtt = Zigbee2MqttAdapter::new(
            mqtt.zigbee2mqtt_base_topic.clone(),
            device_bindings,
            group_bindings,
            control_bindings,
        )
        .map_err(|_| {
            ConfigError::validation(
                "zigbee2mqtt bindings",
                "names or topics are duplicate, reserved, or malformed",
            )
        })?;

        Ok(RuntimeConfigParts {
            time_zone,
            mqtt,
            input,
            circadian,
            acknowledgement,
            acknowledgement_duration_ms,
            whole_hour,
            retry_policy,
            reconciliation_timing,
            health,
            curves,
            scopes,
            devices,
            groups,
            controls,
            zigbee2mqtt,
        })
    }
}

#[derive(Clone, Copy)]
struct ValidatedLocation {
    coordinates: Coordinates,
    time_zone: Tz,
}

impl RawLocation {
    fn validate(self) -> Result<ValidatedLocation, ConfigError> {
        if !self.latitude.is_finite() || !(-90.0..=90.0).contains(&self.latitude) {
            return Err(ConfigError::validation(
                "location.latitude",
                "latitude must be finite and between -90 and 90",
            ));
        }
        if !self.longitude.is_finite() || !(-180.0..=180.0).contains(&self.longitude) {
            return Err(ConfigError::validation(
                "location.longitude",
                "longitude must be finite and between -180 and 180",
            ));
        }
        let time_zone = self.time_zone.parse::<Tz>().map_err(|_| {
            ConfigError::validation("location.time_zone", "must be a known IANA timezone")
        })?;
        let coordinates = Coordinates::new(self.latitude, self.longitude).map_err(|_| {
            ConfigError::validation("location", "coordinates must be finite and in range")
        })?;
        Ok(ValidatedLocation {
            coordinates,
            time_zone,
        })
    }
}

impl RawMqtt {
    fn validate(self) -> Result<MqttSettings, ConfigError> {
        if self.host.is_empty()
            || self.host.len() > MAX_TOPIC_LENGTH
            || self.host.chars().any(char::is_control)
            || self.port == 0
        {
            return Err(ConfigError::validation(
                "mqtt endpoint",
                "host must be non-empty and port must be non-zero",
            ));
        }
        validate_topic_namespace(&self.application_namespace, true)
            .map_err(|reason| ConfigError::validation("mqtt.application_namespace", reason))?;
        validate_topic_namespace(&self.zigbee2mqtt_base_topic, false)
            .map_err(|reason| ConfigError::validation("mqtt.zigbee2mqtt_base_topic", reason))?;
        if topic_namespaces_overlap(&self.application_namespace, &self.zigbee2mqtt_base_topic) {
            return Err(ConfigError::validation(
                "mqtt namespaces",
                "application and Zigbee2MQTT namespaces must not overlap",
            ));
        }
        if self.client_id.is_empty()
            || self.client_id.len() > 64
            || self
                .client_id
                .chars()
                .any(|ch| ch.is_control() || ch == '#' || ch == '+')
        {
            return Err(ConfigError::validation(
                "mqtt.client_id",
                "must be 1..=64 characters without control characters or wildcards",
            ));
        }
        let credentials = self.credentials.map(RawCredentials::validate).transpose()?;
        Ok(MqttSettings {
            host: self.host,
            port: self.port,
            client_id: self.client_id,
            application_namespace: self.application_namespace,
            zigbee2mqtt_base_topic: self.zigbee2mqtt_base_topic,
            credentials,
        })
    }
}

impl RawCredentials {
    fn validate(self) -> Result<MqttCredentialSource, ConfigError> {
        let has_lexical_alias = self
            .environment_file
            .split('/')
            .any(|component| matches!(component, "." | ".."));
        let environment_file = PathBuf::from(&self.environment_file);
        let canonicalized_into_store = fs::canonicalize(&environment_file)
            .is_ok_and(|canonical| canonical.starts_with("/nix/store"));
        if !environment_file.is_absolute()
            || environment_file.starts_with("/nix/store")
            || self.environment_file.is_empty()
            || self.environment_file.chars().any(char::is_control)
            || has_lexical_alias
            || canonicalized_into_store
        {
            return Err(ConfigError::validation(
                "mqtt.credentials.environment_file",
                "must be an absolute, normalized runtime path outside the Nix store",
            ));
        }
        if !valid_environment_name(&self.username_variable)
            || !valid_environment_name(&self.password_variable)
            || self.username_variable == self.password_variable
        {
            return Err(ConfigError::validation(
                "mqtt credential variables",
                "must be distinct POSIX environment variable names",
            ));
        }
        Ok(MqttCredentialSource {
            environment_file,
            username_variable: self.username_variable,
            password_variable: self.password_variable,
        })
    }
}

impl RawInput {
    fn validate(self) -> Result<InputSettings, ConfigError> {
        if self.double_click_window_ms > MAX_DOUBLE_CLICK_WINDOW_MS {
            return Err(ConfigError::validation(
                "input.double_click_window_ms",
                "exceeds the 2000 ms ceiling",
            ));
        }
        if self.ambiguous_center_hold_window_ms > MAX_AMBIGUOUS_HOLD_WINDOW_MS {
            return Err(ConfigError::validation(
                "input.ambiguous_center_hold_window_ms",
                "exceeds the 10000 ms ceiling",
            ));
        }
        let double_click_window = seconds_from_ms(self.double_click_window_ms)
            .and_then(|seconds| ClickWindow::from_seconds(seconds).map_err(|_| ()))
            .map_err(|_| {
                ConfigError::validation("input.double_click_window_ms", "must be positive")
            })?;
        let ambiguous_hold_window = seconds_from_ms(self.ambiguous_center_hold_window_ms)
            .and_then(|seconds| AmbiguousHoldWindow::from_seconds(seconds).map_err(|_| ()))
            .map_err(|_| {
                ConfigError::validation("input.ambiguous_center_hold_window_ms", "must be positive")
            })?;
        ClickClassifier::new(double_click_window, ambiguous_hold_window).map_err(|_| {
            ConfigError::validation(
                "input windows",
                "ambiguous center hold window must be at least the double-click window",
            )
        })?;
        Ok(InputSettings {
            double_click_window,
            ambiguous_hold_window,
        })
    }
}

impl RawCircadian {
    fn validate(self) -> Result<CircadianSettings, ConfigError> {
        let daily_reset_time = parse_time_of_day(&self.daily_reset_time).map_err(|_| {
            ConfigError::validation("circadian.daily_reset_time", "must be HH:MM or HH:MM:SS")
        })?;
        if self.unfreeze_convergence_seconds < MIN_OPERATIONAL_DURATION_SECONDS
            || self.unfreeze_convergence_seconds > MAX_UNFREEZE_CONVERGENCE_SECONDS
        {
            return Err(ConfigError::validation(
                "circadian.unfreeze_convergence_seconds",
                "must be between one millisecond and the one-hour ceiling",
            ));
        }
        let convergence_duration =
            ConvergenceDuration::from_seconds(self.unfreeze_convergence_seconds).map_err(|_| {
                ConfigError::validation(
                    "circadian.unfreeze_convergence_seconds",
                    "must be finite and positive",
                )
            })?;
        if !positive_finite(self.tick_seconds)
            || self.tick_seconds < MIN_OPERATIONAL_DURATION_SECONDS
            || self.tick_seconds > MAX_SPARSE_TICK_SECONDS
            || !positive_finite(self.brightness_change_threshold)
            || self.brightness_change_threshold > 1.0
            || !positive_finite(self.color_temperature_change_threshold_kelvin)
            || !positive_finite(self.maximum_refresh_seconds)
            || self.maximum_refresh_seconds < MIN_OPERATIONAL_DURATION_SECONDS
            || self.maximum_refresh_seconds > MAX_SPARSE_REFRESH_SECONDS
            || self.maximum_refresh_seconds < self.tick_seconds
        {
            return Err(ConfigError::validation(
                "circadian sparse update settings",
                "thresholds and intervals must be positive and within documented ceilings; maximum refresh must be at least one tick",
            ));
        }
        Ok(CircadianSettings {
            daily_reset_time,
            convergence_duration,
            convergence_duration_seconds: self.unfreeze_convergence_seconds,
            tick_seconds: self.tick_seconds,
            brightness_change_threshold: self.brightness_change_threshold,
            color_temperature_change_threshold_kelvin: self
                .color_temperature_change_threshold_kelvin,
            maximum_refresh_seconds: self.maximum_refresh_seconds,
        })
    }
}

impl RawAcknowledgement {
    fn validate(self) -> Result<AcknowledgementSettings, ConfigError> {
        let id = OverlayId::new(self.overlay_id).map_err(|_| {
            ConfigError::validation("acknowledgement.overlay_id", "invalid identifier")
        })?;
        if self.duration_ms > MAX_ACKNOWLEDGEMENT_DURATION_MS {
            return Err(ConfigError::validation(
                "acknowledgement.duration_ms",
                "exceeds the 5000 ms ceiling",
            ));
        }
        let duration = seconds_from_ms(self.duration_ms).map_err(|_| {
            ConfigError::validation("acknowledgement.duration_ms", "must be positive")
        })?;
        AcknowledgementSettings::new(id, self.amplitude, duration, self.priority).map_err(|_| {
            ConfigError::validation(
                "acknowledgement",
                "amplitude must be 0.01..=0.25 and duration must be positive",
            )
        })
    }
}

impl RawWholeHour {
    fn validate(self) -> Result<WholeHourSettings, ConfigError> {
        if self.duration_ms > MAX_WHOLE_HOUR_DURATION_MS {
            return Err(ConfigError::validation(
                "whole_hour.duration_ms",
                "exceeds the 60000 ms ceiling",
            ));
        }
        let duration_seconds = seconds_from_ms(self.duration_ms)
            .map_err(|_| ConfigError::validation("whole_hour.duration_ms", "must be positive"))?;
        OverlayDuration::from_seconds(duration_seconds)
            .map_err(|_| ConfigError::validation("whole_hour.duration_ms", "must be positive"))?;
        OverlayEffect::brightness_delta(self.brightness_delta).map_err(|_| {
            ConfigError::validation("whole_hour.brightness_delta", "must be finite")
        })?;
        if self.brightness_delta == 0.0 || self.brightness_delta.abs() > 1.0 {
            return Err(ConfigError::validation(
                "whole_hour.brightness_delta",
                "must be non-zero and between -1 and 1",
            ));
        }
        Ok(WholeHourSettings {
            brightness_delta: self.brightness_delta,
            duration_ms: self.duration_ms,
            priority: self.priority,
        })
    }
}

impl RawReconciliation {
    fn timing(&self) -> ReconciliationTiming {
        ReconciliationTiming {
            retry_interval_seconds: self.retry_interval_seconds,
            dispatch_acceptance_margin_seconds: self.dispatch_acceptance_margin_seconds,
            dispatch_failure_backoff_seconds: self.dispatch_failure_backoff_seconds,
        }
    }

    fn validate(self) -> Result<RetryPolicy, ConfigError> {
        if self.retry_interval_seconds < MIN_OPERATIONAL_DURATION_SECONDS
            || self.retry_interval_seconds > MAX_RECONCILE_RETRY_INTERVAL_SECONDS
            || self.dispatch_acceptance_margin_seconds < MIN_OPERATIONAL_DURATION_SECONDS
            || self.dispatch_acceptance_margin_seconds > MAX_DISPATCH_ACCEPTANCE_MARGIN_SECONDS
            || self.dispatch_failure_backoff_seconds < MIN_OPERATIONAL_DURATION_SECONDS
            || self.dispatch_failure_backoff_seconds > MAX_DISPATCH_FAILURE_BACKOFF_SECONDS
        {
            return Err(ConfigError::validation(
                "reconciliation",
                "timing must be between one millisecond and its documented one-house service ceiling",
            ));
        }
        RetryPolicy::new(self.retry_interval_seconds, self.maximum_attempts)
            .and_then(|policy| {
                policy.with_dispatch_timing(
                    self.dispatch_acceptance_margin_seconds,
                    self.dispatch_failure_backoff_seconds,
                )
            })
            .map_err(|_| {
                ConfigError::validation(
                    "reconciliation",
                    "intervals must be finite and positive; attempts must be 1..=10",
                )
            })
    }
}

impl RawHealth {
    fn validate(self) -> Result<HealthSettings, ConfigError> {
        let bind: SocketAddr = self.bind.parse().map_err(|_| {
            ConfigError::validation("health.bind", "must be a numeric IP socket address")
        })?;
        if bind.port() == 0 {
            return Err(ConfigError::validation(
                "health.bind",
                "port must be non-zero",
            ));
        }
        if bind.ip().is_unspecified() {
            return Err(ConfigError::validation(
                "health.bind",
                "wildcard addresses are not permitted",
            ));
        }
        if !bind.ip().is_loopback() && !self.allow_non_loopback {
            return Err(ConfigError::validation(
                "health.bind",
                "non-loopback address requires allow_non_loopback = true",
            ));
        }
        Ok(HealthSettings { bind })
    }
}

fn validate_floors(raw: Vec<RawFloor>) -> Result<BTreeSet<ScopeId>, ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::validation("floors", "must not be empty"));
    }
    let mut floors = BTreeSet::new();
    for floor in raw {
        let id = scope_id(floor.id, "floors")?;
        if !floors.insert(id) {
            return Err(ConfigError::validation("floors", "duplicate identifier"));
        }
    }
    Ok(floors)
}

fn validate_rooms(
    raw: Vec<RawRoom>,
    floors: &BTreeSet<ScopeId>,
) -> Result<BTreeMap<ScopeId, ScopeId>, ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::validation("rooms", "must not be empty"));
    }
    let mut rooms = BTreeMap::new();
    for room in raw {
        let id = scope_id(room.id, "rooms")?;
        let floor = scope_id(room.floor, "rooms.floor")?;
        if !floors.contains(&floor) {
            return Err(ConfigError::validation(
                "rooms.floor",
                "references unknown floor",
            ));
        }
        if rooms.insert(id, floor).is_some() {
            return Err(ConfigError::validation("rooms", "duplicate identifier"));
        }
    }
    Ok(rooms)
}

fn validate_curves(
    raw: Vec<RawCurve>,
    location: Option<&ValidatedLocation>,
) -> Result<BTreeMap<ScopeId, CircadianSchedule>, ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::validation("curves", "must not be empty"));
    }
    let mut curves = BTreeMap::new();
    for curve in raw {
        let RawCurve {
            id,
            kind,
            anchors,
            wake_time,
            bed_time,
            night_brightness,
            day_brightness,
            night_color_temperature_kelvin,
            day_color_temperature_kelvin,
            winter_hold,
        } = curve;
        let id = scope_id(id, "curves.id")?;
        let curve = match kind {
            RawCurveKind::Fixed => {
                if wake_time.is_some()
                    || bed_time.is_some()
                    || night_brightness.is_some()
                    || day_brightness.is_some()
                    || night_color_temperature_kelvin.is_some()
                    || day_color_temperature_kelvin.is_some()
                    || winter_hold.is_some()
                {
                    return Err(ConfigError::validation(
                        "curves",
                        "fixed curve accepts only anchors",
                    ));
                }
                CircadianSchedule::Fixed(validate_fixed_curve(anchors.ok_or_else(|| {
                    ConfigError::validation("curves.anchors", "fixed curve requires anchors")
                })?)?)
            }
            RawCurveKind::SolarHybrid => {
                if anchors.is_some() {
                    return Err(ConfigError::validation(
                        "curves",
                        "solar_hybrid curve must not define anchors",
                    ));
                }
                let location = location.ok_or_else(|| {
                    ConfigError::validation(
                        "location",
                        "solar_hybrid curve requires coordinates and timezone",
                    )
                })?;
                let wake_time = required_time(wake_time, "curves.wake_time")?;
                let bed_time = required_time(bed_time, "curves.bed_time")?;
                let night_brightness =
                    required_brightness(night_brightness, "curves.night_brightness")?;
                let day_brightness = required_brightness(day_brightness, "curves.day_brightness")?;
                let night_kelvin = required_kelvin(
                    night_color_temperature_kelvin,
                    "curves.night_color_temperature_kelvin",
                )?;
                let day_kelvin = required_kelvin(
                    day_color_temperature_kelvin,
                    "curves.day_color_temperature_kelvin",
                )?;
                let winter_hold = winter_hold.map(validate_winter_hold).transpose()?;
                CircadianSchedule::SolarHybrid(
                    SolarHybridCurve::new(
                        location.coordinates,
                        location.time_zone,
                        wake_time,
                        bed_time,
                        night_brightness,
                        day_brightness,
                        night_kelvin,
                        day_kelvin,
                        winter_hold,
                    )
                    .map_err(|_| {
                        ConfigError::validation(
                            "curves",
                            "solar curve needs an eight-hour wake/bed window and increasing day bounds",
                        )
                    })?,
                )
            }
        };
        if curves.insert(id, curve).is_some() {
            return Err(ConfigError::validation("curves", "duplicate identifier"));
        }
    }
    Ok(curves)
}

fn validate_fixed_curve(raw: Vec<RawAnchor>) -> Result<CircadianCurve, ConfigError> {
    let mut anchors = Vec::with_capacity(raw.len());
    for anchor in raw {
        let time = parse_time_of_day(&anchor.time).map_err(|_| {
            ConfigError::validation("curves.anchors.time", "must be HH:MM or HH:MM:SS")
        })?;
        let brightness = Brightness::new(anchor.brightness).map_err(|_| {
            ConfigError::validation("curves.anchors.brightness", "must be between 0 and 1")
        })?;
        anchors.push(
            CurveAnchor::new(time, brightness, anchor.color_temperature_kelvin).map_err(|_| {
                ConfigError::validation(
                    "curves.anchors.color_temperature_kelvin",
                    "must be positive with a finite mired representation",
                )
            })?,
        );
    }
    CircadianCurve::new(anchors).map_err(|_| {
        ConfigError::validation(
            "curves.anchors",
            "curve needs at least two anchors with unique times and valid values",
        )
    })
}

fn required_time(value: Option<String>, field: &'static str) -> Result<TimeOfDay, ConfigError> {
    parse_time_of_day(
        value
            .as_deref()
            .ok_or_else(|| ConfigError::validation(field, "is required"))?,
    )
    .map_err(|_| ConfigError::validation(field, "must be HH:MM or HH:MM:SS"))
}

fn required_brightness(value: Option<f64>, field: &'static str) -> Result<Brightness, ConfigError> {
    Brightness::new(value.ok_or_else(|| ConfigError::validation(field, "is required"))?)
        .map_err(|_| ConfigError::validation(field, "must be between 0 and 1"))
}

fn required_kelvin(value: Option<f64>, field: &'static str) -> Result<Kelvin, ConfigError> {
    Kelvin::new(value.ok_or_else(|| ConfigError::validation(field, "is required"))?).map_err(|_| {
        ConfigError::validation(field, "must be positive with a finite mired representation")
    })
}

fn validate_winter_hold(raw: RawWinterHold) -> Result<WinterHold, ConfigError> {
    let start = parse_month_day(&raw.start)?;
    let end = parse_month_day(&raw.end)?;
    let reference = parse_month_day(&raw.reference)?;
    WinterHold::new(start, end, reference).map_err(|_| {
        ConfigError::validation(
            "curves.winter_hold.reference",
            "must fall inside hold interval",
        )
    })
}

fn parse_month_day(value: &str) -> Result<MonthDay, ConfigError> {
    if value.len() != 5 || value.as_bytes().get(2) != Some(&b'-') {
        return Err(ConfigError::validation(
            "curves.winter_hold",
            "must use valid MM-DD values",
        ));
    }
    let month = value[..2].parse::<u8>().map_err(|_| {
        ConfigError::validation("curves.winter_hold", "must use valid MM-DD values")
    })?;
    let day = value[3..].parse::<u8>().map_err(|_| {
        ConfigError::validation("curves.winter_hold", "must use valid MM-DD values")
    })?;
    MonthDay::new(month, day)
        .map_err(|_| ConfigError::validation("curves.winter_hold", "must use valid MM-DD values"))
}

type DeviceValidation = (
    Vec<DeviceConfiguration>,
    BTreeMap<DeviceId, ValidatedCapabilities>,
    BTreeSet<DeviceId>,
    BTreeSet<String>,
    Vec<DeviceBinding>,
);

#[derive(Clone, Copy)]
struct ValidatedCapabilities {
    capabilities: Capabilities,
    mired_range: Option<MiredRange>,
}

fn validate_devices(
    raw: Vec<RawDevice>,
    rooms: &BTreeMap<ScopeId, ScopeId>,
) -> Result<DeviceValidation, ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::validation("devices", "must not be empty"));
    }
    let mut configurations = Vec::with_capacity(raw.len());
    let mut caps_by_id = BTreeMap::new();
    let mut ids = BTreeSet::new();
    let mut all_names = BTreeSet::new();
    let mut bindings = Vec::with_capacity(raw.len());
    for device in raw {
        let id = device_id(device.id, "devices.id")?;
        if !ids.insert(id.clone()) || !all_names.insert(id.as_str().to_owned()) {
            return Err(ConfigError::validation(
                "devices.id",
                "duplicate identifier or alias",
            ));
        }
        let mut aliases = Vec::with_capacity(device.aliases.len());
        for alias in device.aliases {
            let alias = device_id(alias, "devices.aliases")?;
            if !all_names.insert(alias.as_str().to_owned()) {
                return Err(ConfigError::validation(
                    "devices.aliases",
                    "duplicate identifier or alias",
                ));
            }
            aliases.push(alias);
        }
        let room = scope_id(device.room, "devices.room")?;
        let floor = rooms
            .get(&room)
            .ok_or_else(|| ConfigError::validation("devices.room", "references unknown room"))?;
        let (capabilities, mired_range) =
            device.capabilities.validate("devices.capabilities", true)?;
        if device.single_transition_attribute
            && (!capabilities.dimming || capabilities.color_temperature.is_none())
        {
            return Err(ConfigError::validation(
                "devices.single_transition_attribute",
                "single-attribute transition behavior requires dimming and color-temperature capabilities",
            ));
        }
        if device.color_comparison.is_some() && !capabilities.color_xy && !capabilities.color_hs {
            return Err(ConfigError::validation(
                "devices.color_comparison",
                "requires a color capability",
            ));
        }
        let color_policy = device.color_comparison.unwrap_or_default().validate()?;
        let definition =
            DeviceDefinition::with_color_policy(id.clone(), capabilities, color_policy);
        let binding = DeviceBinding::new(
            id.clone(),
            device.friendly_name,
            capabilities,
            mired_range,
            device.single_transition_attribute,
        )
        .map_err(|_| {
            ConfigError::validation(
                "devices.friendly_name",
                "duplicate, reserved, wildcard, or malformed Zigbee2MQTT name",
            )
        })?;
        caps_by_id.insert(
            id.clone(),
            ValidatedCapabilities {
                capabilities,
                mired_range,
            },
        );
        bindings.push(binding.clone());
        configurations.push(DeviceConfiguration {
            id,
            definition,
            binding,
            membership: ScopeMembership::new(room, floor.clone()),
            aliases,
            is_controllable_light: capabilities.on_off,
        });
    }
    Ok((configurations, caps_by_id, ids, all_names, bindings))
}

fn validate_groups(
    raw: Vec<RawGroup>,
    device_caps: &BTreeMap<DeviceId, ValidatedCapabilities>,
    device_ids: &BTreeSet<DeviceId>,
) -> Result<(Vec<GroupConfiguration>, Vec<GroupBinding>), ConfigError> {
    let mut configurations = Vec::with_capacity(raw.len());
    let mut bindings = Vec::with_capacity(raw.len());
    let mut group_ids = BTreeSet::new();
    let mut assigned_devices = BTreeSet::new();
    for group in raw {
        let id = entity_id(group.id, "groups.id")?;
        if !group_ids.insert(id.clone()) {
            return Err(ConfigError::validation("groups.id", "duplicate identifier"));
        }
        let (capabilities, mired_range) =
            group.capabilities.validate("groups.capabilities", false)?;
        if group.single_transition_attribute
            && (!capabilities.dimming || capabilities.color_temperature.is_none())
        {
            return Err(ConfigError::validation(
                "groups.single_transition_attribute",
                "single-attribute transition behavior requires dimming and color-temperature capabilities",
            ));
        }
        if group.members.is_empty() {
            return Err(ConfigError::validation(
                "groups.members",
                "must not be empty",
            ));
        }
        let mut members = Vec::with_capacity(group.members.len());
        let mut local = BTreeSet::new();
        for member in group.members {
            let member = device_id(member, "groups.members")?;
            if !device_ids.contains(&member) {
                return Err(ConfigError::validation(
                    "groups.members",
                    "references unknown device",
                ));
            }
            if !local.insert(member.clone()) || !assigned_devices.insert(member.clone()) {
                return Err(ConfigError::validation(
                    "groups.members",
                    "device must occur once and belong to at most one Zigbee group",
                ));
            }
            let member_caps = device_caps
                .get(&member)
                .expect("known device has validated capabilities");
            if !capabilities_subset(capabilities, member_caps.capabilities)
                || !mired_subset(mired_range, member_caps.mired_range)
            {
                return Err(ConfigError::validation(
                    "groups.capabilities",
                    "group capabilities must be supported by every member",
                ));
            }
            members.push(member);
        }
        let definition = GroupDefinition::new(
            id.clone(),
            members.clone(),
            Capabilities {
                color_temperature: mired_range.and(capabilities.color_temperature),
                ..capabilities
            },
        )
        .map_err(|_| {
            ConfigError::validation("groups", "invalid group membership or capabilities")
        })?;
        let binding = GroupBinding::new(
            id.clone(),
            group.friendly_name,
            mired_range,
            group.single_transition_attribute,
        )
        .map_err(|_| {
            ConfigError::validation(
                "groups.friendly_name",
                "reserved, wildcard, or malformed Zigbee2MQTT name",
            )
        })?;
        bindings.push(binding.clone());
        configurations.push(GroupConfiguration {
            id,
            members,
            mired_range,
            definition,
            binding,
        });
    }
    Ok((configurations, bindings))
}

fn validate_scopes(
    raw: Vec<RawScope>,
    floors: &BTreeSet<ScopeId>,
    rooms: &BTreeMap<ScopeId, ScopeId>,
    curves: &BTreeMap<ScopeId, CircadianSchedule>,
    devices: &[DeviceConfiguration],
) -> Result<Vec<ScopeConfiguration>, ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::validation("scopes", "must not be empty"));
    }
    let mut ids = BTreeSet::new();
    let mut resolved = BTreeSet::new();
    let mut configurations = Vec::with_capacity(raw.len());
    for item in raw {
        let (raw_id, scope, raw_curve) = match item {
            RawScope::Room { id, room, curve } => {
                let room = scope_id(room, "scopes.room")?;
                if !rooms.contains_key(&room) {
                    return Err(ConfigError::validation(
                        "scopes.room",
                        "references unknown room",
                    ));
                }
                (id, Scope::Room(room), curve)
            }
            RawScope::Floor { id, floor, curve } => {
                let floor = scope_id(floor, "scopes.floor")?;
                if !floors.contains(&floor) {
                    return Err(ConfigError::validation(
                        "scopes.floor",
                        "references unknown floor",
                    ));
                }
                (id, Scope::Floor(floor), curve)
            }
            RawScope::House { id, curve } => (id, Scope::House, curve),
        };
        let id = scope_id(raw_id, "scopes.id")?;
        if id.as_str() == "selected" {
            return Err(ConfigError::validation(
                "scopes.id",
                "selected is reserved for the current control scope target",
            ));
        }
        let curve = scope_id(raw_curve, "scopes.curve")?;
        if !curves.contains_key(&curve) {
            return Err(ConfigError::validation(
                "scopes.curve",
                "references unknown curve",
            ));
        }
        if !ids.insert(id.clone()) || !resolved.insert(scope.clone()) {
            return Err(ConfigError::validation(
                "scopes",
                "duplicate identifier or duplicate resolved scope",
            ));
        }
        let member_count = devices
            .iter()
            .filter(|device| device.is_controllable_light && device.membership.is_in(&scope))
            .count();
        if member_count == 0 {
            return Err(ConfigError::validation(
                "scopes",
                "resolved scope must contain at least one device that is a controllable light",
            ));
        }
        configurations.push(ScopeConfiguration { id, scope, curve });
    }
    Ok(configurations)
}

fn validate_controls(
    raw: Vec<RawControl>,
    scopes: &[ScopeConfiguration],
    devices: &[DeviceConfiguration],
    mut all_names: BTreeSet<String>,
) -> Result<(Vec<ControlConfiguration>, Vec<ControlBinding>), ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::validation("controls", "must not be empty"));
    }
    let scope_by_id: BTreeMap<_, _> = scopes
        .iter()
        .map(|scope| (scope.id.clone(), scope.scope.clone()))
        .collect();
    let mut controls = Vec::with_capacity(raw.len());
    let mut bindings = Vec::with_capacity(raw.len());
    for control in raw {
        let id = control_id(control.id, "controls.id")?;
        if !all_names.insert(id.as_str().to_owned()) {
            return Err(ConfigError::validation(
                "controls.id",
                "duplicate identifier or alias",
            ));
        }
        let mut aliases = Vec::with_capacity(control.aliases.len());
        for alias in control.aliases {
            let alias = control_id(alias, "controls.aliases")?;
            if !all_names.insert(alias.as_str().to_owned()) {
                return Err(ConfigError::validation(
                    "controls.aliases",
                    "duplicate identifier or alias",
                ));
            }
            aliases.push(alias);
        }
        let selected_id = scope_id(control.selected_scope, "controls.selected_scope")?;
        let selected_scope = scope_by_id.get(&selected_id).cloned().ok_or_else(|| {
            ConfigError::validation("controls.selected_scope", "references unknown scope")
        })?;
        if control.mappings.is_empty() {
            return Err(ConfigError::validation(
                "controls.mappings",
                "must not be empty",
            ));
        }
        let mut entries = Vec::with_capacity(control.mappings.len());
        let mut acknowledgement_gestures = BTreeSet::new();
        for raw_mapping in control.mappings {
            let gesture = parse_gesture(&raw_mapping.gesture).ok_or_else(|| {
                ConfigError::validation("controls.mappings.gesture", "unsupported gesture")
            })?;
            let target = if raw_mapping.target == "selected" {
                ScopeTarget::SelectedScope
            } else {
                let target_id = scope_id(raw_mapping.target, "controls.mappings.target")?;
                let scope = scope_by_id.get(&target_id).cloned().ok_or_else(|| {
                    ConfigError::validation("controls.mappings.target", "references unknown scope")
                })?;
                ScopeTarget::Explicit(scope)
            };
            let (action, acknowledge) = raw_mapping.action.validate()?;
            if acknowledge {
                acknowledgement_gestures.insert(gesture);
            }
            entries.push(MappingEntry::new(gesture, target, action).map_err(|_| {
                ConfigError::validation(
                    "controls.mappings",
                    "action and target combination is invalid",
                )
            })?);
        }
        let selectable_scopes: BTreeSet<_> = std::iter::once(selected_scope.clone())
            .chain(entries.iter().filter_map(|entry| {
                if matches!(entry.action(), Action::SelectScope) {
                    match entry.target() {
                        ScopeTarget::Explicit(scope) => Some(scope.clone()),
                        ScopeTarget::SelectedScope => None,
                    }
                } else {
                    None
                }
            }))
            .collect();
        for entry in &entries {
            let supported = match entry.target() {
                ScopeTarget::SelectedScope => selectable_scopes
                    .iter()
                    .all(|scope| scope_supports_action(scope, entry.action(), devices)),
                ScopeTarget::Explicit(scope) => {
                    scope_supports_action(scope, entry.action(), devices)
                }
            };
            if !supported {
                return Err(ConfigError::validation(
                    "controls.mappings.action",
                    "requires a matching device capability in every possible target scope",
                ));
            }
        }
        let mapping = Mapping::new(entries).map_err(|_| {
            ConfigError::validation(
                "controls.mappings",
                "a gesture may have only one mapping per control",
            )
        })?;
        let binding = ControlBinding::new(id.clone(), control.friendly_name).map_err(|_| {
            ConfigError::validation(
                "controls.friendly_name",
                "reserved, wildcard, or malformed Zigbee2MQTT name",
            )
        })?;
        bindings.push(binding.clone());
        controls.push(ControlConfiguration {
            id,
            binding,
            selected_scope,
            mapping,
            acknowledgement_gestures,
            aliases,
        });
    }
    Ok((controls, bindings))
}

fn scope_supports_action(scope: &Scope, action: Action, devices: &[DeviceConfiguration]) -> bool {
    if matches!(action, Action::SelectScope) {
        return true;
    }
    devices
        .iter()
        .filter(|device| device.membership.is_in(scope))
        .any(|device| {
            let capabilities = device.definition.capabilities();
            match action {
                Action::AdjustBrightnessOffset(_) => capabilities.dimming,
                Action::AdjustColorTemperatureOffset(_) => capabilities.color_temperature.is_some(),
                Action::TogglePower => capabilities.on_off,
                Action::ToggleCircadian => true,
                Action::SelectScope => true,
            }
        })
}

impl RawCapabilities {
    fn validate(
        self,
        field: &'static str,
        require_mired: bool,
    ) -> Result<(Capabilities, Option<MiredRange>), ConfigError> {
        let any = self.on_off
            || self.dimming
            || self.color_temperature.is_some()
            || self.color_xy
            || self.color_hs
            || self.input
            || self.occupancy
            || self.temperature
            || self.power_metering;
        if !any {
            return Err(ConfigError::validation(
                field,
                "at least one capability is required",
            ));
        }
        if (self.dimming || self.color_temperature.is_some() || self.color_xy || self.color_hs)
            && !self.on_off
        {
            return Err(ConfigError::validation(
                field,
                "lighting capabilities require on_off",
            ));
        }
        let (color_temperature, mired_range) = self
            .color_temperature
            .map(|raw| {
                let kelvin = KelvinRange::new(raw.minimum_kelvin, raw.maximum_kelvin)
                    .map_err(|_| ConfigError::validation(field, "invalid Kelvin range"))?;
                let mired = match (raw.minimum_mired, raw.maximum_mired) {
                    (Some(minimum), Some(maximum)) => {
                        let range = MiredRange::new(minimum, maximum)
                            .map_err(|_| ConfigError::validation(field, "invalid mired range"))?;
                        validate_cct_round_trip(kelvin, range).map_err(|_| {
                            ConfigError::validation(
                                field,
                                "Kelvin and mired endpoints must round-trip within 1%",
                            )
                        })?;
                        Some(range)
                    }
                    (None, None) if !require_mired => None,
                    (None, None) => {
                        return Err(ConfigError::validation(
                            field,
                            "device CCT minimum_mired and maximum_mired must both be present",
                        ));
                    }
                    _ => {
                        return Err(ConfigError::validation(
                            field,
                            "minimum_mired and maximum_mired must both be present or both be omitted",
                        ));
                    }
                };
                Ok((kelvin, mired))
            })
            .transpose()?
            .map_or((None, None), |(kelvin, mired)| (Some(kelvin), mired));
        Ok((
            Capabilities {
                on_off: self.on_off,
                dimming: self.dimming,
                color_temperature,
                color_xy: self.color_xy,
                color_hs: self.color_hs,
                input: self.input,
                occupancy: self.occupancy,
                temperature: self.temperature,
                power_metering: self.power_metering,
            },
            mired_range,
        ))
    }
}

fn validate_cct_round_trip(kelvin: KelvinRange, mired: MiredRange) -> Result<(), ()> {
    for endpoint in [kelvin.min().get(), kelvin.max().get()] {
        let command_mired = (1_000_000.0 / endpoint)
            .round()
            .clamp(f64::from(mired.min()), f64::from(mired.max()));
        let observed_kelvin = 1_000_000.0 / command_mired;
        if (endpoint - observed_kelvin).abs() > endpoint * 0.01 {
            return Err(());
        }
    }
    for (mired_endpoint, kelvin_endpoint) in [
        (mired.min(), kelvin.max().get()),
        (mired.max(), kelvin.min().get()),
    ] {
        let observed_kelvin = 1_000_000.0 / f64::from(mired_endpoint);
        if (kelvin_endpoint - observed_kelvin).abs() > kelvin_endpoint * 0.01 {
            return Err(());
        }
    }
    Ok(())
}

impl RawColorComparison {
    fn validate(self) -> Result<ColorComparisonPolicy, ConfigError> {
        let gamut = self
            .gamut
            .map(|gamut| {
                ColorGamut::new(
                    (gamut.red[0], gamut.red[1]),
                    (gamut.green[0], gamut.green[1]),
                    (gamut.blue[0], gamut.blue[1]),
                )
                .map_err(|_| {
                    ConfigError::validation(
                        "devices.color_comparison.gamut",
                        "points must be finite, normalized, and non-collinear",
                    )
                })
            })
            .transpose()?;
        ColorComparisonPolicy::new(
            gamut,
            self.xy_tolerance,
            self.achromatic_saturation_threshold,
        )
        .map_err(|_| {
            ConfigError::validation(
                "devices.color_comparison",
                "tolerances must be finite and normalized",
            )
        })
    }
}

impl RawAction {
    fn validate(self) -> Result<(Action, bool), ConfigError> {
        match self {
            Self::AdjustBrightnessOffset { delta } => Action::brightness_offset(delta)
                .and_then(|action| {
                    if delta == 0.0 || delta.abs() > 1.0 {
                        Err(house_automation_core::input::InputError::NonFinite)
                    } else {
                        Ok(action)
                    }
                })
                .map(|action| (action, false))
                .map_err(|_| {
                    ConfigError::validation(
                        "controls.mappings.action.delta",
                        "must be finite, non-zero, and between -1 and 1",
                    )
                }),
            Self::AdjustColorTemperatureOffset { delta_kelvin } => {
                Action::color_temperature_offset(delta_kelvin)
                    .and_then(|action| {
                        if delta_kelvin == 0.0 || delta_kelvin.abs() > 10_000.0 {
                            Err(house_automation_core::input::InputError::NonFinite)
                        } else {
                            Ok(action)
                        }
                    })
                    .map(|action| (action, false))
                    .map_err(|_| {
                        ConfigError::validation(
                            "controls.mappings.action.delta_kelvin",
                            "must be finite, non-zero, and no greater than 10000 K in magnitude",
                        )
                    })
            }
            Self::TogglePower => Ok((Action::TogglePower, false)),
            Self::ToggleCircadianWithAcknowledgement => Ok((Action::ToggleCircadian, true)),
            Self::SelectScope => Ok((Action::SelectScope, false)),
        }
    }
}

fn capabilities_subset(group: Capabilities, member: Capabilities) -> bool {
    (!group.on_off || member.on_off)
        && (!group.dimming || member.dimming)
        && match (group.color_temperature, member.color_temperature) {
            (None, _) => true,
            (Some(group), Some(member)) => {
                group.min() >= member.min() && group.max() <= member.max()
            }
            (Some(_), None) => false,
        }
        && (!group.color_xy || member.color_xy)
        && (!group.color_hs || member.color_hs)
        && (!group.input || member.input)
        && (!group.occupancy || member.occupancy)
        && (!group.temperature || member.temperature)
        && (!group.power_metering || member.power_metering)
}

fn mired_subset(group: Option<MiredRange>, member: Option<MiredRange>) -> bool {
    match (group, member) {
        (None, _) => true,
        (Some(group), Some(member)) => group.min() >= member.min() && group.max() <= member.max(),
        (Some(_), None) => false,
    }
}

fn scope_id(value: String, field: &'static str) -> Result<ScopeId, ConfigError> {
    ScopeId::new(value).map_err(|_| ConfigError::validation(field, "invalid lowercase identifier"))
}

fn device_id(value: String, field: &'static str) -> Result<DeviceId, ConfigError> {
    DeviceId::new(value).map_err(|_| ConfigError::validation(field, "invalid lowercase identifier"))
}

fn entity_id(value: String, field: &'static str) -> Result<EntityId, ConfigError> {
    EntityId::new(value).map_err(|_| ConfigError::validation(field, "invalid lowercase identifier"))
}

fn control_id(value: String, field: &'static str) -> Result<ControlId, ConfigError> {
    ControlId::new(value)
        .map_err(|_| ConfigError::validation(field, "invalid lowercase identifier"))
}

fn parse_time_of_day(value: &str) -> Result<TimeOfDay, ()> {
    let components: Vec<_> = value.split(':').collect();
    if !(components.len() == 2 || components.len() == 3)
        || components.iter().any(|component| component.len() != 2)
    {
        return Err(());
    }
    let hour: u8 = components[0].parse().map_err(|_| ())?;
    let minute: u8 = components[1].parse().map_err(|_| ())?;
    let second: u8 = if components.len() == 3 {
        components[2].parse().map_err(|_| ())?
    } else {
        0
    };
    TimeOfDay::from_hms(hour, minute, second).map_err(|_| ())
}

fn parse_gesture(value: &str) -> Option<Gesture> {
    match value {
        "up" => Some(Gesture::Up),
        "down" => Some(Gesture::Down),
        "left" => Some(Gesture::Left),
        "right" => Some(Gesture::Right),
        "center_single" => Some(Gesture::CenterSingle),
        "center_double" => Some(Gesture::CenterDouble),
        "center_long" => Some(Gesture::CenterLong),
        "center_release" => Some(Gesture::CenterRelease),
        "hold_up" => Some(Gesture::DirectionHold(Direction::Up)),
        "hold_down" => Some(Gesture::DirectionHold(Direction::Down)),
        "hold_left" => Some(Gesture::DirectionHold(Direction::Left)),
        "hold_right" => Some(Gesture::DirectionHold(Direction::Right)),
        "release_up" => Some(Gesture::DirectionRelease(Direction::Up)),
        "release_down" => Some(Gesture::DirectionRelease(Direction::Down)),
        "release_left" => Some(Gesture::DirectionRelease(Direction::Left)),
        "release_right" => Some(Gesture::DirectionRelease(Direction::Right)),
        _ => None,
    }
}

fn validate_topic_namespace(value: &str, require_version: bool) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_TOPIC_LENGTH
        || value.starts_with('/')
        || value.ends_with('/')
        || value
            .chars()
            .any(|ch| ch.is_control() || ch == '#' || ch == '+')
    {
        return Err("must be a bounded MQTT namespace without wildcards or control characters");
    }
    let parts: Vec<_> = value.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || part.starts_with('$')
            || matches!(*part, "bridge" | "set" | "get" | "availability")
    }) {
        return Err("contains an empty or reserved MQTT component");
    }
    if require_version {
        let version = parts.last().copied().unwrap_or_default();
        let bytes = version.as_bytes();
        let canonical = bytes.len() >= 2
            && bytes[0] == b'v'
            && (b'1'..=b'9').contains(&bytes[1])
            && bytes[2..].iter().all(u8::is_ascii_digit);
        if parts.len() < 2 || !canonical {
            return Err("must end with a non-zero version segment such as v1");
        }
    }
    Ok(())
}

fn topic_namespaces_overlap(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn valid_environment_name(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_uppercase())
        && characters.all(|ch| ch == '_' || ch.is_ascii_uppercase() || ch.is_ascii_digit())
}

fn positive_finite(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn seconds_from_ms(milliseconds: u64) -> Result<f64, ()> {
    if milliseconds == 0 {
        return Err(());
    }
    let seconds = milliseconds as f64 / 1_000.0;
    positive_finite(seconds).then_some(seconds).ok_or(())
}

fn line_column(input: &str, offset: usize) -> (usize, usize) {
    let prefix = &input.as_bytes()[..offset.min(input.len())];
    let line = prefix.iter().filter(|byte| **byte == b'\n').count() + 1;
    let column = prefix
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(prefix.len() + 1, |newline| prefix.len() - newline);
    (line, column)
}
