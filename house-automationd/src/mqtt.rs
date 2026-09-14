use std::{
    collections::{BTreeMap, VecDeque},
    error::Error,
    fmt, fs,
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use rumqttc::{AsyncClient, Event, EventLoop, LastWill, MqttOptions, Packet, Publish, QoS};
use tokio::{
    sync::{Notify, mpsc, watch},
    task::JoinHandle,
};

use crate::{
    config::{MqttCredentialSource, MqttSettings},
    zigbee2mqtt::{InboundMessage, Qos},
};

const MAX_CREDENTIAL_FILE_BYTES: u64 = 64 * 1024;
const MAX_CREDENTIAL_VALUE_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub struct MqttCredentials {
    username: String,
    password: String,
}

impl MqttCredentials {
    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn password(&self) -> &str {
        &self.password
    }
}

impl fmt::Debug for MqttCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MqttCredentials(<redacted>)")
    }
}

pub fn load_credentials(source: &MqttCredentialSource) -> Result<MqttCredentials, MqttError> {
    let path_metadata = fs::symlink_metadata(&source.environment_file)
        .map_err(|_| MqttError::credential("cannot inspect credential file"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(MqttError::credential(
            "credential file must be a regular non-symlink file",
        ));
    }
    validate_credential_permissions(&path_metadata)?;
    let canonical = fs::canonicalize(&source.environment_file)
        .map_err(|_| MqttError::credential("cannot resolve credential file"))?;
    if !canonical.is_absolute() || canonical.starts_with("/nix/store") {
        return Err(MqttError::credential(
            "credential file must resolve outside the Nix store",
        ));
    }
    let file = open_credential_file(&source.environment_file)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| MqttError::credential("cannot inspect opened credential file"))?;
    if !same_file(&path_metadata, &opened_metadata)
        || !opened_metadata.is_file()
        || opened_metadata.len() > MAX_CREDENTIAL_FILE_BYTES
    {
        return Err(MqttError::credential(
            "credential file must be a bounded regular file",
        ));
    }
    validate_credential_permissions(&opened_metadata)?;
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(MAX_CREDENTIAL_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| MqttError::credential("cannot read credential file"))?;
    if bytes.len() as u64 > MAX_CREDENTIAL_FILE_BYTES {
        return Err(MqttError::credential("credential file is too large"));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| MqttError::credential("credential file must be UTF-8"))?;
    let values = parse_environment_file(text)?;
    let username = required_credential(&values, &source.username_variable)?;
    let password = required_credential(&values, &source.password_variable)?;
    Ok(MqttCredentials { username, password })
}

#[cfg(target_os = "linux")]
fn open_credential_file(path: &Path) -> Result<fs::File, MqttError> {
    use std::os::unix::fs::OpenOptionsExt;

    // Linux O_NOFOLLOW: reject a final-component symlink in the same open
    // operation that acquires the descriptor, closing the metadata/open race.
    const O_NOFOLLOW: i32 = 0o400_000;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
        .map_err(|_| MqttError::credential("cannot safely open credential file"))
}

#[cfg(not(target_os = "linux"))]
fn open_credential_file(path: &Path) -> Result<fs::File, MqttError> {
    fs::File::open(path).map_err(|_| MqttError::credential("cannot open credential file"))
}

