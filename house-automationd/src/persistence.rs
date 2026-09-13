use std::{
    error::Error,
    fmt::{self, Display},
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use house_automation_core::state::{
    AutomationSnapshot, AutomationSnapshotParts, AutomationState, ControlSnapshot, LocalDate,
    Scope, ScopeSnapshot, StateError,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tempfile::NamedTempFile;

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
        Self::open_path(path.as_ref(), true)
    }

    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, PersistenceError> {
        Self::open_path(path.as_ref(), false)
    }

    fn open_path(path: &Path, create: bool) -> Result<Self, PersistenceError> {
        reject_sqlite_pseudo_path(path)?;
        let (canonical_path, created, reservation) = prepare_database_path(path, create)?;
        let result = Connection::open_with_flags(
            &canonical_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|source| PersistenceError::sql("open state database", source))
        .and_then(|connection| Self::finish_open(&canonical_path, connection));
        drop(reservation);
        if result.is_err() && created {
            let _ = fs::remove_file(&canonical_path);
        }
        result
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
        self.load_with_interleave(|| {})
    }

    fn load_with_interleave(
        &self,
        after_scopes: impl FnOnce(),
    ) -> Result<AutomationState, PersistenceError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|source| PersistenceError::sql("begin state load", source))?;
        let scopes = load_scopes(&transaction)?;
        after_scopes();
        let controls = load_controls(&transaction)?;
        let metadata_payload = transaction
            .query_row(
                "SELECT payload_json FROM metadata WHERE key = 'automation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|source| PersistenceError::sql("read state metadata", source))?;

        let state = if let Some(metadata_payload) = metadata_payload {
            let metadata: MetadataRecord = decode_record("metadata", &metadata_payload)?;
            let snapshot = AutomationSnapshot::from_parts(AutomationSnapshotParts {
                scopes,
                controls,
                last_reset_date: metadata.last_reset_date,
            });
            AutomationState::restore(snapshot).map_err(PersistenceError::Restore)?
        } else {
            if scopes.is_empty() && controls.is_empty() {
                AutomationState::default()
            } else {
                return Err(PersistenceError::CorruptRecord(
                    "state metadata is missing".to_owned(),
                ));
            }
        };
        transaction
            .commit()
            .map_err(|source| PersistenceError::sql("commit state load", source))?;
        Ok(state)
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<(), PersistenceError> {
        let destination = destination.as_ref();
        reject_sqlite_pseudo_path(destination)?;
        let destination_parent = existing_parent(destination)?;
        let file_name = destination
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or(PersistenceError::InvalidFilesystemPath)?;
        let destination = destination_parent.join(file_name);
        if destination == self.source_path {
            return Err(PersistenceError::BackupDestinationExists);
        }

        let temporary =
            NamedTempFile::new_in(&destination_parent).map_err(|source| PersistenceError::Io {
                operation: "create temporary backup",
                source,
            })?;
        set_owner_only(temporary.as_file())?;
        {
            let mut destination_connection = Connection::open_with_flags(
                temporary.path(),
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
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
        }
        temporary
            .as_file()
            .sync_all()
            .map_err(|source| PersistenceError::Io {
                operation: "sync online backup",
                source,
            })?;
        temporary
            .persist_noclobber(destination)
            .map(|_| ())
            .map_err(|error| match error.error.kind() {
                io::ErrorKind::AlreadyExists => PersistenceError::BackupDestinationExists,
                _ => PersistenceError::Io {
                    operation: "publish online backup",
                    source: error.error,
                },
            })
    }
}

fn reject_sqlite_pseudo_path(path: &Path) -> Result<(), PersistenceError> {
    if path == Path::new(":memory:")
        || path
            .as_os_str()
            .to_str()
            .is_some_and(|value| value.starts_with("file:"))
    {
        return Err(PersistenceError::InvalidFilesystemPath);
    }
    Ok(())
}

fn prepare_database_path(
    path: &Path,
    create: bool,
) -> Result<(PathBuf, bool, Option<File>), PersistenceError> {
    match fs::canonicalize(path) {
        Ok(canonical_path) => {
            ensure_regular_file(&canonical_path)?;
            Ok((canonical_path, false, None))
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound && create => {
            let parent = existing_parent(path)?;
            let file_name = path
                .file_name()
                .filter(|name| !name.is_empty())
                .ok_or(PersistenceError::InvalidFilesystemPath)?;
            let canonical_path = parent.join(file_name);
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let reservation =
                options
                    .open(&canonical_path)
                    .map_err(|source| PersistenceError::Io {
                        operation: "create state database",
                        source,
                    })?;
            set_owner_only(&reservation)?;
            Ok((canonical_path, true, Some(reservation)))
        }
        Err(source) => Err(PersistenceError::Io {
            operation: "resolve state database",
            source,
        }),
    }
}

fn existing_parent(path: &Path) -> Result<PathBuf, PersistenceError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    fs::canonicalize(parent.unwrap_or_else(|| Path::new("."))).map_err(|source| {
        PersistenceError::Io {
            operation: "resolve database parent directory",
            source,
        }
    })
}

fn ensure_regular_file(path: &Path) -> Result<(), PersistenceError> {
    let metadata = fs::metadata(path).map_err(|source| PersistenceError::Io {
        operation: "inspect state database",
        source,
    })?;
    if !metadata.is_file() {
        return Err(PersistenceError::InvalidFilesystemPath);
    }
    Ok(())
}

fn set_owner_only(file: &File) -> Result<(), PersistenceError> {
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|source| PersistenceError::Io {
            operation: "protect database file permissions",
            source,
        })?;
    Ok(())
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
    migrate_sequence(connection, MIGRATIONS)?;
    verify_physical_schema(connection)
}

