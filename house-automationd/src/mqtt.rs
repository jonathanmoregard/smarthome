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
    fn activate_connection(&mut self) -> Result<bool, MqttError> {
        Ok(true)
    }
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
    mailbox: DriverMailbox,
    events: mpsc::Receiver<DriverEvent>,
    failure: watch::Receiver<Option<MqttError>>,
    pending_connection_generation: Option<u64>,
    driver: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct ConnectionState {
    next_generation: u64,
    broker_generation: Option<u64>,
    actor_generation: Option<u64>,
}

#[derive(Clone, Default)]
struct ConnectionFence(Arc<Mutex<ConnectionState>>);

impl ConnectionFence {
    fn connected(&self) -> Result<u64, MqttError> {
        let mut state = self.0.lock().expect("connection fence lock poisoned");
        if state.broker_generation.is_some() {
            return Err(MqttError::fatal("MQTT connection edge is invalid"));
        }
        let generation = state
            .next_generation
            .checked_add(1)
            .ok_or_else(|| MqttError::fatal("MQTT connection generation is invalid"))?;
        state.next_generation = generation;
        state.broker_generation = Some(generation);
        state.actor_generation = None;
        Ok(generation)
    }

    fn disconnected(&self) -> Result<u64, MqttError> {
        let mut state = self.0.lock().expect("connection fence lock poisoned");
        state.actor_generation = None;
        state
            .broker_generation
            .take()
            .ok_or_else(|| MqttError::fatal("MQTT connection edge is invalid"))
    }

    fn acknowledge(&self, generation: u64) -> Result<bool, MqttError> {
        if generation == 0 {
            return Err(MqttError::fatal("MQTT connection generation is invalid"));
        }
        let mut state = self.0.lock().expect("connection fence lock poisoned");
        if state.broker_generation != Some(generation) {
            return Ok(false);
        }
        state.actor_generation = Some(generation);
        Ok(true)
    }

    fn current(&self) -> Option<u64> {
        let state = self.0.lock().expect("connection fence lock poisoned");
        state
            .broker_generation
            .filter(|generation| state.actor_generation == Some(*generation))
    }
}

enum DriverEvent {
    Connected(u64),
    Disconnected,
    Publish(OwnedInboundMessage),
}

enum DriverCommand {
    Subscribe {
        generation: u64,
        topic: String,
        qos: Qos,
    },
    Publish {
        generation: u64,
        topic: String,
        payload: Vec<u8>,
        qos: Qos,
        retain: bool,
        ticket: DeliveryTicket,
    },
}

impl DriverCommand {
    fn subscribe(generation: u64, topic: &str, qos: Qos) -> Self {
        Self::Subscribe {
            generation,
            topic: topic.to_owned(),
            qos,
        }
    }

    fn publish(
        generation: u64,
        topic: &str,
        payload: &[u8],
        qos: Qos,
        retain: bool,
        ticket: DeliveryTicket,
    ) -> Self {
        Self::Publish {
            generation,
            topic: topic.to_owned(),
            payload: payload.to_vec(),
            qos,
            retain,
            ticket,
        }
    }

    fn is_current(&self, fence: &ConnectionFence) -> bool {
        let generation = match self {
            Self::Subscribe { generation, .. } | Self::Publish { generation, .. } => generation,
        };
        fence.current() == Some(*generation)
    }

    fn cancel_delivery(&self, delivery: &DeliveryTracker) {
        if let Self::Publish { ticket, .. } = self {
            delivery.cancel(*ticket);
        }
    }
}

struct ShutdownRequest {
    status_topic: String,
    completion: tokio::sync::oneshot::Sender<Result<(), MqttError>>,
}

impl ShutdownRequest {
    fn status_topic(&self) -> &str {
        &self.status_topic
    }

    fn complete(self, result: Result<(), MqttError>) {
        let _ = self.completion.send(result);
    }
}

