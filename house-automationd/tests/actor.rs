use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use chrono::TimeZone;
use chrono_tz::Europe::Stockholm;
use house_automation_core::state::{AutomationState, LocalDate, MonotonicTime};
use house_automationd::{
    config::ValidatedConfig,
    health::HealthState,
    mqtt::{MqttError, MqttTransport, OwnedInboundMessage, TransportEvent},
    runtime::{DurableStateWriter, HouseEngine, RuntimeActor, RuntimeInstant},
    scheduler::{Clock, ClockSample},
    zigbee2mqtt::Qos,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Subscribe(String, Qos),
    Publish(String, Vec<u8>, Qos, bool),
    Shutdown(String),
}

struct FakeTransport {
    calls: Arc<Mutex<Vec<Call>>>,
    fail_next_publish: Arc<AtomicUsize>,
}

struct FailingTransport;

#[async_trait]
impl MqttTransport for FailingTransport {
    async fn next_event(&mut self) -> Result<TransportEvent, MqttError> {
        Err(MqttError::fatal("simulated event-driver failure"))
    }

    async fn subscribe(&mut self, _topic: &str, _qos: Qos) -> Result<(), MqttError> {
        Ok(())
    }

    async fn publish(
        &mut self,
        _topic: &str,
        _payload: &[u8],
        _qos: Qos,
        _retain: bool,
    ) -> Result<(), MqttError> {
        Ok(())
    }

    async fn shutdown(&mut self, _status_topic: &str) -> Result<(), MqttError> {
        Ok(())
    }
}

#[async_trait]
impl MqttTransport for FakeTransport {
    async fn next_event(&mut self) -> Result<TransportEvent, MqttError> {
        std::future::pending().await
    }

    async fn subscribe(&mut self, topic: &str, qos: Qos) -> Result<(), MqttError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Subscribe(topic.to_owned(), qos));
        Ok(())
    }

    async fn publish(
        &mut self,
        topic: &str,
        payload: &[u8],
        qos: Qos,
        retain: bool,
    ) -> Result<(), MqttError> {
        if self
            .fail_next_publish
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(MqttError::transport("simulated transient enqueue failure"));
        }
        self.calls.lock().unwrap().push(Call::Publish(
            topic.to_owned(),
            payload.to_vec(),
            qos,
            retain,
        ));
        Ok(())
    }

    async fn shutdown(&mut self, status_topic: &str) -> Result<(), MqttError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Shutdown(status_topic.to_owned()));
        Ok(())
    }
}

#[derive(Clone)]
struct FakeClock(Arc<Mutex<ClockSample>>);

impl Clock for FakeClock {
    fn sample(&self) -> ClockSample {
        self.0.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct MemoryWriter {
    saves: Arc<Mutex<Vec<AutomationState>>>,
}

#[async_trait]
impl DurableStateWriter for MemoryWriter {
    async fn save(
        &mut self,
        state: AutomationState,
    ) -> Result<(), house_automationd::runtime::RuntimeError> {
        self.saves.lock().unwrap().push(state);
        Ok(())
    }
}

fn sample(seconds: f64) -> ClockSample {
    let wall = Stockholm.with_ymd_and_hms(2026, 9, 13, 12, 0, 0).unwrap()
        + chrono::Duration::milliseconds((seconds * 1000.0) as i64);
    ClockSample {
        wall,
        runtime: RuntimeInstant::new(
            LocalDate::new(2026, 9, 13).unwrap(),
            12,
            0,
            seconds as u8,
            MonotonicTime::from_seconds(seconds).unwrap(),
        )
        .unwrap(),
        unix_seconds: wall.timestamp(),
    }
}

type ActorHarness = (
    RuntimeActor<FakeTransport, FakeClock, MemoryWriter>,
    Arc<Mutex<Vec<Call>>>,
    Arc<Mutex<ClockSample>>,
    Arc<HealthState>,
    Arc<Mutex<Vec<AutomationState>>>,
    Arc<AtomicUsize>,
);

fn actor() -> ActorHarness {
    let parts = ValidatedConfig::parse(include_str!("../../examples/house.toml"))
        .unwrap()
        .into_runtime_parts();
    let mut engine =
        HouseEngine::initialize(parts, Default::default(), sample(0.0).runtime).unwrap();
    engine
        .apply_gesture_for_scope(
            house_automation_core::input::Gesture::CenterSingle,
            &house_automation_core::state::Scope::House,
            sample(0.0).runtime,
        )
        .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let fail_next_publish = Arc::new(AtomicUsize::new(0));
    let clock_value = Arc::new(Mutex::new(sample(0.0)));
    let health = Arc::new(HealthState::new());
    health.set_database_migrated(true);
    let writer = MemoryWriter::default();
    let saves = writer.saves.clone();
    let actor = RuntimeActor::new(
        engine,
        FakeTransport {
            calls: calls.clone(),
            fail_next_publish: fail_next_publish.clone(),
        },
        FakeClock(clock_value.clone()),
        writer,
        health.clone(),
    )
    .unwrap();
    (actor, calls, clock_value, health, saves, fail_next_publish)
}

#[tokio::test]
async fn connack_enqueues_subscriptions_reads_commands_then_retained_online_status() {
    let (mut actor, calls, _, health, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    let calls = calls.lock().unwrap();
    assert!(matches!(calls.first(), Some(Call::Subscribe(_, _))));
    assert!(
        matches!(calls.last(), Some(Call::Publish(topic, payload, Qos::AtLeastOnce, true)) if topic == "house/v1/status" && payload == b"online")
    );
    assert!(
        calls
            .iter()
            .filter_map(|call| match call {
                Call::Publish(topic, _, _, retain)
                    if topic.ends_with("/get") || topic.ends_with("/set") =>
                    Some(retain),
                _ => None,
            })
            .all(|retain| !retain)
    );
    assert_eq!(health.snapshot().status_code(), 503);
}

#[tokio::test]
async fn bridge_online_completes_readiness_and_disconnect_clears_it() {
    let (mut actor, _, _, health, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/bridge/state".to_owned(),
            payload: b"online".to_vec(),
            retain: true,
            duplicate: false,
            qos: Qos::AtLeastOnce,
        }))
        .await
        .unwrap();
    assert_eq!(health.snapshot().status_code(), 200);
    actor
        .handle_transport_event(TransportEvent::Disconnected)
        .await
        .unwrap();
    assert_eq!(health.snapshot().status_code(), 503);
}

#[tokio::test]
async fn double_click_is_one_atomic_durable_action_and_ack_commands_are_not_retained() {
    let (mut actor, calls, clock, _, saves, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();
    for seconds in [1.0, 1.2] {
        *clock.lock().unwrap() = sample(seconds);
        actor
            .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
                topic: "zigbee2mqtt/demo/living-room/remote".to_owned(),
                payload: br#"{"action":"toggle"}"#.to_vec(),
                retain: false,
                duplicate: false,
                qos: Qos::AtMostOnce,
            }))
            .await
            .unwrap();
    }
    assert_eq!(saves.lock().unwrap().len(), 1);
    let calls = calls.lock().unwrap();
    assert!(calls.iter().any(|call| matches!(call, Call::Publish(topic, payload, Qos::AtLeastOnce, false) if topic.ends_with("/set") && payload.windows(12).any(|window| window == b"\"brightness\""))));
    assert!(
        calls
            .iter()
            .all(|call| !matches!(call, Call::Publish(_, _, _, true)))
    );
}

