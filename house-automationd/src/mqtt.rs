use std::{collections::BTreeMap, error::Error, fmt, fs, path::Path, time::Duration};

use async_trait::async_trait;
use rumqttc::{AsyncClient, Event, EventLoop, LastWill, MqttOptions, Packet, Publish, QoS};
use tokio::{
    sync::{mpsc, watch},
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
    let canonical = fs::canonicalize(&source.environment_file)
        .map_err(|_| MqttError::credential("cannot resolve credential file"))?;
    if !canonical.is_absolute() || canonical.starts_with("/nix/store") {
        return Err(MqttError::credential(
            "credential file must resolve outside the Nix store",
        ));
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|_| MqttError::credential("cannot inspect credential file"))?;
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(MqttError::credential(
            "credential file must be a bounded regular file",
        ));
    }
    let bytes =
        fs::read(&canonical).map_err(|_| MqttError::credential("cannot read credential file"))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| MqttError::credential("credential file must be UTF-8"))?;
    let values = parse_environment_file(text)?;
    let username = required_credential(&values, &source.username_variable)?;
    let password = required_credential(&values, &source.password_variable)?;
    Ok(MqttCredentials { username, password })
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedInboundMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
    pub duplicate: bool,
    pub qos: Qos,
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
    delivery: watch::Receiver<DeliveryProgress>,
    driver: Option<JoinHandle<()>>,
}

impl RumqttTransport {
    pub fn connect(
        settings: &MqttSettings,
        credentials: Option<&MqttCredentials>,
    ) -> Result<Self, MqttError> {
        let status_topic = status_topic(&settings.application_namespace);
        let mut options = MqttOptions::new(&settings.client_id, &settings.host, settings.port);
        options.set_keep_alive(Duration::from_secs(30));
        options.set_clean_session(false);
        options.set_last_will(LastWill::new(
            status_topic,
            b"offline".to_vec(),
            QoS::AtLeastOnce,
            true,
        ));
        if let Some(credentials) = credentials {
            options.set_credentials(credentials.username(), credentials.password());
        }
        let (client, event_loop) = AsyncClient::new(options, 32);
        let (event_sender, events) = mpsc::channel(128);
        let (failure_sender, failure) = watch::channel(None);
        let (delivery_sender, delivery) = watch::channel(DeliveryProgress::default());
        let driver = tokio::spawn(run_event_loop(
            event_loop,
            event_sender,
            failure_sender,
            delivery_sender,
        ));
        Ok(Self {
            client,
            events,
            failure,
            delivery,
            driver: Some(driver),
        })
    }
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
        self.client
            .publish(topic, to_rumqtt_qos(qos), retain, payload)
            .await
            .map_err(|_| MqttError::transport("MQTT publication enqueue failed"))
    }

    async fn shutdown(&mut self, status_topic: &str) -> Result<(), MqttError> {
        wait_for_delivery(&mut self.delivery, |progress| {
            progress.acknowledged >= progress.published
        })
        .await?;
        let published_before = self.delivery.borrow().published;
        self.publish(status_topic, b"offline", Qos::AtLeastOnce, true)
            .await?;
        wait_for_delivery(&mut self.delivery, |progress| {
            progress.published > published_before && progress.acknowledged >= progress.published
        })
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
    delivery: watch::Sender<DeliveryProgress>,
) {
    let mut progress = DeliveryProgress::default();
    loop {
        let event = match event_loop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => Some(TransportEvent::Connected),
            Ok(Event::Incoming(Packet::Publish(publish))) => {
                Some(TransportEvent::Publish(owned_publish(publish)))
            }
            Ok(Event::Incoming(Packet::PubAck(_))) => {
                progress.acknowledged = progress.acknowledged.saturating_add(1);
                delivery.send_replace(progress);
                None
            }
            Ok(Event::Outgoing(rumqttc::Outgoing::Publish(_))) => {
                progress.published = progress.published.saturating_add(1);
                delivery.send_replace(progress);
                None
            }
            Ok(Event::Outgoing(rumqttc::Outgoing::Disconnect)) => break,
            Ok(_) => None,
            Err(_) => Some(TransportEvent::Disconnected),
        };
        if let Some(event) = event
            && events.try_send(event).is_err()
        {
            let _ = failure.send(Some(MqttError::fatal(
                "MQTT inbound event queue is unavailable or full",
            )));
            break;
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DeliveryProgress {
    published: u64,
    acknowledged: u64,
}

async fn wait_for_delivery(
    delivery: &mut watch::Receiver<DeliveryProgress>,
    ready: impl Fn(DeliveryProgress) -> bool,
) -> Result<(), MqttError> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if ready(*delivery.borrow()) {
                return Ok(());
            }
            delivery
                .changed()
                .await
                .map_err(|_| MqttError::fatal("MQTT delivery tracker stopped"))?;
        }
    })
    .await
    .map_err(|_| MqttError::transport("MQTT delivery acknowledgement timed out"))?
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
    use std::{fs, path::Path};

    use tempfile::tempdir;

    use crate::config::MqttCredentialSource;

    use super::{
        MAX_CREDENTIAL_FILE_BYTES, load_credentials, parse_environment_file,
        path_is_outside_nix_store,
    };

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
