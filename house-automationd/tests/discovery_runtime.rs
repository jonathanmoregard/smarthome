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

// Same shape as the home-server topology (validated by the `house-config`
// flake check); host config is not part of the app source.
const PRODUCTION: &str = r#"schema_version = 1
default_curve = "home-day"
# Devices are discovered at runtime from Zigbee2MQTT (spec rollout step 2).
devices = []
controls = []

# Approximate coordinates are enough for solar timing.
[location]
latitude = 59.3
longitude = 18.1
time_zone = "Europe/Stockholm"

# Loopback listener is anonymous and ACL-limited; no credentials needed.
[mqtt]
host = "127.0.0.1"
port = 1883
client_id = "house-automationd"

[[floors]]
id = "upper-floor"

[[rooms]]
id = "upper-hallway"
floor = "upper-floor"

# Yellower light by preference: daytime tops out at 3500 K.
[[curves]]
id = "home-day"
kind = "solar_hybrid"
wake_time = "07:00"
bed_time = "23:00"
night_brightness = 0.10
day_brightness = 1.00
night_color_temperature_kelvin = 2200
day_color_temperature_kelvin = 3500
winter_hold = { start = "11-01", end = "01-31", reference = "11-01" }

[[scopes]]
id = "upper-hallway-lights"
kind = "room"
room = "upper-hallway"
curve = "home-day"
"#;
const EXAMPLE: &str = include_str!("../../examples/house.toml");
const BRIDGE_DEVICES: &str = include_str!("fixtures/bridge-devices.json");
const BULB: &str = "0x7cc6b6fffe3cef1c";
const LAMP: &str = "upper-floor/upper-hallway/lamp";

#[derive(Clone, Default)]
struct Wire {
    delivered: Arc<Mutex<Vec<String>>>,
    payloads: Arc<Mutex<Vec<Vec<u8>>>>,
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

    async fn publish(
        &mut self,
        topic: &str,
        payload: &[u8],
        _qos: Qos,
        _retain: bool,
    ) -> Result<(), MqttError> {
        if self.0.blocked.load(Ordering::SeqCst) {
            self.0.refused.lock().unwrap().push(topic.to_owned());
            return Err(MqttError::transport("simulated broker backpressure"));
        }
        self.0.delivered.lock().unwrap().push(topic.to_owned());
        self.0.payloads.lock().unwrap().push(payload.to_vec());
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
    assert_eq!(
        BRIDGE_DEVICES.matches(&original).count(),
        1,
        "fixture drift"
    );
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
        Self::from_source(PRODUCTION)
    }

    fn from_source(source: &str) -> Self {
        let parts = ValidatedConfig::parse(source).unwrap().into_runtime_parts();
        let engine =
            HouseEngine::initialize(parts, AutomationState::default(), sample(0.0).runtime)
                .unwrap();
        let wire = Wire::default();
        let clock = Arc::new(Mutex::new(sample(0.0)));
        let health = Arc::new(HealthState::new());
        let actor = RuntimeActor::new(
            engine,
            WireTransport(wire.clone()),
            TestClock(clock.clone()),
            NoopWriter,
            health.clone(),
        )
        .unwrap();
        Self {
            actor,
            wire,
            clock,
            health,
        }
    }

    async fn receive(&mut self, topic: &str, payload: &[u8]) {
        self.actor
            .handle_transport_event(message(topic, payload))
            .await
            .unwrap();
    }

