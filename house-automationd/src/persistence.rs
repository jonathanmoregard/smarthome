use std::{
    error::Error,
    fmt::{self, Display},
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::Duration,
};

use house_automation_core::state::{
    AutomationSnapshot, AutomationSnapshotParts, AutomationState, ControlSnapshot, LocalDate,
    Scope, ScopeSnapshot, StateError,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const CURRENT_SCHEMA_VERSION: i64 = 1;
const RECORD_FORMAT_VERSION: u32 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

// Migrations are immutable and forward-only after release. Initial creation is intentionally
// irreversible: downgrades restore a compatible database from backup.
const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial_state",
    sql: "
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE scope_state (
            scope_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE control_state (
            control_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL
        );
    ",
}];

#[derive(Debug)]
pub struct SqliteStateStore {
    connection: Connection,
    source_path: PathBuf,
}

impl SqliteStateStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, PersistenceError> {
        let path = path.as_ref();
        let connection = Connection::open(path)
            .map_err(|source| PersistenceError::sql("open state database", source))?;
        Self::finish_open(path, connection)
    }

    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, PersistenceError> {
        let path = path.as_ref();
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|source| PersistenceError::sql("open existing state database", source))?;
        Self::finish_open(path, connection)
    }

    fn finish_open(path: &Path, mut connection: Connection) -> Result<Self, PersistenceError> {
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        Ok(Self {
            connection,
            source_path: path.to_path_buf(),
        })
    }

    pub fn schema_version(&self) -> Result<i64, PersistenceError> {
        self.connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(|source| PersistenceError::sql("read schema version", source))?
            .ok_or_else(|| PersistenceError::MigrationHistory("history is empty".to_owned()))
    }

    pub fn save(&self, state: &AutomationState) -> Result<(), PersistenceError> {
        let parts = state.snapshot().into_parts();
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|source| PersistenceError::sql("begin state save", source))?;
        transaction
            .execute("DELETE FROM control_state", [])
            .map_err(|source| PersistenceError::sql("clear control state", source))?;
        transaction
            .execute("DELETE FROM scope_state", [])
            .map_err(|source| PersistenceError::sql("clear scope state", source))?;
        transaction
            .execute("DELETE FROM metadata", [])
            .map_err(|source| PersistenceError::sql("clear state metadata", source))?;

        for scope in &parts.scopes {
            let payload = encode_record("scope", scope)?;
            transaction
                .execute(
                    "INSERT INTO scope_state(scope_key, payload_json) VALUES (?1, ?2)",
                    params![scope_key(scope.scope()), payload],
                )
                .map_err(|source| PersistenceError::sql("write scope state", source))?;
        }
        for control in &parts.controls {
            let payload = encode_record("control", control)?;
            transaction
                .execute(
                    "INSERT INTO control_state(control_id, payload_json) VALUES (?1, ?2)",
                    params![control.id().as_str(), payload],
                )
                .map_err(|source| PersistenceError::sql("write control state", source))?;
        }
        let metadata = MetadataRecord {
            last_reset_date: parts.last_reset_date,
        };
        let payload = encode_record("metadata", &metadata)?;
        transaction
            .execute(
                "INSERT INTO metadata(key, payload_json) VALUES ('automation', ?1)",
                [payload],
            )
            .map_err(|source| PersistenceError::sql("write state metadata", source))?;
        transaction
            .commit()
            .map_err(|source| PersistenceError::sql("commit state save", source))
    }

    pub fn load(&self) -> Result<AutomationState, PersistenceError> {
        let scopes = load_scopes(&self.connection)?;
        let controls = load_controls(&self.connection)?;
        let metadata_payload = self
            .connection
            .query_row(
                "SELECT payload_json FROM metadata WHERE key = 'automation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|source| PersistenceError::sql("read state metadata", source))?;

        let Some(metadata_payload) = metadata_payload else {
            if scopes.is_empty() && controls.is_empty() {
                return Ok(AutomationState::default());
            }
            return Err(PersistenceError::CorruptRecord(
                "state metadata is missing".to_owned(),
            ));
        };
        let metadata: MetadataRecord = decode_record("metadata", &metadata_payload)?;
        let snapshot = AutomationSnapshot::from_parts(AutomationSnapshotParts {
            scopes,
            controls,
            last_reset_date: metadata.last_reset_date,
        });
        AutomationState::restore(snapshot).map_err(PersistenceError::Restore)
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<(), PersistenceError> {
        let destination = destination.as_ref();
        if destination == self.source_path {
            return Err(PersistenceError::BackupDestinationExists);
        }
        let reservation = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|source| match source.kind() {
                io::ErrorKind::AlreadyExists => PersistenceError::BackupDestinationExists,
                _ => PersistenceError::Io {
                    operation: "reserve backup destination",
                    source,
                },
            })?;

        let result = (|| {
            let mut destination_connection = Connection::open(destination)
                .map_err(|source| PersistenceError::sql("open backup destination", source))?;
            let backup =
                rusqlite::backup::Backup::new(&self.connection, &mut destination_connection)
                    .map_err(|source| PersistenceError::sql("start online backup", source))?;
            backup
                .run_to_completion(32, Duration::from_millis(10), None)
                .map_err(|source| PersistenceError::sql("run online backup", source))?;
            drop(backup);
            let check: String = destination_connection
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .map_err(|source| PersistenceError::sql("verify online backup", source))?;
            if check != "ok" {
                return Err(PersistenceError::CorruptRecord(
                    "online backup integrity check failed".to_owned(),
                ));
            }
            Ok(())
        })();
        drop(reservation);
        if result.is_err() {
            let _ = fs::remove_file(destination);
        }
        result
    }
}

