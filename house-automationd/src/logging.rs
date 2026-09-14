use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// Installs newline-delimited JSON logs suitable for journald ingestion.
///
/// Call sites log normalized identifiers and outcomes only. MQTT payloads,
/// credential paths, usernames, and passwords are never fields.
pub fn init() -> Result<(), tracing_subscriber::util::TryInitError> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .json()
                .with_target(false)
                .with_current_span(false),
        )
        .try_init()
}
