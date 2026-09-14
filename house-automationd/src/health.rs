use std::{
    net::SocketAddr,
    sync::{Arc, RwLock},
};

use axum::{Json, Router, http::StatusCode, routing::get};
use serde::Serialize;
use tokio::net::TcpListener;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HealthSnapshot {
    ready: bool,
    database_migrated: bool,
    mqtt_connected: bool,
    zigbee2mqtt_bridge_online: bool,
    adapter_available: bool,
    last_successful_reconciliation_unix_seconds: Option<i64>,
}

impl HealthSnapshot {
    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn status_code(&self) -> u16 {
        if self.ready { 200 } else { 503 }
    }
}

#[derive(Debug, Default)]
struct HealthValues {
    database_migrated: bool,
    mqtt_connected: bool,
    bridge_online: bool,
    last_successful_reconciliation_unix_seconds: Option<i64>,
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

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        sync::Arc,
    };

    use super::{HealthState, serve};

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
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            stream
                .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap()
    }
}