#[cfg(unix)]
fn validate_credential_permissions(metadata: &fs::Metadata) -> Result<(), MqttError> {
    use std::os::unix::fs::MetadataExt;

    if metadata.mode() & 0o077 != 0 {
        return Err(MqttError::credential(
            "credential file permissions must deny group and other access",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_credential_permissions(_metadata: &fs::Metadata) -> Result<(), MqttError> {
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

fn parse_environment_file(input: &str) -> Result<BTreeMap<String, String>, MqttError> {
    let mut values = BTreeMap::new();
    for line in input.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, value) = line
            .split_once('=')
            .ok_or_else(|| MqttError::credential("credential line must be KEY=value"))?;
        if !valid_environment_name(name)
            || value.is_empty()
            || value.len() > MAX_CREDENTIAL_VALUE_BYTES
            || value.contains('\0')
        {
            return Err(MqttError::credential("credential entry is invalid"));
        }
        if values.insert(name.to_owned(), value.to_owned()).is_some() {
            return Err(MqttError::credential("credential variable is duplicated"));
        }
    }
    Ok(values)
}

fn valid_environment_name(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn required_credential(
    values: &BTreeMap<String, String>,
    variable: &str,
) -> Result<String, MqttError> {
    values
        .get(variable)
        .cloned()
        .ok_or_else(|| MqttError::credential("required credential variable is missing"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportEvent {
    Connected,
    Disconnected,
    Publish(OwnedInboundMessage),
}

#[derive(Clone, PartialEq, Eq)]
pub struct OwnedInboundMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
    pub duplicate: bool,
    pub qos: Qos,
}

impl fmt::Debug for OwnedInboundMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OwnedInboundMessage")
            .field("topic", &self.topic)
            .field("payload", &"<redacted>")
            .field("retain", &self.retain)
            .field("duplicate", &self.duplicate)
            .field("qos", &self.qos)
            .finish()
    }
}

impl OwnedInboundMessage {
    pub fn as_inbound(&self) -> InboundMessage<'_> {
        InboundMessage::new(
            &self.topic,
            &self.payload,
            self.retain,
            self.duplicate,
            self.qos,
        )
    }
}

#[async_trait]
pub trait MqttTransport: Send {
    async fn next_event(&mut self) -> Result<TransportEvent, MqttError>;
    async fn subscribe(&mut self, topic: &str, qos: Qos) -> Result<(), MqttError>;
    async fn publish(
        &mut self,
        topic: &str,
        payload: &[u8],
        qos: Qos,
        retain: bool,
    ) -> Result<(), MqttError>;
    async fn shutdown(&mut self, status_topic: &str) -> Result<(), MqttError>;
}

pub struct RumqttTransport {
    client: AsyncClient,
    events: mpsc::Receiver<TransportEvent>,
    failure: watch::Receiver<Option<MqttError>>,
    delivery: DeliveryTracker,
    driver: Option<JoinHandle<()>>,
}

impl RumqttTransport {
    pub fn connect(
        settings: &MqttSettings,
        credentials: Option<&MqttCredentials>,
    ) -> Result<Self, MqttError> {
        let options = build_mqtt_options(settings, credentials);
        let (client, event_loop) = AsyncClient::new(options, 32);
        let (event_sender, events) = mpsc::channel(128);
        let (failure_sender, failure) = watch::channel(None);
        let delivery = DeliveryTracker::default();
        let driver = tokio::spawn(run_event_loop(
            event_loop,
            event_sender,
            failure_sender,
            delivery.clone(),
        ));
        Ok(Self {
            client,
            events,
            failure,
            delivery,
            driver: Some(driver),
        })
    }

    async fn enqueue_publish(
        &self,
        topic: &str,
        payload: &[u8],
        qos: Qos,
        retain: bool,
        observe_delivery: bool,
    ) -> Result<Option<DeliveryTicket>, MqttError> {
        let ticket = self.delivery.reserve(observe_delivery)?;
        if self
            .client
            .try_publish(topic, to_rumqtt_qos(qos), retain, payload.to_vec())
            .is_err()
        {
            self.delivery.cancel(ticket);
            return Err(MqttError::transport("MQTT publication enqueue failed"));
        }
        Ok(observe_delivery.then_some(ticket))
    }
}

fn build_mqtt_options(
    settings: &MqttSettings,
    credentials: Option<&MqttCredentials>,
) -> MqttOptions {
    let status_topic = status_topic(&settings.application_namespace);
    let mut options = MqttOptions::new(&settings.client_id, &settings.host, settings.port);
    options.set_keep_alive(Duration::from_secs(30));
    // Commands are recomputed from current desired state after every ConnAck.
    // A clean broker and local session prevents invalidated QoS1 commands from
    // the previous connection from being replayed ahead of that reconciliation.
    options.set_clean_session(true);
    options.set_last_will(LastWill::new(
        status_topic,
        b"offline".to_vec(),
        QoS::AtLeastOnce,
        true,
    ));
    if let Some(credentials) = credentials {
        options.set_credentials(credentials.username(), credentials.password());
    }
    options
}

#[async_trait]
impl MqttTransport for RumqttTransport {
    async fn next_event(&mut self) -> Result<TransportEvent, MqttError> {
        tokio::select! {
            event = self.events.recv() => event.ok_or_else(|| {
                self.failure.borrow().clone().unwrap_or_else(|| {
                    MqttError::fatal("MQTT event loop stopped")
                })
            }),
            changed = self.failure.changed() => {
                changed.map_err(|_| MqttError::fatal("MQTT event loop stopped"))?;
                Err(self.failure.borrow().clone().unwrap_or_else(|| {
                    MqttError::fatal("MQTT event loop stopped")
                }))
            }
        }
    }

    async fn subscribe(&mut self, topic: &str, qos: Qos) -> Result<(), MqttError> {
        self.client
            .subscribe(topic, to_rumqtt_qos(qos))
            .await
            .map_err(|_| MqttError::transport("MQTT subscription enqueue failed"))
    }

    async fn publish(
        &mut self,
        topic: &str,
        payload: &[u8],
        qos: Qos,
        retain: bool,
    ) -> Result<(), MqttError> {
        self.enqueue_publish(topic, payload, qos, retain, false)
            .await
            .map(|_| ())
    }

    async fn shutdown(&mut self, status_topic: &str) -> Result<(), MqttError> {
        self.delivery.wait_until_idle().await?;
        let offline = self
            .enqueue_publish(status_topic, b"offline", Qos::AtLeastOnce, true, true)
            .await?;
        self.delivery
            .wait_until_delivered(offline.expect("observed publication returns ticket"))
            .await?;
        self.client
            .disconnect()
            .await
            .map_err(|_| MqttError::transport("MQTT disconnect enqueue failed"))?;
        if let Some(driver) = self.driver.take() {
            tokio::time::timeout(Duration::from_secs(5), driver)
                .await
                .map_err(|_| MqttError::transport("MQTT shutdown acknowledgement timed out"))?
                .map_err(|_| MqttError::transport("MQTT event loop task failed"))?;
        }
        Ok(())
    }
}

async fn run_event_loop(
    mut event_loop: EventLoop,
    events: mpsc::Sender<TransportEvent>,
    failure: watch::Sender<Option<MqttError>>,
    delivery: DeliveryTracker,
) {
    let mut reconnect = ReconnectState::default();
    loop {
        let event = match event_loop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                reconnect.connected();
                Some(TransportEvent::Connected)
            }
            Ok(Event::Incoming(Packet::Publish(publish))) => {
                Some(TransportEvent::Publish(owned_publish(publish)))
            }
            Ok(Event::Incoming(Packet::PubAck(acknowledgement))) => {
                delivery.puback(acknowledgement.pkid);
                None
            }
            Ok(Event::Outgoing(rumqttc::Outgoing::Publish(packet_id))) => {
                delivery.outgoing_publish(packet_id);
                None
            }
            Ok(Event::Outgoing(rumqttc::Outgoing::Disconnect)) => break,
            Ok(_) => None,
            Err(_) => {
                delivery.connection_lost();
                if let Err(error) = reconnect.after_poll_error(&events).await {
                    let _ = failure.send(Some(error));
                    break;
                }
                continue;
            }
        };
        if let Some(event) = event
            && let Err(error) = forward_event(&events, event).await
        {
            let _ = failure.send(Some(error));
            break;
        }
    }
}

const INITIAL_RECONNECT_BACKOFF: Duration = Duration::from_millis(250);
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Default)]
struct ReconnectState {
    connected: bool,
    failures: u32,
}