#[derive(Clone)]
struct DriverMailbox {
    commands: mpsc::Sender<DriverCommand>,
    shutdown: mpsc::UnboundedSender<ShutdownRequest>,
    connection: ConnectionFence,
    delivery: DeliveryTracker,
}

struct DriverInbox {
    commands: mpsc::Receiver<DriverCommand>,
    shutdown: mpsc::UnboundedReceiver<ShutdownRequest>,
}

impl DriverMailbox {
    fn new(capacity: usize) -> (Self, DriverInbox) {
        let (commands, command_receiver) = mpsc::channel(capacity);
        let (shutdown, shutdown_receiver) = mpsc::unbounded_channel();
        let delivery = DeliveryTracker::default();
        (
            Self {
                commands,
                shutdown,
                connection: ConnectionFence::default(),
                delivery,
            },
            DriverInbox {
                commands: command_receiver,
                shutdown: shutdown_receiver,
            },
        )
    }

    fn connection(&self) -> &ConnectionFence {
        &self.connection
    }

    fn try_send(&self, command: DriverCommand) -> Result<(), MqttError> {
        self.commands
            .try_send(command)
            .map_err(|_| MqttError::transport("MQTT operation enqueue failed"))
    }

    fn request_shutdown(
        &self,
        status_topic: &str,
        completion: tokio::sync::oneshot::Sender<Result<(), MqttError>>,
    ) -> Result<(), MqttError> {
        self.shutdown
            .send(ShutdownRequest {
                status_topic: status_topic.to_owned(),
                completion,
            })
            .map_err(|_| MqttError::fatal("MQTT event loop stopped"))
    }
}

