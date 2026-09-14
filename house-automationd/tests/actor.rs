use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use chrono::TimeZone;
use chrono_tz::Europe::Stockholm;
use house_automation_core::{
    reconcile::DeviceId,
    state::{AutomationState, CurveMode, LocalDate, MonotonicTime, Scope},
};
use house_automationd::{
    config::ValidatedConfig,
    health::HealthState,
    mqtt::{MqttError, MqttTransport, OwnedInboundMessage, TransportEvent},
    runtime::{DurableStateWriter, HouseEngine, RuntimeActor, RuntimeInstant, SqliteWriter},
    scheduler::{Clock, ClockSample},
    zigbee2mqtt::Qos,
};
use tempfile::tempdir;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Subscribe(String, Qos),
    Publish(String, Vec<u8>, Qos, bool),
    Shutdown(String),
}

struct FakeTransport {
    calls: Arc<Mutex<Vec<Call>>>,
    publish_control: Arc<PublishControl>,
    clock: Arc<Mutex<ClockSample>>,
}

#[derive(Default)]
struct PublishControl {
    fail_next: AtomicUsize,
    advance_clock_to: Mutex<Option<ClockSample>>,
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
        if let Some(sample) = self.publish_control.advance_clock_to.lock().unwrap().take() {
            *self.clock.lock().unwrap() = sample;
        }
        if self
            .publish_control
            .fail_next
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

struct StoppedWriter;

#[async_trait]
impl DurableStateWriter for StoppedWriter {
    async fn save(
        &mut self,
        _state: AutomationState,
    ) -> Result<(), house_automationd::runtime::RuntimeError> {
        Err(house_automationd::runtime::RuntimeError::PersistenceWorkerStopped)
    }

