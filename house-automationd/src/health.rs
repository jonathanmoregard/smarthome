use std::{
    net::SocketAddr,
    sync::{Arc, RwLock},
};

use axum::{Json, Router, http::StatusCode, routing::get};
use serde::Serialize;
use tokio::net::TcpListener;

use house_automation_core::value::LightTarget;

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryStatus {
    #[default]
    Disabled,
    Pending,
    Synced,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceSource {
    Static,
    Discovered,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct TargetReport {
    pub on: bool,
    pub brightness_percent: Option<u8>,
    pub color_temperature_kelvin: Option<u32>,
}

impl TargetReport {
    pub fn from_target(target: &LightTarget) -> Self {
        Self {
            on: target.on,
            brightness_percent: target
                .brightness
                .map(|brightness| (brightness.get() * 100.0).round() as u8),
            color_temperature_kelvin: target
                .color_temperature
                .map(|kelvin| kelvin.get().round() as u32),
        }
    }
}

/// One device as the daemon sees it. Served on `/devices` only, so
/// `/healthz` never carries topology.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeviceReport {
    pub id: String,
    pub friendly_name: String,
    pub source: DeviceSource,
    pub vendor: Option<String>,
    pub model: Option<String>,
    pub floor: Option<String>,
    pub room: Option<String>,
    pub owner: Option<String>,
    pub controlled: bool,
    pub reason: Option<&'static str>,
    pub note: Option<&'static str>,
    pub target: Option<TargetReport>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HealthSnapshot {
    ready: bool,
    database_migrated: bool,
    mqtt_connected: bool,
    zigbee2mqtt_bridge_online: bool,
    adapter_available: bool,
    last_successful_reconciliation_unix_seconds: Option<i64>,
    discovery: DiscoveryStatus,
}

impl HealthSnapshot {
    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn status_code(&self) -> u16 {
        if self.ready { 200 } else { 503 }
    }

    pub fn discovery(&self) -> DiscoveryStatus {
        self.discovery
    }
}

#[derive(Debug, Default)]
struct HealthValues {
    database_migrated: bool,
    mqtt_connected: bool,
    bridge_online: bool,
    last_successful_reconciliation_unix_seconds: Option<i64>,
    discovery: DiscoveryStatus,
    devices: Vec<DeviceReport>,
}

#[derive(Debug, Default)]
pub struct HealthState {
    values: RwLock<HealthValues>,
}

impl HealthState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_database_migrated(&self, value: bool) {
        self.values
            .write()
            .expect("health lock poisoned")
            .database_migrated = value;
    }

    pub fn set_mqtt_connected(&self, value: bool) {
        self.values
            .write()
            .expect("health lock poisoned")
            .mqtt_connected = value;
    }

    pub fn set_bridge_online(&self, value: bool) {
        self.values
            .write()
            .expect("health lock poisoned")
            .bridge_online = value;
    }

    pub fn record_reconciliation(&self, unix_seconds: i64) {
        self.values
            .write()
            .expect("health lock poisoned")
            .last_successful_reconciliation_unix_seconds = Some(unix_seconds);
    }

    pub fn set_discovery(&self, status: DiscoveryStatus, devices: Vec<DeviceReport>) {
        let mut values = self.values.write().expect("health lock poisoned");
        values.discovery = status;
        values.devices = devices;
    }

    pub fn devices(&self) -> Vec<DeviceReport> {
        self.values
            .read()
            .expect("health lock poisoned")
            .devices
            .clone()
    }

    pub fn snapshot(&self) -> HealthSnapshot {
        let values = self.values.read().expect("health lock poisoned");
        let ready = values.database_migrated && values.mqtt_connected && values.bridge_online;
        HealthSnapshot {
            ready,
            database_migrated: values.database_migrated,
            mqtt_connected: values.mqtt_connected,
            zigbee2mqtt_bridge_online: values.bridge_online,
            adapter_available: values.bridge_online,
            last_successful_reconciliation_unix_seconds: values
                .last_successful_reconciliation_unix_seconds,
            discovery: values.discovery,
        }
    }
}

pub async fn serve(
    listener: TcpListener,
    state: Arc<HealthState>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/devices", get(devices))
        .with_state(state);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
}

pub async fn bind(address: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(address).await
}

async fn healthz(
    axum::extract::State(state): axum::extract::State<Arc<HealthState>>,
) -> (StatusCode, Json<HealthSnapshot>) {
    let snapshot = state.snapshot();
    let status = if snapshot.ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(snapshot))
}

async fn devices(
    axum::extract::State(state): axum::extract::State<Arc<HealthState>>,
) -> Json<Vec<DeviceReport>> {
    Json(state.devices())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        sync::Arc,
    };

    use super::{DeviceReport, DeviceSource, DiscoveryStatus, HealthState, TargetReport, serve};

    #[test]
    fn readiness_requires_every_runtime_dependency() {
        let health = HealthState::new();
        health.set_database_migrated(true);
        health.set_mqtt_connected(true);
        assert!(!health.snapshot().ready());
        health.set_bridge_online(true);
        assert!(health.snapshot().ready());
        health.set_mqtt_connected(false);
        assert!(!health.snapshot().ready());
    }

    #[tokio::test]
    async fn endpoint_tracks_not_ready_ready_not_ready() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(HealthState::new());
        let (shutdown, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(serve(listener, state.clone(), async {
            let _ = receiver.await;
        }));

        assert!(request(address).await.starts_with("HTTP/1.1 503"));
        state.set_database_migrated(true);
        state.set_mqtt_connected(true);
        state.set_bridge_online(true);
        assert!(request(address).await.starts_with("HTTP/1.1 200"));
        state.set_mqtt_connected(false);
        assert!(request(address).await.starts_with("HTTP/1.1 503"));

        let _ = shutdown.send(());
        task.await.unwrap().unwrap();
    }

    async fn request(address: std::net::SocketAddr) -> String {
        request_path(address, "/healthz").await
    }

    async fn request_path(address: std::net::SocketAddr, path: &'static str) -> String {
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            write!(
                stream,
                "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn device_names_are_served_only_on_the_devices_route() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(HealthState::new());
        state.set_discovery(
            DiscoveryStatus::Synced,
            vec![DeviceReport {
                id: "0x7cc6b6fffe3cef1c".to_owned(),
                friendly_name: "upper-floor/upper-hallway/lamp".to_owned(),
                source: DeviceSource::Discovered,
                vendor: Some("IKEA".to_owned()),
                model: Some("LED2111G6".to_owned()),
                floor: Some("upper-floor".to_owned()),
                room: Some("upper-hallway".to_owned()),
                owner: Some("room upper-hallway".to_owned()),
                controlled: true,
                reason: None,
                note: None,
                target: Some(TargetReport {
                    on: true,
                    brightness_percent: Some(62),
                    color_temperature_kelvin: Some(2900),
                }),
            }],
        );
        let (shutdown, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(serve(listener, state.clone(), async {
            let _ = receiver.await;
        }));

        let health = request_path(address, "/healthz").await;
        assert!(health.contains("\"discovery\":\"synced\""), "{health}");
        assert!(!health.contains("upper-hallway"), "{health}");
        let devices = request_path(address, "/devices").await;
        assert!(devices.starts_with("HTTP/1.1 200"), "{devices}");
        assert!(
            devices.contains("\"friendly_name\":\"upper-floor/upper-hallway/lamp\""),
            "{devices}"
        );

        let _ = shutdown.send(());
        task.await.unwrap().unwrap();
    }
}