impl RumqttTransport {
    pub fn connect(
        settings: &MqttSettings,
        credentials: Option<&MqttCredentials>,
    ) -> Result<Self, MqttError> {
        let options = build_mqtt_options(settings, credentials);
        let (client, event_loop) = AsyncClient::new(options, 1);
        let (mailbox, inbox) = DriverMailbox::new(32);
        let (event_sender, events) = mpsc::channel(128);
        let (failure_sender, failure) = watch::channel(None);
        let delivery = mailbox.delivery.clone();
        let driver = tokio::spawn(run_event_loop(
            client,
            event_loop,
            inbox,
            mailbox.connection().clone(),
            event_sender,
            failure_sender,
            delivery.clone(),
        ));
        Ok(Self {
            mailbox,
            events,
            failure,
            pending_connection_generation: None,
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
        let generation = self
            .mailbox
            .connection()
            .current()
            .ok_or_else(|| MqttError::transport("MQTT connection is unavailable"))?;
        let ticket = self.mailbox.delivery.reserve(observe_delivery)?;
        if let Err(error) = self.mailbox.try_send(DriverCommand::publish(
            generation, topic, payload, qos, retain, ticket,
        )) {
            self.mailbox.delivery.cancel(ticket);
            return Err(error);
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
        let event = tokio::select! {
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
        }?;
        Ok(match event {
            DriverEvent::Connected(generation) => {
                self.pending_connection_generation = Some(generation);
                TransportEvent::Connected
            }
            DriverEvent::Disconnected => {
                self.pending_connection_generation = None;
                TransportEvent::Disconnected
            }
            DriverEvent::Publish(message) => TransportEvent::Publish(message),
        })
    }

    fn activate_connection(&mut self) -> Result<bool, MqttError> {
        let Some(generation) = self.pending_connection_generation.take() else {
            return Err(MqttError::fatal(
                "MQTT connection activation has no matching event",
            ));
        };
        self.mailbox.connection().acknowledge(generation)
    }

    async fn subscribe(&mut self, topic: &str, qos: Qos) -> Result<(), MqttError> {
        let generation = self
            .mailbox
            .connection()
            .current()
            .ok_or_else(|| MqttError::transport("MQTT connection is unavailable"))?;
        self.mailbox
            .try_send(DriverCommand::subscribe(generation, topic, qos))
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
        let (completion, completed) = tokio::sync::oneshot::channel();
        self.mailbox.request_shutdown(status_topic, completion)?;
        tokio::time::timeout(Duration::from_secs(6), completed)
            .await
            .map_err(|_| MqttError::transport("MQTT graceful shutdown timed out"))?
            .map_err(|_| MqttError::fatal("MQTT event loop stopped during shutdown"))??;
        if let Some(driver) = self.driver.take() {
            tokio::time::timeout(Duration::from_secs(1), driver)
                .await
                .map_err(|_| MqttError::transport("MQTT shutdown acknowledgement timed out"))?
                .map_err(|_| MqttError::transport("MQTT event loop task failed"))?;
        }
        Ok(())
    }
}

async fn run_event_loop(
    client: AsyncClient,
    mut event_loop: EventLoop,
    mut inbox: DriverInbox,
    connection: ConnectionFence,
    events: mpsc::Sender<DriverEvent>,
    failure: watch::Sender<Option<MqttError>>,
    delivery: DeliveryTracker,
) {
    let mut reconnect = ReconnectState::default();
    let mut pending_command: Option<DriverCommand> = None;
    let mut pending_event: Option<DriverEvent> = None;
    let mut poll_after = tokio::time::Instant::now();
    loop {
        if let Some(command) = pending_command.take() {
            if !command.is_current(&connection) {
                command.cancel_delivery(&delivery);
                continue;
            }
            if submit_driver_command(&client, &command).is_err() {
                pending_command = Some(command);
            }
        }
        let poll_ready = tokio::time::Instant::now() >= poll_after;

        tokio::select! {
            biased;
            request = inbox.shutdown.recv() => {
                let Some(request) = request else {
                    let _ = failure.send(Some(MqttError::fatal("MQTT shutdown control stopped")));
                    return;
                };
                let result = graceful_driver_shutdown(
                    &client,
                    &mut event_loop,
                    &mut inbox,
                    &connection,
                    pending_command.take(),
                    &delivery,
                    request.status_topic(),
                ).await;
                request.complete(result);
                return;
            }
            permit = events.reserve(), if pending_event.is_some() => {
                let permit = match permit {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = failure.send(Some(MqttError::fatal("MQTT actor event receiver stopped")));
                        return;
                    }
                };
                permit.send(pending_event.take().expect("event reserve requires a pending event"));
            }
            command = inbox.commands.recv(), if pending_command.is_none() => {
                let Some(command) = command else {
                    let _ = failure.send(Some(MqttError::fatal("MQTT operation sender stopped")));
                    return;
                };
                pending_command = Some(command);
            }
            () = tokio::time::sleep_until(poll_after), if pending_event.is_none() && !poll_ready => {}
            polled = event_loop.poll(), if pending_event.is_none() && poll_ready => {
                pending_event = match polled {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        let generation = match connection.connected() {
                            Ok(generation) => generation,
                            Err(error) => {
                                let _ = failure.send(Some(error));
                                return;
                            }
                        };
                        reconnect.connected();
                        Some(DriverEvent::Connected(generation))
                    }
                    Ok(Event::Incoming(Packet::Publish(publish))) => {
                        Some(DriverEvent::Publish(owned_publish(publish)))
                    }
                    Ok(Event::Incoming(Packet::PubAck(acknowledgement))) => {
                        delivery.puback(acknowledgement.pkid);
                        None
                    }
                    Ok(Event::Outgoing(rumqttc::Outgoing::Publish(packet_id))) => {
                        delivery.outgoing_publish(packet_id);
                        None
                    }
                    Ok(Event::Outgoing(rumqttc::Outgoing::Disconnect)) => return,
                    Ok(_) => None,
                    Err(_) => {
                        delivery.connection_lost();
                        let (disconnected, delay) = reconnect.poll_failed();
                        let event = if disconnected {
                            if let Err(error) = connection.disconnected() {
                                let _ = failure.send(Some(error));
                                return;
                            }
                            Some(DriverEvent::Disconnected)
                        } else {
                            None
                        };
                        poll_after = tokio::time::Instant::now() + delay;
                        event
                    }
                };
            }
        }
    }
}

fn submit_driver_command(client: &AsyncClient, command: &DriverCommand) -> Result<(), MqttError> {
    let result = match command {
        DriverCommand::Subscribe { topic, qos, .. } => {
            client.try_subscribe(topic, to_rumqtt_qos(*qos))
        }
        DriverCommand::Publish {
            topic,
            payload,
            qos,
            retain,
            ..
        } => client.try_publish(topic, to_rumqtt_qos(*qos), *retain, payload.clone()),
    };
    result.map_err(|_| MqttError::transport("MQTT driver queue is full"))
}

async fn graceful_driver_shutdown(
    client: &AsyncClient,
    event_loop: &mut EventLoop,
    inbox: &mut DriverInbox,
    connection: &ConnectionFence,
    pending_command: Option<DriverCommand>,
    delivery: &DeliveryTracker,
    status_topic: &str,
) -> Result<(), MqttError> {
    if connection.current().is_some() {
        connection.disconnected()?;
    }
    if let Some(command) = pending_command {
        command.cancel_delivery(delivery);
    }
    while let Ok(command) = inbox.commands.try_recv() {
        command.cancel_delivery(delivery);
    }

    tokio::time::timeout(Duration::from_secs(5), async {
        while !delivery.is_idle() {
            poll_shutdown_event(event_loop, delivery).await?;
        }

        let offline = loop {
            let ticket = delivery.reserve(true)?;
            match client.try_publish(status_topic, QoS::AtLeastOnce, true, b"offline".to_vec()) {
                Ok(()) => break ticket,
                Err(_) => {
                    delivery.cancel(ticket);
                    poll_shutdown_event(event_loop, delivery).await?;
                }
            }
        };
        while delivery.outcome(offline).is_none() {
            poll_shutdown_event(event_loop, delivery).await?;
        }
        if delivery.outcome(offline) != Some(DeliveryOutcome::Delivered) {
            return Err(MqttError::transport(
                "MQTT offline status was not acknowledged",
            ));
        }

        loop {
            if client.try_disconnect().is_ok() {
                break;
            }
            poll_shutdown_event(event_loop, delivery).await?;
        }
        loop {
            if poll_shutdown_event(event_loop, delivery).await? {
                break;
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| MqttError::transport("MQTT graceful shutdown timed out"))?
}

async fn poll_shutdown_event(
    event_loop: &mut EventLoop,
    delivery: &DeliveryTracker,
) -> Result<bool, MqttError> {
    match event_loop.poll().await {
        Ok(Event::Incoming(Packet::PubAck(acknowledgement))) => {
            delivery.puback(acknowledgement.pkid);
            Ok(false)
        }
        Ok(Event::Outgoing(rumqttc::Outgoing::Publish(packet_id))) => {
            delivery.outgoing_publish(packet_id);
            Ok(false)
        }
        Ok(Event::Outgoing(rumqttc::Outgoing::Disconnect)) => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => {
            delivery.connection_lost();
            Err(MqttError::transport(
                "MQTT connection was lost during graceful shutdown",
            ))
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

    fn poll_failed(&mut self) -> (bool, Duration) {
        let disconnected = std::mem::replace(&mut self.connected, false);
        let exponent = self.failures.min(7);
        let multiplier = 1_u32 << exponent;
        let delay = INITIAL_RECONNECT_BACKOFF
            .checked_mul(multiplier)
            .unwrap_or(MAX_RECONNECT_BACKOFF)
            .min(MAX_RECONNECT_BACKOFF);
        self.failures = self.failures.saturating_add(1);
        (disconnected, delay)
    }
}

#[cfg(test)]
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

    fn is_idle(&self) -> bool {
        self.state
            .lock()
            .expect("delivery tracker lock poisoned")
            .pending
            .is_empty()
    }

    #[cfg(test)]
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use crate::config::MqttCredentialSource;

    use super::{
        MAX_CREDENTIAL_FILE_BYTES, load_credentials, parse_environment_file,
        path_is_outside_nix_store,
    };

    async fn read_mqtt_packet(stream: &mut tokio::net::TcpStream) -> (u8, Vec<u8>) {
        let mut header = [0_u8; 1];
        stream.read_exact(&mut header).await.unwrap();
        let mut remaining = 0_usize;
        let mut multiplier = 1_usize;
        loop {
            let mut encoded = [0_u8; 1];
            stream.read_exact(&mut encoded).await.unwrap();
            remaining += usize::from(encoded[0] & 0x7f) * multiplier;
            if encoded[0] & 0x80 == 0 {
                break;
            }
            multiplier *= 128;
        }
        let mut body = vec![0; remaining];
        stream.read_exact(&mut body).await.unwrap();
        (header[0], body)
    }

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
        let mut reconnect = super::ReconnectState::default();
        reconnect.connected();
        let started = tokio::time::Instant::now();

        let first = reconnect.poll_failed();
        tokio::time::sleep(first.1).await;
        let second = reconnect.poll_failed();
        tokio::time::sleep(second.1).await;

        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_millis(750)
        );
        assert!(first.0);
        assert!(!second.0);
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
        let (mailbox, _inbox) = super::DriverMailbox::new(1);
        let generation = mailbox.connection().connected().unwrap();
        mailbox.connection().acknowledge(generation).unwrap();
        let (_event_sender, events) = tokio::sync::mpsc::channel(1);
        let (_failure_sender, failure) = tokio::sync::watch::channel(None);
        let transport = super::RumqttTransport {
            mailbox,
            events,
            failure,
            pending_connection_generation: None,
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

    #[tokio::test]
    async fn subscription_enqueue_never_waits_on_a_driver_blocked_by_inbound_backpressure() {
        let (mailbox, _inbox) = super::DriverMailbox::new(1);
        let generation = mailbox.connection().connected().unwrap();
        mailbox.connection().acknowledge(generation).unwrap();
        let (_event_sender, events) = tokio::sync::mpsc::channel(1);
        let (_failure_sender, failure) = tokio::sync::watch::channel(None);
        let mut transport = super::RumqttTransport {
            mailbox,
            events,
            failure,
            pending_connection_generation: None,
            driver: None,
        };
        super::MqttTransport::subscribe(
            &mut transport,
            "zigbee2mqtt/first",
            crate::zigbee2mqtt::Qos::AtLeastOnce,
        )
        .await
        .unwrap();

        let result = tokio::time::timeout(
            Duration::from_millis(10),
            super::MqttTransport::subscribe(
                &mut transport,
                "zigbee2mqtt/second",
                crate::zigbee2mqtt::Qos::AtLeastOnce,
            ),
        )
        .await
        .expect("a full outbound queue must fail without waiting");

        assert!(result.unwrap_err().is_transient());
    }

    #[test]
    fn command_queued_before_a_delayed_disconnect_marker_is_fenced_from_the_next_connection() {
        let fence = super::ConnectionFence::default();
        let generation = fence.connected().unwrap();
        fence.acknowledge(generation).unwrap();
        let command = super::DriverCommand::subscribe(
            generation,
            "zigbee2mqtt/device",
            crate::zigbee2mqtt::Qos::AtLeastOnce,
        );

        assert_eq!(fence.disconnected().unwrap(), generation);

        assert!(!command.is_current(&fence));
        let next_generation = fence.connected().unwrap();
        assert_ne!(next_generation, generation);
        assert_eq!(
            fence.current(),
            None,
            "a reconnect must remain fenced until its actor-visible marker is consumed"
        );
        assert!(!command.is_current(&fence));
        fence.acknowledge(next_generation).unwrap();
        assert_eq!(fence.current(), Some(next_generation));
    }

    #[tokio::test]
    async fn shutdown_control_bypasses_a_normal_queue_saturated_with_subscriptions() {
        let (sender, mut receiver) = super::DriverMailbox::new(1);
        let generation = sender.connection().connected().unwrap();
        sender.connection().acknowledge(generation).unwrap();
        sender
            .try_send(super::DriverCommand::subscribe(
                generation,
                "zigbee2mqtt/device",
                crate::zigbee2mqtt::Qos::AtLeastOnce,
            ))
            .unwrap();
        let (completion, completed) = tokio::sync::oneshot::channel();
        sender
            .request_shutdown("house/v1/status", completion)
            .unwrap();

        let shutdown = receiver.shutdown.recv().await.unwrap();
        assert_eq!(shutdown.status_topic(), "house/v1/status");
        shutdown.complete(Ok(()));
        completed.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn shutdown_delivers_offline_when_subscription_mailbox_is_full() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let broker = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (header, _) = read_mqtt_packet(&mut stream).await;
            assert_eq!(header >> 4, 1, "first MQTT packet must be CONNECT");
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let inbound = [0x30, 0x05, 0x00, 0x01, b'x', b'{', b'}'];
            for _ in 0..129 {
                stream.write_all(&inbound).await.unwrap();
            }

            let mut offline_delivered = false;
            loop {
                let (header, body) =
                    tokio::time::timeout(Duration::from_secs(5), read_mqtt_packet(&mut stream))
                        .await
                        .expect("client did not finish graceful shutdown");
                match header >> 4 {
                    3 => {
                        let topic_length = usize::from(u16::from_be_bytes([body[0], body[1]]));
                        let packet_id_offset = 2 + topic_length;
                        let packet_id = &body[packet_id_offset..packet_id_offset + 2];
                        let payload = &body[packet_id_offset + 2..];
                        offline_delivered = header & 0x01 == 0x01 && payload == b"offline";
                        stream
                            .write_all(&[0x40, 0x02, packet_id[0], packet_id[1]])
                            .await
                            .unwrap();
                    }
                    8 => {
                        let packet_id = &body[..2];
                        stream
                            .write_all(&[0x90, 0x03, packet_id[0], packet_id[1], 0x01])
                            .await
                            .unwrap();
                    }
                    14 => break,
                    packet_type => panic!("unexpected MQTT packet type {packet_type}"),
                }
            }
            offline_delivered
        });

        let mut settings =
            crate::config::ValidatedConfig::parse(include_str!("../../examples/house.toml"))
                .unwrap()
                .into_runtime_parts()
                .mqtt;
        settings.host = address.ip().to_string();
        settings.port = address.port();
        settings.client_id = "shutdown-saturation-test".to_owned();
        let mut transport = super::RumqttTransport::connect(&settings, None).unwrap();
        assert_eq!(
            super::MqttTransport::next_event(&mut transport)
                .await
                .unwrap(),
            super::TransportEvent::Connected
        );
        assert!(super::MqttTransport::activate_connection(&mut transport).unwrap());

        for index in 0..32 {
            super::MqttTransport::subscribe(
                &mut transport,
                &format!("zigbee2mqtt/saturated/{index}"),
                crate::zigbee2mqtt::Qos::AtLeastOnce,
            )
            .await
            .unwrap();
        }
        let full = super::MqttTransport::subscribe(
            &mut transport,
            "zigbee2mqtt/saturated/overflow",
            crate::zigbee2mqtt::Qos::AtLeastOnce,
        )
        .await
        .unwrap_err();
        assert!(full.is_transient());

        super::MqttTransport::shutdown(&mut transport, "house/v1/status")
            .await
            .unwrap();
        assert!(broker.await.unwrap());
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