    fn is_healthy(&self) -> bool {
        false
    }
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

fn sample_at(day: u8, hour: u8, minute: u8, second: u8, monotonic: f64) -> ClockSample {
    let wall = Stockholm
        .with_ymd_and_hms(
            2026,
            9,
            day as u32,
            hour as u32,
            minute as u32,
            second as u32,
        )
        .unwrap();
    ClockSample {
        wall,
        runtime: RuntimeInstant::new(
            LocalDate::new(2026, 9, day).unwrap(),
            hour,
            minute,
            second,
            MonotonicTime::from_seconds(monotonic).unwrap(),
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
    Arc<PublishControl>,
);

fn actor() -> ActorHarness {
    actor_from_config(include_str!("../../examples/house.toml"))
}

fn actor_from_config(input: &str) -> ActorHarness {
    let parts = ValidatedConfig::parse(input).unwrap().into_runtime_parts();
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
    let publish_control = Arc::new(PublishControl::default());
    let clock_value = Arc::new(Mutex::new(sample(0.0)));
    let health = Arc::new(HealthState::new());
    health.set_database_migrated(true);
    let writer = MemoryWriter::default();
    let saves = writer.saves.clone();
    let actor = RuntimeActor::new(
        engine,
        FakeTransport {
            calls: calls.clone(),
            publish_control: publish_control.clone(),
            clock: clock_value.clone(),
        },
        FakeClock(clock_value.clone()),
        writer,
        health.clone(),
    )
    .unwrap();
    (actor, calls, clock_value, health, saves, publish_control)
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
async fn health_does_not_report_a_batch_whose_only_publication_failed() {
    let input = include_str!("../../examples/house.toml");
    let second_device = input
        .find("[[devices]]\nid = \"color-light\"")
        .expect("example has second device");
    let controls = input.find("[[controls]]").expect("example has controls");
    let one_device = format!("{}{}", &input[..second_device], &input[controls..]);
    let (mut actor, _, clock, health, _, publish_control) = actor_from_config(&one_device);
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    let before = serde_json::to_value(health.snapshot()).unwrap()
        ["last_successful_reconciliation_unix_seconds"]
        .clone();

    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    publish_control.fail_next.store(1, Ordering::SeqCst);
    *clock.lock().unwrap() = sample(2.201);
    actor.tick().await.unwrap();

    let snapshot = serde_json::to_value(health.snapshot()).unwrap();
    assert_eq!(
        snapshot["last_successful_reconciliation_unix_seconds"],
        before
    );
}

#[tokio::test]
async fn health_records_a_split_transition_only_after_its_delayed_operation_is_accepted() {
    let input = include_str!("../../examples/house.toml");
    let second_device = input
        .find("[[devices]]\nid = \"color-light\"")
        .expect("example has second device");
    let controls = input.find("[[controls]]").expect("example has controls");
    let one_device = format!("{}{}", &input[..second_device], &input[controls..]);
    let (mut actor, _, clock, health, _, _) = actor_from_config(&one_device);
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    *clock.lock().unwrap() = sample_at(13, 12, 0, 1, 0.5);
    actor.tick().await.unwrap();

    for seconds in [1.0, 1.2] {
        *clock.lock().unwrap() = sample(seconds);
        actor
            .handle_transport_event(TransportEvent::Publish(remote_toggle()))
            .await
            .unwrap();
    }
    *clock.lock().unwrap() = sample(1.381);
    actor.tick().await.unwrap();
    for monotonic in [60.0, 60.2] {
        *clock.lock().unwrap() = sample_at(13, 12, 1, 0, monotonic);
        actor
            .handle_transport_event(TransportEvent::Publish(remote_toggle()))
            .await
            .unwrap();
    }
    let before = serde_json::to_value(health.snapshot()).unwrap()
        ["last_successful_reconciliation_unix_seconds"]
        .clone();

    *clock.lock().unwrap() = sample_at(13, 12, 1, 0, 60.381);
    actor.tick().await.unwrap();
    let pending = serde_json::to_value(health.snapshot()).unwrap();
    assert_eq!(
        pending["last_successful_reconciliation_unix_seconds"],
        before
    );

    *clock.lock().unwrap() = sample_at(13, 12, 1, 30, 90.5);
    actor.tick().await.unwrap();
    let completed = serde_json::to_value(health.snapshot()).unwrap();
    assert_ne!(
        completed["last_successful_reconciliation_unix_seconds"],
        before
    );
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
async fn retained_malformed_device_payload_is_dropped_without_terminating_actor() {
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
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/demo/living-room/reading-light".to_owned(),
            payload: b"{retained-poison-sentinel".to_vec(),
            retain: true,
            duplicate: false,
            qos: Qos::AtLeastOnce,
        }))
        .await
        .unwrap();

    assert_eq!(health.snapshot().status_code(), 200);
}

#[tokio::test]
async fn retained_malformed_bridge_state_is_dropped_and_marks_bridge_unready() {
    let (mut actor, _, _, health, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    health.set_bridge_online(true);
    assert_eq!(health.snapshot().status_code(), 200);

    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/bridge/state".to_owned(),
            payload: b"retained-poison-sentinel".to_vec(),
            retain: true,
            duplicate: false,
            qos: Qos::AtLeastOnce,
        }))
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
async fn center_single_waits_for_the_real_deadline_before_acting() {
    let (mut actor, calls, clock, _, saves, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();
    saves.lock().unwrap().clear();

    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(2.199);
    actor.tick().await.unwrap();
    assert!(saves.lock().unwrap().is_empty());
    assert!(!calls.lock().unwrap().iter().any(is_set));

    *clock.lock().unwrap() = sample(2.201);
    actor.tick().await.unwrap();
    assert_eq!(saves.lock().unwrap().len(), 1);
    assert!(calls.lock().unwrap().iter().any(is_set));
}

#[tokio::test]
async fn center_hold_cancels_its_ambiguous_click_without_later_single_or_double() {
    let (mut actor, calls, clock, _, saves, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();
    saves.lock().unwrap().clear();

    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(1.5);
    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/demo/living-room/remote".to_owned(),
            payload: br#"{"action":"toggle_hold"}"#.to_vec(),
            retain: false,
            duplicate: false,
            qos: Qos::AtMostOnce,
        }))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(3.0);
    actor.tick().await.unwrap();