fn migrate_sequence(
    connection: &mut Connection,
    migrations: &[Migration],
) -> Result<(), PersistenceError> {
    if migrations.is_empty() {
        return Err(PersistenceError::MigrationHistory(
            "known migration sequence is empty".to_owned(),
        ));
    }
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
        for migration in migrations {
            apply_migration(connection, migration)?;
        }
        return Ok(());
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
    if applied.is_empty() || applied.len() > migrations.len() {
        return Err(PersistenceError::MigrationHistory(
            "migration history is not a known prefix".to_owned(),
        ));
    }
    for (index, (version, name)) in applied.iter().enumerate() {
        let expected = &migrations[index];
        if *version != expected.version || name != expected.name {
            return Err(PersistenceError::MigrationHistory(format!(
                "migration history diverges at position {}",
                index + 1
            )));
        }
    }
    for migration in &migrations[applied.len()..] {
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

#[derive(Debug, PartialEq, Eq)]
struct PhysicalColumn {
    name: String,
    declared_type: String,
    not_null: bool,
    primary_key_position: i64,
}

fn verify_physical_schema(connection: &Connection) -> Result<(), PersistenceError> {
    let expected = [
        (
            "schema_migrations",
            [("version", "INTEGER", false, 1), ("name", "TEXT", true, 0)].as_slice(),
            0,
        ),
        (
            "scope_state",
            [
                ("scope_key", "TEXT", false, 1),
                ("payload_json", "TEXT", true, 0),
            ]
            .as_slice(),
            1,
        ),
        (
            "control_state",
            [
                ("control_id", "TEXT", false, 1),
                ("payload_json", "TEXT", true, 0),
            ]
            .as_slice(),
            1,
        ),
        (
            "metadata",
            [("key", "TEXT", false, 1), ("payload_json", "TEXT", true, 0)].as_slice(),
            1,
        ),
    ];
    for (table, expected_columns, expected_primary_key_indexes) in expected {
        let mut statement = connection
            .prepare(
                "SELECT name, type, \"notnull\", pk \
                 FROM pragma_table_info(?1) ORDER BY cid",
            )
            .map_err(|_| PersistenceError::SchemaDrift)?;
        let columns = statement
            .query_map([table], |row| {
                Ok(PhysicalColumn {
                    name: row.get(0)?,
                    declared_type: row.get(1)?,
                    not_null: row.get(2)?,
                    primary_key_position: row.get(3)?,
                })
            })
            .map_err(|_| PersistenceError::SchemaDrift)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PersistenceError::SchemaDrift)?;
        let expected_columns = expected_columns
            .iter()
            .map(
                |(name, declared_type, not_null, primary_key_position)| PhysicalColumn {
                    name: (*name).to_owned(),
                    declared_type: (*declared_type).to_owned(),
                    not_null: *not_null,
                    primary_key_position: *primary_key_position,
                },
            )
            .collect::<Vec<_>>();
        if columns != expected_columns {
            return Err(PersistenceError::SchemaDrift);
        }

        let primary_key_indexes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_index_list(?1) \
                 WHERE \"unique\" = 1 AND origin = 'pk' AND partial = 0",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| PersistenceError::SchemaDrift)?;
        if primary_key_indexes != expected_primary_key_indexes {
            return Err(PersistenceError::SchemaDrift);
        }
    }
    Ok(())
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
    InvalidFilesystemPath,
    SchemaDrift,
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
            Self::InvalidFilesystemPath => {
                formatter.write_str("database path must name an ordinary filesystem file")
            }
            Self::SchemaDrift => formatter.write_str("physical schema drift detected"),
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
            | Self::BackupDestinationExists
            | Self::InvalidFilesystemPath
            | Self::SchemaDrift => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, sync::mpsc, thread, time::Duration};

    use house_automation_core::state::{
        AutomationState, ControlId, ControlState, Scope, ScopeId, ScopeState,
    };
    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::{Migration, SqliteStateStore, apply_migration, migrate_sequence};

    fn room(id: &str) -> Scope {
        Scope::Room(ScopeId::new(id).unwrap())
    }

    fn state_with_control() -> AutomationState {
        let kitchen = room("kitchen");
        let mut state = AutomationState::default();
        state
            .insert_scope(kitchen.clone(), ScopeState::new(true))
            .unwrap();
        state
            .insert_control(
                ControlId::new("remote").unwrap(),
                ControlState::new(kitchen),
            )
            .unwrap();
        state
    }

    #[test]
    fn load_uses_one_sqlite_snapshot_while_an_aggregate_is_replaced() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("state.sqlite3");
        let store = SqliteStateStore::open(&path).unwrap();
        let original = state_with_control();
        store.save(&original).unwrap();
        let mut replacement = AutomationState::default();
        replacement
            .insert_scope(Scope::House, ScopeState::new(false))
            .unwrap();
        let expected = original.snapshot();
        let (start_write, begin_write) = mpsc::channel();
        let (write_done, observe_write) = mpsc::channel();
        let writer_path = path.clone();
        let writer = thread::spawn(move || {
            begin_write.recv().unwrap();
            SqliteStateStore::open_existing(writer_path)
                .unwrap()
                .save(&replacement)
                .unwrap();
            write_done.send(()).unwrap();
        });
        let completed_during_read = Cell::new(false);

        let loaded = store
            .load_with_interleave(|| {
                start_write.send(()).unwrap();
                completed_during_read.set(
                    observe_write
                        .recv_timeout(Duration::from_millis(250))
                        .is_ok(),
                );
            })
            .unwrap();

        writer.join().unwrap();
        assert!(completed_during_read.get());
        assert_eq!(loaded.snapshot(), expected);
    }

    #[test]
    fn fresh_database_applies_every_known_migration_in_order() {
        let mut connection = Connection::open_in_memory().unwrap();
        let migrations = [
            Migration {
                version: 1,
                name: "first",
                sql: "
                    CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY,
                        name TEXT NOT NULL
                    );
                    CREATE TABLE first_table(value TEXT);
                ",
            },
            Migration {
                version: 2,
                name: "second",
                sql: "CREATE TABLE second_table(value TEXT);",
            },
        ];

        migrate_sequence(&mut connection, &migrations).unwrap();

        let history: Vec<(i64, String)> = connection
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(history, [(1, "first".to_owned()), (2, "second".to_owned())]);
        assert!(super::table_exists(&connection, "second_table").unwrap());
    }

    #[test]
    fn known_migration_prefix_upgrades_to_latest_without_reapplying_history() {
        let mut connection = Connection::open_in_memory().unwrap();
        let migrations = [
            Migration {
                version: 1,
                name: "first",
                sql: "
                    CREATE TABLE schema_migrations (
                        version INTEGER PRIMARY KEY,
                        name TEXT NOT NULL
                    );
                    CREATE TABLE first_table(value TEXT);
                ",
            },
            Migration {
                version: 2,
                name: "second",
                sql: "CREATE TABLE second_table(value TEXT);",
            },
        ];
        migrate_sequence(&mut connection, &migrations[..1]).unwrap();

        migrate_sequence(&mut connection, &migrations).unwrap();

        let history_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(history_count, 2);
        assert!(super::table_exists(&connection, "second_table").unwrap());
    }

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