fn configure_connection(connection: &Connection) -> Result<(), PersistenceError> {
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|source| PersistenceError::sql("configure database busy timeout", source))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|source| PersistenceError::sql("enable foreign keys", source))?;
    let journal_mode: String = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(|source| PersistenceError::sql("enable WAL journal mode", source))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(PersistenceError::CorruptRecord(
            "SQLite did not enable WAL journal mode".to_owned(),
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|source| PersistenceError::sql("configure database durability", source))
}

fn migrate(connection: &mut Connection) -> Result<(), PersistenceError> {
    let has_history = table_exists(connection, "schema_migrations")?;
    if !has_history {
        let user_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .map_err(|source| PersistenceError::sql("inspect starting schema", source))?;
        if user_table_count != 0 {
            return Err(PersistenceError::MigrationHistory(
                "nonempty unversioned database is unsupported".to_owned(),
            ));
        }
        return apply_migration(connection, &MIGRATIONS[0]);
    }

    let applied = {
        let mut statement = connection
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .map_err(|source| PersistenceError::sql("read migration history", source))?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|source| PersistenceError::sql("read migration history", source))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|source| PersistenceError::sql("read migration history", source))?
    };
    if applied.is_empty() || applied.len() > MIGRATIONS.len() {
        return Err(PersistenceError::MigrationHistory(
            "migration history is not a known prefix".to_owned(),
        ));
    }
    for (index, (version, name)) in applied.iter().enumerate() {
        let expected = &MIGRATIONS[index];
        if *version != expected.version || name != expected.name {
            return Err(PersistenceError::MigrationHistory(format!(
                "migration history diverges at position {}",
                index + 1
            )));
        }
    }
    for migration in &MIGRATIONS[applied.len()..] {
        apply_migration(connection, migration)?;
    }
    Ok(())
}

fn apply_migration(
    connection: &mut Connection,
    migration: &Migration,
) -> Result<(), PersistenceError> {
    let transaction = connection
        .transaction()
        .map_err(|source| PersistenceError::sql("begin migration", source))?;
    transaction
        .execute_batch(migration.sql)
        .map_err(|source| PersistenceError::MigrationSql {
            name: migration.name,
            source,
        })?;
    transaction
        .execute(
            "INSERT INTO schema_migrations(version, name) VALUES (?1, ?2)",
            params![migration.version, migration.name],
        )
        .map_err(|source| PersistenceError::MigrationSql {
            name: migration.name,
            source,
        })?;
    transaction
        .commit()
        .map_err(|source| PersistenceError::MigrationSql {
            name: migration.name,
            source,
        })
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, PersistenceError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(|source| PersistenceError::sql("inspect migration history", source))
}

fn load_scopes(connection: &Connection) -> Result<Vec<ScopeSnapshot>, PersistenceError> {
    let mut statement = connection
        .prepare("SELECT scope_key, payload_json FROM scope_state ORDER BY scope_key")
        .map_err(|source| PersistenceError::sql("read scope state", source))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|source| PersistenceError::sql("read scope state", source))?;
    let mut scopes = Vec::new();
    for row in rows {
        let (stored_key, payload) =
            row.map_err(|source| PersistenceError::sql("read scope state", source))?;
        let scope: ScopeSnapshot = decode_record("scope", &payload)?;
        if stored_key != scope_key(scope.scope()) {
            return Err(PersistenceError::CorruptRecord(
                "scope record key does not match payload".to_owned(),
            ));
        }
        scopes.push(scope);
    }
    Ok(scopes)
}