    assert!(saves.lock().unwrap().is_empty());
    assert!(!calls.lock().unwrap().iter().any(is_set));
}

#[tokio::test]
async fn freeze_and_unfreeze_have_distinct_acknowledgements_that_expire_into_current_state() {
    let (mut actor, _, clock, _, saves, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    saves.lock().unwrap().clear();
    let device = DeviceId::new("reading-light").unwrap();

    for seconds in [1.0, 1.2] {
        *clock.lock().unwrap() = sample(seconds);
        actor
            .handle_transport_event(TransportEvent::Publish(remote_toggle()))
            .await
            .unwrap();
    }
    let frozen_ack = actor.engine().target(&device).unwrap().brightness.unwrap();
    *clock.lock().unwrap() = sample(1.381);
    actor.tick().await.unwrap();
    let frozen_underlying = actor.engine().target(&device).unwrap().brightness.unwrap();
    assert_ne!(frozen_ack, frozen_underlying);

    for seconds in [2.0, 2.2] {
        *clock.lock().unwrap() = sample(seconds);
        actor
            .handle_transport_event(TransportEvent::Publish(remote_toggle()))
            .await
            .unwrap();
    }
    let unfrozen_ack = actor.engine().target(&device).unwrap().brightness.unwrap();
    assert_ne!(frozen_ack, unfrozen_ack);
    *clock.lock().unwrap() = sample(2.381);
    actor.tick().await.unwrap();
    let unfrozen_underlying = actor.engine().target(&device).unwrap().brightness.unwrap();

    assert_ne!(unfrozen_ack, unfrozen_underlying);
    assert_eq!(saves.lock().unwrap().len(), 2);
    assert!(
        actor
            .engine()
            .owner_states()
            .all(|(_, state)| { matches!(state.mode(), CurveMode::Converging { .. }) })
    );
}

#[tokio::test]
async fn whole_hour_overlay_expires_to_recomputed_state_after_an_underlying_offset_change() {
    let (mut actor, _, clock, _, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    let device = DeviceId::new("reading-light").unwrap();

    *clock.lock().unwrap() = sample_at(13, 13, 0, 0, 3_600.0);
    actor.tick().await.unwrap();
    let pulse = actor.engine().target(&device).unwrap().brightness.unwrap();

    *clock.lock().unwrap() = sample_at(13, 13, 0, 0, 3_600.2);
    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/demo/living-room/remote".to_owned(),
            payload: br#"{"action":"brightness_down_click"}"#.to_vec(),
            retain: false,
            duplicate: false,
            qos: Qos::AtMostOnce,
        }))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample_at(13, 13, 0, 0, 3_600.501);
    actor.tick().await.unwrap();
    let recomputed = actor.engine().target(&device).unwrap().brightness.unwrap();

    assert!(recomputed < pulse);
    assert_eq!(
        actor
            .engine()
            .state()
            .scope_state(actor.engine().owner_scope(&device).unwrap())
            .unwrap()
            .offsets()
            .brightness(),
        -0.05
    );
}