impl ReconnectState {
    fn connected(&mut self) {
        self.connected = true;
        self.failures = 0;
    }

    async fn after_poll_error(
        &mut self,
        events: &mpsc::Sender<TransportEvent>,
    ) -> Result<(), MqttError> {
        if self.connected {
            forward_event(events, TransportEvent::Disconnected).await?;
            self.connected = false;
        }
        let exponent = self.failures.min(7);
        let multiplier = 1_u32 << exponent;
        let delay = INITIAL_RECONNECT_BACKOFF
            .checked_mul(multiplier)
            .unwrap_or(MAX_RECONNECT_BACKOFF)
            .min(MAX_RECONNECT_BACKOFF);
        self.failures = self.failures.saturating_add(1);
        tokio::time::sleep(delay).await;
        Ok(())
    }
}

async fn forward_event(
    events: &mpsc::Sender<TransportEvent>,
    event: TransportEvent,
) -> Result<(), MqttError> {
    events
        .send(event)
        .await
        .map_err(|_| MqttError::fatal("MQTT actor event receiver stopped"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct DeliveryTicket(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryOutcome {
    Delivered,
    Lost,
}

#[derive(Default)]
struct DeliveryState {
    next_ticket: u64,
    queued: VecDeque<DeliveryTicket>,
    pending: BTreeMap<DeliveryTicket, bool>,
    packets: BTreeMap<u16, DeliveryTicket>,
    outcomes: BTreeMap<DeliveryTicket, DeliveryOutcome>,
}

#[derive(Clone, Default)]
struct DeliveryTracker {
    state: Arc<Mutex<DeliveryState>>,
    changed: Arc<Notify>,
}

impl DeliveryTracker {
    fn reserve(&self, observe_outcome: bool) -> Result<DeliveryTicket, MqttError> {
        let mut state = self.state.lock().expect("delivery tracker lock poisoned");
        state.next_ticket = state
            .next_ticket
            .checked_add(1)
            .ok_or_else(|| MqttError::fatal("MQTT delivery ticket space exhausted"))?;
        let ticket = DeliveryTicket(state.next_ticket);
        state.queued.push_back(ticket);
        state.pending.insert(ticket, observe_outcome);
        Ok(ticket)
    }

    fn cancel(&self, ticket: DeliveryTicket) {
        let mut state = self.state.lock().expect("delivery tracker lock poisoned");
        state.queued.retain(|queued| *queued != ticket);
        if state.pending.remove(&ticket).unwrap_or(false) {
            state.outcomes.insert(ticket, DeliveryOutcome::Lost);
        }
        drop(state);
        self.changed.notify_waiters();
    }

    fn outgoing_publish(&self, packet_id: u16) {
        let mut state = self.state.lock().expect("delivery tracker lock poisoned");
        if state.packets.contains_key(&packet_id) {
            return;
        }
        let Some(ticket) = state.queued.pop_front() else {
            return;
        };
        if packet_id == 0 {
            settle_delivery(&mut state, ticket, DeliveryOutcome::Delivered);
        } else {
            state.packets.insert(packet_id, ticket);
        }
        drop(state);
        self.changed.notify_waiters();
    }

    fn puback(&self, packet_id: u16) {
        let mut state = self.state.lock().expect("delivery tracker lock poisoned");
        if let Some(ticket) = state.packets.remove(&packet_id) {
            settle_delivery(&mut state, ticket, DeliveryOutcome::Delivered);
        }
        drop(state);
        self.changed.notify_waiters();
    }

    fn connection_lost(&self) {
        let mut state = self.state.lock().expect("delivery tracker lock poisoned");
        let pending: Vec<_> = state.pending.keys().copied().collect();
        for ticket in pending {
            settle_delivery(&mut state, ticket, DeliveryOutcome::Lost);
        }
        state.queued.clear();
        state.packets.clear();
        drop(state);
        self.changed.notify_waiters();
    }

    fn outcome(&self, ticket: DeliveryTicket) -> Option<DeliveryOutcome> {
        self.state
            .lock()
            .expect("delivery tracker lock poisoned")
            .outcomes
            .get(&ticket)
            .copied()
    }

    async fn wait_until_idle(&self) -> Result<(), MqttError> {
        self.wait_for(|state| state.pending.is_empty()).await
    }

    async fn wait_until_delivered(&self, ticket: DeliveryTicket) -> Result<(), MqttError> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let changed = self.changed.notified();
                match self.outcome(ticket) {
                    Some(DeliveryOutcome::Delivered) => return Ok(()),
                    Some(DeliveryOutcome::Lost) => {
                        return Err(MqttError::transport(
                            "MQTT offline status was not acknowledged",
                        ));
                    }
                    None => changed.await,
                }
            }
        })
        .await
        .map_err(|_| MqttError::transport("MQTT delivery acknowledgement timed out"))?
    }

    async fn wait_for(&self, ready: impl Fn(&DeliveryState) -> bool) -> Result<(), MqttError> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let changed = self.changed.notified();
                if ready(&self.state.lock().expect("delivery tracker lock poisoned")) {
                    return;
                }
                changed.await;
            }
        })
        .await
        .map_err(|_| MqttError::transport("MQTT delivery acknowledgement timed out"))
    }
}