fn load_controls(connection: &Connection) -> Result<Vec<ControlSnapshot>, PersistenceError> {
    let mut statement = connection
        .prepare("SELECT control_id, payload_json FROM control_state ORDER BY control_id")
        .map_err(|source| PersistenceError::sql("read control state", source))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|source| PersistenceError::sql("read control state", source))?;
    let mut controls = Vec::new();
    for row in rows {
        let (stored_id, payload) =
            row.map_err(|source| PersistenceError::sql("read control state", source))?;
        let control: ControlSnapshot = decode_record("control", &payload)?;
        if stored_id != control.id().as_str() {
            return Err(PersistenceError::CorruptRecord(
                "control record key does not match payload".to_owned(),
            ));
        }
        controls.push(control);
    }
    Ok(controls)
}

fn scope_key(scope: &Scope) -> String {
    match scope {
        Scope::Room(id) => format!("room:{}", id.as_str()),
        Scope::Floor(id) => format!("floor:{}", id.as_str()),
        Scope::House => "house".to_owned(),
    }
}

#[derive(Serialize)]
struct RecordEnvelopeRef<'a, T> {
    format_version: u32,
    data: &'a T,
}

#[derive(Deserialize)]
struct RecordEnvelope<T> {
    format_version: u32,
    data: T,
}

#[derive(Deserialize)]
struct RecordHeader {
    format_version: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct MetadataRecord {
    last_reset_date: Option<LocalDate>,
}

fn encode_record<T: Serialize>(kind: &'static str, data: &T) -> Result<String, PersistenceError> {
    serde_json::to_string(&RecordEnvelopeRef {
        format_version: RECORD_FORMAT_VERSION,
        data,
    })
    .map_err(|source| PersistenceError::Json { kind, source })
}

fn decode_record<T: DeserializeOwned>(
    kind: &'static str,
    payload: &str,
) -> Result<T, PersistenceError> {
    let header: RecordHeader =
        serde_json::from_str(payload).map_err(|source| PersistenceError::Json { kind, source })?;
    if header.format_version != RECORD_FORMAT_VERSION {
        return Err(PersistenceError::UnsupportedRecordFormat {
            kind,
            version: header.format_version,
        });
    }
    let envelope: RecordEnvelope<T> =
        serde_json::from_str(payload).map_err(|source| PersistenceError::Json { kind, source })?;
    debug_assert_eq!(envelope.format_version, RECORD_FORMAT_VERSION);
    Ok(envelope.data)
}

#[derive(Debug)]
pub enum PersistenceError {
    Sql {
        operation: &'static str,
        source: rusqlite::Error,
    },
    MigrationSql {
        name: &'static str,
        source: rusqlite::Error,
    },
    MigrationHistory(String),
    Json {
        kind: &'static str,
        source: serde_json::Error,
    },
    UnsupportedRecordFormat {
        kind: &'static str,
        version: u32,
    },
    CorruptRecord(String),
    Restore(StateError),
    BackupDestinationExists,
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl PersistenceError {
    fn sql(operation: &'static str, source: rusqlite::Error) -> Self {
        Self::Sql { operation, source }
    }
}

impl Display for PersistenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql { operation, source } => write!(formatter, "{operation}: {source}"),
            Self::MigrationSql { name, source } => {
                write!(formatter, "apply migration {name}: {source}")
            }
            Self::MigrationHistory(detail) => {
                write!(formatter, "invalid migration history: {detail}")
            }
            Self::Json { kind, source } => write!(formatter, "decode {kind} record: {source}"),
            Self::UnsupportedRecordFormat { kind, version } => {
                write!(formatter, "unsupported {kind} record format {version}")
            }
            Self::CorruptRecord(detail) => write!(formatter, "corrupt persisted state: {detail}"),
            Self::Restore(source) => write!(formatter, "restore automation state: {source}"),
            Self::BackupDestinationExists => {
                formatter.write_str("backup destination already exists")
            }
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
        }
    }
}

impl Error for PersistenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sql { source, .. } | Self::MigrationSql { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
            Self::Restore(source) => Some(source),
            Self::Io { source, .. } => Some(source),
            Self::MigrationHistory(_)
            | Self::UnsupportedRecordFormat { .. }
            | Self::CorruptRecord(_)
            | Self::BackupDestinationExists => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{Migration, apply_migration};

    #[test]
    fn failed_migration_rolls_back_ddl_and_history_record() {
        let mut connection = Connection::open_in_memory().unwrap();
        let broken = Migration {
            version: 1,
            name: "broken",
            sql: "
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL
                );
                CREATE TABLE partial_write(value TEXT);
                THIS IS NOT SQL;
            ",
        };

        assert!(apply_migration(&mut connection, &broken).is_err());

        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema \
                 WHERE type = 'table' AND name IN ('schema_migrations', 'partial_write')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
    }
}