#[tokio::test]
async fn actor_curve_tick_suppresses_subthreshold_sparse_publications() {
    let (mut actor, calls, clock, _, _, _) = actor();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();

    *clock.lock().unwrap() = sample(1.0);
    actor.tick().await.unwrap();

    assert!(!calls.lock().unwrap().iter().any(is_set));
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
    fail_next.fail_next.store(1, Ordering::SeqCst);
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
async fn transient_backoff_starts_when_the_publish_attempt_actually_finishes() {
    let (mut actor, calls, clock, _, _, publish_control) = actor();
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
    publish_control.fail_next.store(1, Ordering::SeqCst);
    *publish_control.advance_clock_to.lock().unwrap() = Some(sample(10.0));

    *clock.lock().unwrap() = sample(2.201);
    actor.tick().await.unwrap();
    assert!(!calls.lock().unwrap().iter().any(is_set));

    *clock.lock().unwrap() = sample(10.4);
    actor.tick().await.unwrap();
    assert!(!calls.lock().unwrap().iter().any(is_set));

    *clock.lock().unwrap() = sample(10.501);
    actor.tick().await.unwrap();
    assert!(calls.lock().unwrap().iter().any(is_set));
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
async fn reconnect_publishes_only_current_desired_state_after_an_enqueued_command_was_invalidated()
{
    let (mut actor, calls, clock, _, _, _) = actor();
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
    *clock.lock().unwrap() = sample(2.201);
    actor.tick().await.unwrap();
    assert!(calls.lock().unwrap().iter().any(|call| {
        matches!(call, Call::Publish(topic, payload, _, false)
            if topic.ends_with("/set") && payload.windows(13).any(|value| value == b"\"state\":\"OFF\""))
    }));

    *clock.lock().unwrap() = sample(2.3);
    actor
        .handle_transport_event(TransportEvent::Disconnected)
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(3.0);
    actor
        .handle_transport_event(TransportEvent::Publish(remote_toggle()))
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(4.201);
    actor.tick().await.unwrap();
    calls.lock().unwrap().clear();

    *clock.lock().unwrap() = sample(4.3);
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();

    let set_payloads: Vec<_> = calls
        .lock()
        .unwrap()
        .iter()
        .filter_map(|call| match call {
            Call::Publish(topic, payload, _, false) if topic.ends_with("/set") => {
                Some(payload.clone())
            }
            _ => None,
        })
        .collect();
    assert!(!set_payloads.is_empty());
    assert!(set_payloads.iter().all(|payload| {
        !payload
            .windows(13)
            .any(|value| value == b"\"state\":\"OFF\"")
    }));
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

#[tokio::test]
async fn stopped_persistence_worker_fails_actor_and_marks_database_unready() {
    let engine = HouseEngine::initialize(
        ValidatedConfig::parse(include_str!("../../examples/house.toml"))
            .unwrap()
            .into_runtime_parts(),
        Default::default(),
        sample(0.0).runtime,
    )
    .unwrap();
    let clock = Arc::new(Mutex::new(sample(0.0)));
    let health = Arc::new(HealthState::new());
    health.set_database_migrated(true);
    health.set_mqtt_connected(true);
    health.set_bridge_online(true);
    let mut actor = RuntimeActor::new(
        engine,
        FakeTransport {
            calls: Arc::new(Mutex::new(Vec::new())),
            publish_control: Arc::new(PublishControl::default()),
            clock: clock.clone(),
        },
        FakeClock(clock),
        StoppedWriter,
        health.clone(),
    )
    .unwrap();

    let error = actor.tick().await.unwrap_err();

    assert!(matches!(
        error,
        house_automationd::runtime::RuntimeError::PersistenceWorkerStopped
    ));
    assert_eq!(health.snapshot().status_code(), 503);
}

#[tokio::test]
async fn first_connack_rechecks_and_persists_a_reset_boundary_crossed_during_startup() {
    let mut frozen = HouseEngine::initialize(
        ValidatedConfig::parse(include_str!("../../examples/house.toml"))
            .unwrap()
            .into_runtime_parts(),
        Default::default(),
        sample_at(13, 12, 0, 0, 1.0).runtime,
    )
    .unwrap();
    frozen
        .apply_gesture_for_scope(
            house_automation_core::input::Gesture::CenterDouble,
            &Scope::House,
            sample_at(13, 12, 0, 0, 2.0).runtime,
        )
        .unwrap();
    let engine = HouseEngine::initialize(
        ValidatedConfig::parse(include_str!("../../examples/house.toml"))
            .unwrap()
            .into_runtime_parts(),
        frozen.state().clone(),
        sample_at(14, 3, 59, 59, 0.0).runtime,
    )
    .unwrap();
    let clock = Arc::new(Mutex::new(sample_at(14, 3, 59, 59, 0.0)));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let publish_control = Arc::new(PublishControl::default());
    let writer = MemoryWriter::default();
    let saves = writer.saves.clone();
    let mut actor = RuntimeActor::new(
        engine,
        FakeTransport {
            calls,
            publish_control,
            clock: clock.clone(),
        },
        FakeClock(clock.clone()),
        writer,
        Arc::new(HealthState::new()),
    )
    .unwrap();

    *clock.lock().unwrap() = sample_at(14, 4, 0, 0, 1.0);
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();

    assert!(
        actor
            .engine()
            .owner_states()
            .all(|(_, state)| matches!(state.mode(), CurveMode::Converging { .. }))
    );
    assert_eq!(
        saves.lock().unwrap().last().unwrap().last_reset_date(),
        Some(LocalDate::new(2026, 9, 14).unwrap())
    );
}

#[tokio::test]
async fn actor_state_survives_a_restart_through_the_real_sqlite_writer() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("state.sqlite3");
    let (writer, persisted) = SqliteWriter::open(&database).await.unwrap();
    let engine = HouseEngine::initialize(
        ValidatedConfig::parse(include_str!("../../examples/house.toml"))
            .unwrap()
            .into_runtime_parts(),
        persisted,
        sample(0.0).runtime,
    )
    .unwrap();
    let clock = Arc::new(Mutex::new(sample(0.0)));
    let mut actor = RuntimeActor::new(
        engine,
        FakeTransport {
            calls: Arc::new(Mutex::new(Vec::new())),
            publish_control: Arc::new(PublishControl::default()),
            clock: clock.clone(),
        },
        FakeClock(clock.clone()),
        writer,
        Arc::new(HealthState::new()),
    )
    .unwrap();
    actor
        .handle_transport_event(TransportEvent::Connected)
        .await
        .unwrap();
    *clock.lock().unwrap() = sample(1.0);
    actor
        .handle_transport_event(TransportEvent::Publish(OwnedInboundMessage {
            topic: "zigbee2mqtt/demo/living-room/remote".to_owned(),
            payload: br#"{"action":"brightness_up_click"}"#.to_vec(),
            retain: false,
            duplicate: false,
            qos: Qos::AtMostOnce,
        }))
        .await
        .unwrap();
    actor.shutdown().await.unwrap();
    drop(actor);

    let (_writer, restored) = SqliteWriter::open(&database).await.unwrap();
    assert_eq!(
        restored
            .scope_state(&Scope::Room(
                house_automation_core::state::ScopeId::new("living-room").unwrap()
            ))
            .unwrap()
            .offsets()
            .brightness(),
        0.05
    );
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