#[tokio::test]
async fn shutdown_emits_offline_terminal_operation() {
    let (mut actor, calls, clock, _, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    actor.shutdown().await.unwrap();
    let terminal_count = calls.lock().unwrap().len();
    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    actor.tick().await.unwrap();
    assert_eq!(calls.lock().unwrap().len(), terminal_count);
    assert!(
        matches!(calls.lock().unwrap().last(), Some(Call::Shutdown(topic)) if topic == "house/v1/status")
    );
}

#[tokio::test]
async fn transient_enqueue_waits_for_backoff_before_one_retry() {
    let (mut actor, calls, clock, _, _, fail_next) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();
    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    fail_next.store(1, Ordering::SeqCst);
    *clock.lock().unwrap() = sample(2.201);
    actor.tick().await.unwrap();
    assert!(
        !calls.lock().unwrap().iter().any(is_set),
        "calls after failed enqueue: {:?}",
        calls.lock().unwrap()
    );

    *clock.lock().unwrap() = sample(2.4);
    actor.tick().await.unwrap();
    assert!(!calls.lock().unwrap().iter().any(is_set));
    *clock.lock().unwrap() = sample(2.701);
    actor.tick().await.unwrap();
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| is_set(call))
            .count(),
        2
    );
}

#[tokio::test]
async fn availability_recovery_reconciles_current_desired_target() {
    let (mut actor, calls, clock, _, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();
    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/demo/living-room/reading-light/availability".to_owned(),
            payload: b"offline".to_vec(),
            retain: true,
            duplicate: false,
            qos: Qos::AtLeastOnce,
        }))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(2.201);
    actor.tick().await.unwrap();
    calls.lock().unwrap().clear();

    *clock.lock().unwrap() = sample(2.3);
    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/demo/living-room/reading-light/availability".to_owned(),
            payload: b"online".to_vec(),
            retain: true,
            duplicate: false,
            qos: Qos::AtLeastOnce,
        }))
        .await
        .unwrap();
    assert!(calls.lock().unwrap().iter().any(is_set));
}

#[tokio::test]
async fn fatal_transport_child_failure_fails_the_actor_and_clears_readiness() {
    let parts = ValidatedConfig::parse(include_str!("../../examples/house.toml"))
        .unwrap()
        .into_runtime_parts();
    let engine = HouseEngine::initialize(parts, Default::default(), sample(0.0).runtime).unwrap();
    let health = Arc::new(HealthState::new());
    health.set_database_migrated(true);
    health.set_mqtt_connected(true);
    health.set_bridge_online(true);
    assert_eq!(health.snapshot().status_code(), 200);

    let mut actor = RuntimeActor::new(
        engine,
        FailingTransport,
        FakeClock(Arc::new(Mutex::new(sample(0.0)))),
        MemoryWriter::default(),
        health.clone(),
    )
    .unwrap();
    let error = actor.run_until(std::future::pending()).await.unwrap_err();

    assert!(error.to_string().contains("MQTT operation failed"));
    assert_eq!(health.snapshot().status_code(), 503);
}

fn remote_toggle() -> OwnedInboundMessage {
    OwnedInboundMessage {
        topic: "zigbee2mqtt/demo/living-room/remote".to_owned(),
        payload: br#"{"action":"toggle"}"#.to_vec(),
        retain: false,
        duplicate: false,
        qos: Qos::AtMostOnce,
    }
}

fn is_set(call: &Call) -> bool {
    matches!(call, Call::Publish(topic, _, _, false) if topic.ends_with("/set"))
}