fn settle_delivery(state: &mut DeliveryState, ticket: DeliveryTicket, outcome: DeliveryOutcome) {
    if state.pending.remove(&ticket).unwrap_or(false) {
        state.outcomes.insert(ticket, outcome);
    }
}

fn owned_publish(publish: Publish) -> OwnedInboundMessage {
    OwnedInboundMessage {
        topic: publish.topic,
        payload: publish.payload.to_vec(),
        retain: publish.retain,
        duplicate: publish.dup,
        qos: from_rumqtt_qos(publish.qos),
    }
}

fn to_rumqtt_qos(qos: Qos) -> QoS {
    match qos {
        Qos::AtMostOnce => QoS::AtMostOnce,
        Qos::AtLeastOnce => QoS::AtLeastOnce,
        Qos::ExactlyOnce => QoS::ExactlyOnce,
    }
}

fn from_rumqtt_qos(qos: QoS) -> Qos {
    match qos {
        QoS::AtMostOnce => Qos::AtMostOnce,
        QoS::AtLeastOnce => Qos::AtLeastOnce,
        QoS::ExactlyOnce => Qos::ExactlyOnce,
    }
}

pub fn status_topic(namespace: &str) -> String {
    format!("{namespace}/status")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MqttError {
    kind: MqttErrorKind,
    message: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MqttErrorKind {
    Credential,
    Transport,
    Fatal,
}

impl MqttError {
    fn credential(message: &'static str) -> Self {
        Self {
            kind: MqttErrorKind::Credential,
            message,
        }
    }

    pub fn transport(message: &'static str) -> Self {
        Self {
            kind: MqttErrorKind::Transport,
            message,
        }
    }

    pub fn fatal(message: &'static str) -> Self {
        Self {
            kind: MqttErrorKind::Fatal,
            message,
        }
    }

    pub fn is_transient(&self) -> bool {
        self.kind == MqttErrorKind::Transport
    }
}

impl fmt::Display for MqttError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for MqttError {}

pub fn path_is_outside_nix_store(path: &Path) -> bool {
    path.is_absolute() && !path.starts_with("/nix/store")
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, time::Duration};

    use tempfile::tempdir;

    use crate::config::MqttCredentialSource;

    use super::{
        MAX_CREDENTIAL_FILE_BYTES, load_credentials, parse_environment_file,
        path_is_outside_nix_store,
    };

    #[test]
    fn transport_uses_a_clean_session_so_invalidated_commands_cannot_replay() {
        let settings =
            crate::config::ValidatedConfig::parse(include_str!("../../examples/house.toml"))
                .unwrap()
                .into_runtime_parts()
                .mqtt;

        let options = super::build_mqtt_options(&settings, None);

        assert!(options.clean_session());
    }

    #[tokio::test(start_paused = true)]
    async fn poll_errors_back_off_and_emit_one_disconnect_per_connection_edge() {
        let (events, mut received) = tokio::sync::mpsc::channel(4);
        let mut reconnect = super::ReconnectState::default();
        reconnect.connected();
        let started = tokio::time::Instant::now();

        reconnect.after_poll_error(&events).await.unwrap();
        reconnect.after_poll_error(&events).await.unwrap();

        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_millis(750)
        );
        assert_eq!(
            received.try_recv().unwrap(),
            super::TransportEvent::Disconnected
        );
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn bounded_event_forwarding_applies_backpressure_without_losing_a_retained_burst() {
        const COUNT: usize = 200;
        let (events, mut received) = tokio::sync::mpsc::channel(2);
        let sender = tokio::spawn(async move {
            for index in 0..COUNT {
                super::forward_event(
                    &events,
                    super::TransportEvent::Publish(super::OwnedInboundMessage {
                        topic: "zigbee2mqtt/device".to_owned(),
                        payload: index.to_string().into_bytes(),
                        retain: true,
                        duplicate: false,
                        qos: crate::zigbee2mqtt::Qos::AtLeastOnce,
                    }),
                )
                .await
                .unwrap();
            }
        });

        let mut count = 0;
        while count < COUNT {
            assert!(matches!(
                received.recv().await,
                Some(super::TransportEvent::Publish(message)) if message.retain
            ));
            count += 1;
        }
        sender.await.unwrap();
        assert_eq!(count, COUNT);
    }

    #[tokio::test]
    async fn publication_enqueue_never_waits_on_a_driver_blocked_by_inbound_backpressure() {
        let options = rumqttc::MqttOptions::new("bounded-test", "127.0.0.1", 1883);
        let (client, _event_loop) = rumqttc::AsyncClient::new(options, 1);
        let (_event_sender, events) = tokio::sync::mpsc::channel(1);
        let (_failure_sender, failure) = tokio::sync::watch::channel(None);
        let transport = super::RumqttTransport {
            client,
            events,
            failure,
            delivery: super::DeliveryTracker::default(),
            driver: None,
        };
        transport
            .enqueue_publish(
                "house/v1/test",
                b"first",
                crate::zigbee2mqtt::Qos::AtLeastOnce,
                false,
                false,
            )
            .await
            .unwrap();

        let result = tokio::time::timeout(
            Duration::from_millis(10),
            transport.enqueue_publish(
                "house/v1/test",
                b"second",
                crate::zigbee2mqtt::Qos::AtLeastOnce,
                false,
                false,
            ),
        )
        .await
        .expect("a full outbound queue must fail without waiting");

        assert!(result.unwrap_err().is_transient());
    }

    #[test]
    fn disconnect_resets_inflight_packet_ids_before_offline_delivery_tracking() {
        let tracker = super::DeliveryTracker::default();
        let stale = tracker.reserve(true).unwrap();
        tracker.outgoing_publish(7);

        tracker.connection_lost();
        let offline = tracker.reserve(true).unwrap();
        tracker.outgoing_publish(7);
        assert_eq!(tracker.outcome(stale), Some(super::DeliveryOutcome::Lost));
        assert_eq!(tracker.outcome(offline), None);

        tracker.puback(7);
        assert_eq!(
            tracker.outcome(offline),
            Some(super::DeliveryOutcome::Delivered)
        );
    }

    #[test]
    fn retransmitted_packet_id_does_not_consume_the_next_queued_ticket() {
        let tracker = super::DeliveryTracker::default();
        let first = tracker.reserve(true).unwrap();
        let second = tracker.reserve(true).unwrap();

        tracker.outgoing_publish(9);
        tracker.outgoing_publish(9);
        tracker.puback(9);
        assert_eq!(
            tracker.outcome(first),
            Some(super::DeliveryOutcome::Delivered)
        );
        assert_eq!(tracker.outcome(second), None);

        tracker.outgoing_publish(10);
        tracker.puback(10);
        assert_eq!(
            tracker.outcome(second),
            Some(super::DeliveryOutcome::Delivered)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn lost_offline_ticket_fails_without_waiting_for_delivery_timeout() {
        let tracker = super::DeliveryTracker::default();
        let offline = tracker.reserve(true).unwrap();
        tracker.outgoing_publish(11);
        tracker.connection_lost();

        let error = tracker.wait_until_delivered(offline).await.unwrap_err();

        assert_eq!(
            error.to_string(),
            "MQTT offline status was not acknowledged"
        );
    }

    #[test]
    fn parser_rejects_missing_duplicate_and_empty_values_without_echoing_values() {
        for input in [
            "MQTT_USERNAME=alice\n",
            "MQTT_USERNAME=alice\nMQTT_USERNAME=bob\n",
            "MQTT_PASSWORD=\n",
        ] {
            let error = parse_environment_file(input)
                .and_then(|values| {
                    if values.contains_key("MQTT_USERNAME") && values.contains_key("MQTT_PASSWORD")
                    {
                        Ok(values)
                    } else {
                        Err(super::MqttError::credential(
                            "required credential variable is missing",
                        ))
                    }
                })
                .unwrap_err();
            let rendered = error.to_string();
            assert!(!rendered.contains("alice"));
            assert!(!rendered.contains("bob"));
        }
    }

    #[test]
    fn inbound_debug_never_renders_raw_mqtt_payload() {
        let message = super::OwnedInboundMessage {
            topic: "zigbee2mqtt/device".to_owned(),
            payload: b"raw-payload-sentinel".to_vec(),
            retain: true,
            duplicate: false,
            qos: crate::zigbee2mqtt::Qos::AtLeastOnce,
        };

        let message_debug = format!("{message:?}");
        let event_debug = format!("{:?}", super::TransportEvent::Publish(message));
        assert!(message_debug.contains("<redacted>"));
        assert!(event_debug.contains("<redacted>"));
        assert!(!message_debug.contains("114, 97, 119"));
        assert!(!event_debug.contains("114, 97, 119"));
    }

    #[test]
    fn loader_rejects_oversize_regular_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("mqtt.env");
        fs::write(&path, vec![b'x'; MAX_CREDENTIAL_FILE_BYTES as usize + 1]).unwrap();
        let source = MqttCredentialSource {
            environment_file: path,
            username_variable: "MQTT_USERNAME".to_owned(),
            password_variable: "MQTT_PASSWORD".to_owned(),
        };
        assert!(load_credentials(&source).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn loader_rejects_symlink_and_group_or_world_readable_credential_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let directory = tempdir().unwrap();
        let actual = directory.path().join("actual.env");
        let linked = directory.path().join("linked.env");
        fs::write(&actual, "MQTT_USERNAME=alice\nMQTT_PASSWORD=secret\n").unwrap();
        fs::set_permissions(&actual, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&actual, &linked).unwrap();
        let mut source = MqttCredentialSource {
            environment_file: linked,
            username_variable: "MQTT_USERNAME".to_owned(),
            password_variable: "MQTT_PASSWORD".to_owned(),
        };
        assert!(load_credentials(&source).is_err());

        fs::set_permissions(&actual, fs::Permissions::from_mode(0o644)).unwrap();
        source.environment_file = actual;
        assert!(load_credentials(&source).is_err());
    }

    #[test]
    fn nix_store_is_never_a_runtime_credential_source() {
        assert!(!path_is_outside_nix_store(Path::new(
            "/nix/store/example/mqtt.env"
        )));
        assert!(path_is_outside_nix_store(Path::new(
            "/run/credentials/mqtt.env"
        )));
    }
}