    /// Echoes every command as Zigbee2MQTT does, so the light converges.
    async fn run_echoing_until(&mut self, seconds: f64) {
        let mut now = self.clock.lock().unwrap().runtime.monotonic.as_seconds();
        while now < seconds {
            let seen = self.wire.delivered().len();
            now = (now + 0.5).min(seconds);
            self.run_until(now).await;
            let topics = self.wire.delivered()[seen..].to_vec();
            let payloads = self.wire.payloads.lock().unwrap()[seen..].to_vec();
            for (topic, payload) in topics.iter().zip(payloads) {
                let Some(name) = topic.strip_suffix("/set") else {
                    continue;
                };
                let sent: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                let mut state =
                    serde_json::json!({"state": "OFF", "brightness": 127, "color_temp": 333});
                for key in ["state", "brightness", "color_temp"] {
                    if let Some(value) = sent.get(key) {
                        state[key] = value.clone();
                    }
                }
                self.receive(name, &serde_json::to_vec(&state).unwrap())
                    .await;
            }
        }
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
    assert_eq!(
        house.health.snapshot().discovery(),
        DiscoveryStatus::Pending
    );
    house
        .actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    house
        .receive("zigbee2mqtt/bridge/state", br#"{"state":"online"}"#)
        .await;
    house
        .receive("zigbee2mqtt/bridge/devices", &bridge_devices(BULB))
        .await;
    house
        .receive(
            &format!("zigbee2mqtt/{BULB}/availability"),
            br#"{"state":"online"}"#,
        )
        .await;
    house.run_until(2.0).await;

    let old_set = format!("zigbee2mqtt/{BULB}/set");
    assert!(
        house.wire.delivered().contains(&old_set),
        "an unnamed light must follow the curve at once"
    );
    assert_eq!(house.health.snapshot().discovery(), DiscoveryStatus::Synced);
    assert_eq!(
        house.actor.engine().owner_scope(&bulb()).unwrap(),
        &Scope::House
    );

    // Retries pile up while the broker refuses them, as they would in flight.
    house.wire.blocked.store(true, Ordering::SeqCst);
    house.run_until(20.0).await;
    assert!(
        house.wire.refused().contains(&old_set),
        "a retry must be in flight when the rename lands"
    );

    let renamed_at = house.wire.delivered().len();
    house
        .receive("zigbee2mqtt/bridge/devices", &bridge_devices(LAMP))
        .await;
    house.wire.blocked.store(false, Ordering::SeqCst);
    house.run_until(60.0).await;
    let after_rename = house.wire.delivered()[renamed_at..].to_vec();
    assert!(
        !after_rename.contains(&old_set),
        "commanded under its old name: {after_rename:?}"
    );
    assert!(
        after_rename.contains(&format!("zigbee2mqtt/{LAMP}/set")),
        "{after_rename:?}"
    );
    assert_eq!(
        house.actor.engine().owner_scope(&bulb()).unwrap(),
        &Scope::Room(ScopeId::new("upper-hallway").unwrap())
    );

    let removed_at = house.wire.delivered().len();
    house.receive("zigbee2mqtt/bridge/devices", b"[]").await;
    house.run_until(100.0).await;
    let after_removal = house.wire.delivered()[removed_at..].to_vec();
    assert!(
        after_removal.iter().all(|topic| !topic.ends_with("/set")),
        "{after_removal:?}"
    );
    assert!(house.actor.engine().owner_scope(&bulb()).is_err());
}

#[tokio::test]
async fn a_converged_light_is_refreshed_every_maximum_refresh_interval_across_a_rename() {
    let mut house = House::from_source(&PRODUCTION.replace(
        "[mqtt]",
        "[circadian]\ntick_seconds = 0.5\nmaximum_refresh_seconds = 2.0\n\n[mqtt]",
    ));
    house
        .actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    house
        .receive("zigbee2mqtt/bridge/state", br#"{"state":"online"}"#)
        .await;
    house
        .receive("zigbee2mqtt/bridge/devices", &bridge_devices(BULB))
        .await;
    house
        .receive(
            &format!("zigbee2mqtt/{BULB}/availability"),
            br#"{"state":"online"}"#,
        )
        .await;
    house.run_echoing_until(4.0).await;

    let old_set = format!("zigbee2mqtt/{BULB}/set");
    let new_set = format!("zigbee2mqtt/{LAMP}/set");
    let sets_between = |house: &House, from: usize, topic: &str| {
        house.wire.delivered()[from..]
            .iter()
            .filter(|sent| *sent == topic)
            .count()
    };
    let converged_at = house.wire.delivered().len();
    house.run_echoing_until(12.0).await;
    assert!(
        sets_between(&house, converged_at, &old_set) >= 3,
        "a converged light must still be refreshed: {:?}",
        &house.wire.delivered()[converged_at..]
    );

    // Zigbee2MQTT clears the old availability and announces the new one
    // before it republishes the device list.
    house
        .receive(&format!("zigbee2mqtt/{BULB}/availability"), b"")
        .await;
    house
        .receive(
            &format!("zigbee2mqtt/{LAMP}/availability"),
            br#"{"state":"online"}"#,
        )
        .await;
    house
        .receive("zigbee2mqtt/bridge/devices", &bridge_devices(LAMP))
        .await;
    house.run_echoing_until(16.0).await;
    let renamed_at = house.wire.delivered().len();
    house.run_echoing_until(26.0).await;
    assert_eq!(sets_between(&house, renamed_at, &old_set), 0);
    assert!(
        sets_between(&house, renamed_at, &new_set) >= 4,
        "the renamed light stopped following: {:?}",
        &house.wire.delivered()[renamed_at..]
    );
}

#[test]
fn a_static_declaration_wins_over_a_discovered_light_with_the_same_name() {
    let source = EXAMPLE.replacen(
        "schema_version = 1\n",
        "schema_version = 1\ndefault_curve = \"default-day\"\n",
        1,
    );
    let mut engine = HouseEngine::initialize(
        ValidatedConfig::parse(&source)
            .unwrap()
            .into_runtime_parts(),
        AutomationState::default(),
        sample(0.0).runtime,
    )
    .unwrap();
    let devices = parse_bridge_devices(&bridge_devices("demo/living-room/reading-light")).unwrap();

    let outcome = engine
        .apply_discovery(&devices, sample(1.0).runtime)
        .unwrap();

    assert_eq!(outcome.adopted, 0);
    assert!(engine.owner_scope(&bulb()).is_err());
    assert!(
        engine
            .owner_scope(&DeviceId::new("reading-light").unwrap())
            .is_ok()
    );
    let report = engine
        .device_reports()
        .into_iter()
        .find(|report| report.id == BULB)
        .unwrap();
    assert!(!report.controlled);
    assert_eq!(
        report.reason,
        Some("declared in house.toml; the static entry wins")
    );
}
