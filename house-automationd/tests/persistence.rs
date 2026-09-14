use std::{fs, path::Path, process::Command, thread, time::Duration};

use house_automation_core::{
    curve::{CircadianCurve, CurveAnchor, CurvePoint, TimeOfDay},
    state::{
        AutomationState, ControlId, ControlState, ConvergenceDuration, CurveMode, LocalDate,
        MonotonicTime, Scope, ScopeId, ScopeState, UserOffsets,
    },
    value::Brightness,
};
use house_automationd::persistence::{CURRENT_SCHEMA_VERSION, SqliteStateStore};
use rusqlite::Connection;
use tempfile::TempDir;

#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

fn room(id: &str) -> Scope {
    Scope::Room(ScopeId::new(id).unwrap())
}

fn point(brightness: f64, kelvin: f64) -> CurvePoint {
    CircadianCurve::new(vec![
        CurveAnchor::new(
            TimeOfDay::from_hms(0, 0, 0).unwrap(),
            Brightness::new(brightness).unwrap(),
            kelvin,
        )
        .unwrap(),
        CurveAnchor::new(
            TimeOfDay::from_hms(12, 0, 0).unwrap(),
            Brightness::new(brightness).unwrap(),
            kelvin,
        )
        .unwrap(),
    ])
    .unwrap()
    .sample(TimeOfDay::from_hms(6, 0, 0).unwrap())
}

fn populated_state() -> AutomationState {
    let kitchen = room("kitchen");
    let bedroom = room("bedroom");
    let mut state = AutomationState::with_last_reset_date(LocalDate::new(2026, 9, 13).unwrap());
    state
        .insert_scope(kitchen.clone(), ScopeState::new(true))
        .unwrap();
    state
        .insert_scope(bedroom.clone(), ScopeState::new(false))
        .unwrap();
    state
        .set_scope_offsets(&kitchen, UserOffsets::new(0.17, -325.0).unwrap())
        .unwrap();
    state
        .toggle_scope_curve(
            &kitchen,
            point(0.43, 2_750.0),
            MonotonicTime::from_seconds(15.0).unwrap(),
            ConvergenceDuration::from_seconds(30.0).unwrap(),
        )
        .unwrap();
    state
        .insert_control(
            ControlId::new("bedside_remote").unwrap(),
            ControlState::new(bedroom),
        )
        .unwrap();
    state
}

fn database_path(directory: &TempDir) -> std::path::PathBuf {
    directory.path().join("state.sqlite3")
}

fn table_names(path: &Path) -> Vec<String> {
    let connection = Connection::open(path).unwrap();
    let mut query = connection
        .prepare(
            "SELECT name FROM sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .unwrap();
    query
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn opening_empty_database_applies_numbered_schema_in_order() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);

    let store = SqliteStateStore::open(&path).unwrap();

    assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert_eq!(
        table_names(&path),
        [
            "control_state",
            "metadata",
            "schema_migrations",
            "scope_state"
        ]
    );
    let connection = Connection::open(path).unwrap();
    let applied: Vec<(i64, String)> = connection
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(applied, vec![(1, "initial_state".to_owned())]);
}

#[test]
fn reopening_migrated_database_is_idempotent() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    drop(SqliteStateStore::open(&path).unwrap());

    let reopened = SqliteStateStore::open(&path).unwrap();

    assert_eq!(reopened.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    let connection = Connection::open(path).unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn deliberate_state_round_trips_as_one_valid_aggregate() {
    let directory = TempDir::new().unwrap();
    let store = SqliteStateStore::open(database_path(&directory)).unwrap();
    let state = populated_state();

    store.save(&state).unwrap();
    let restored = store.load().unwrap();

    assert_eq!(restored.snapshot(), state.snapshot());
    assert!(!restored.scope_state(&room("bedroom")).unwrap().is_on());
    assert_eq!(
        restored.scope_state(&room("kitchen")).unwrap().offsets(),
        UserOffsets::new(0.17, -325.0).unwrap()
    );
    assert!(matches!(
        restored.scope_state(&room("kitchen")).unwrap().mode(),
        CurveMode::Frozen { .. }
    ));
    assert_eq!(
        restored
            .control_state(&ControlId::new("bedside_remote").unwrap())
            .unwrap()
            .selected_scope(),
        &room("bedroom")
    );
    assert_eq!(
        restored.last_reset_date(),
        Some(LocalDate::new(2026, 9, 13).unwrap())
    );
}

#[test]
fn second_save_removes_stale_scope_and_control_rows_atomically() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    let store = SqliteStateStore::open(&path).unwrap();
    store.save(&populated_state()).unwrap();
    let mut replacement = AutomationState::default();
    replacement
        .insert_scope(Scope::House, ScopeState::new(true))
        .unwrap();

    store.save(&replacement).unwrap();

    let restored = store.load().unwrap();
    assert_eq!(restored.snapshot(), replacement.snapshot());
    let connection = Connection::open(path).unwrap();
    let counts: (i64, i64, i64) = connection
        .query_row(
            "SELECT \
                (SELECT COUNT(*) FROM scope_state), \
                (SELECT COUNT(*) FROM control_state), \
                (SELECT COUNT(*) FROM metadata)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(counts, (1, 0, 1));
}

#[test]
fn failed_aggregate_save_rolls_back_deletes_and_partial_inserts() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    let store = SqliteStateStore::open(&path).unwrap();
    let original = populated_state();
    store.save(&original).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_metadata BEFORE INSERT ON metadata \
             BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END;",
        )
        .unwrap();
    let mut replacement = AutomationState::default();
    replacement
        .insert_scope(Scope::House, ScopeState::new(true))
        .unwrap();

    assert!(store.save(&replacement).is_err());
    connection
        .execute_batch("DROP TRIGGER reject_metadata")
        .unwrap();

    assert_eq!(store.load().unwrap().snapshot(), original.snapshot());
}

#[test]
fn load_rejects_invalid_restored_references() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    let store = SqliteStateStore::open(&path).unwrap();
    store.save(&populated_state()).unwrap();
    let connection = Connection::open(path).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT payload_json FROM control_state WHERE control_id = ?1",
            ["bedside_remote"],
            |row| row.get(0),
        )
        .unwrap();
    let mut payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    payload["data"]["selected_scope"] = serde_json::json!({ "room": "missing" });
    connection
        .execute(
            "UPDATE control_state SET payload_json = ?1 WHERE control_id = ?2",
            [payload.to_string(), "bedside_remote".to_owned()],
        )
        .unwrap();

    let error = store.load().unwrap_err().to_string();

    assert!(error.contains("restore automation state"), "{error}");
    assert!(error.contains("missing"), "{error}");
}

#[test]
fn load_rejects_unknown_record_format_version() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    let store = SqliteStateStore::open(&path).unwrap();
    store.save(&populated_state()).unwrap();
    let connection = Connection::open(path).unwrap();
    connection
        .execute(
            "UPDATE scope_state SET payload_json = json_set(payload_json, '$.format_version', 99)",
            [],
        )
        .unwrap();

    let error = store.load().unwrap_err().to_string();

    assert!(
        error.contains("unsupported scope record format 99"),
        "{error}"
    );
}

#[test]
fn open_rejects_unknown_newer_or_non_prefix_migrations() {
    for (version, name) in [(2, "future"), (1, "renamed")] {
        let directory = TempDir::new().unwrap();
        let path = database_path(&directory);
        drop(SqliteStateStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("DELETE FROM schema_migrations", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, name) VALUES (?1, ?2)",
                (version, name),
            )
            .unwrap();

        let error = SqliteStateStore::open(&path).unwrap_err().to_string();

        assert!(error.contains("migration history"), "{error}");
    }
}

#[test]
fn open_rejects_unversioned_nonempty_database() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    Connection::open(&path)
        .unwrap()
        .execute("CREATE TABLE legacy(value TEXT)", [])
        .unwrap();

    let error = SqliteStateStore::open(&path).unwrap_err().to_string();

    assert!(error.contains("nonempty unversioned database"), "{error}");
}

#[test]
fn open_rejects_physical_schema_drift_despite_valid_history() {
    for corruption in [
        "ALTER TABLE control_state RENAME TO control_state_removed",
        "ALTER TABLE scope_state ADD COLUMN unexpected TEXT",
        "ALTER TABLE metadata RENAME COLUMN payload_json TO payload_text",
    ] {
        let directory = TempDir::new().unwrap();
        let path = database_path(&directory);
        drop(SqliteStateStore::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .execute_batch(corruption)
            .unwrap();

        let error = SqliteStateStore::open(&path).unwrap_err().to_string();

        assert!(
            error.contains("physical schema drift"),
            "{corruption}: {error}"
        );
    }
}

#[test]
fn convergence_and_transient_runtime_data_are_not_persisted() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    let store = SqliteStateStore::open(&path).unwrap();
    let mut state = populated_state();
    state
        .toggle_scope_curve(
            &room("kitchen"),
            point(0.8, 4_100.0),
            MonotonicTime::from_seconds(25.0).unwrap(),
            ConvergenceDuration::from_seconds(30.0).unwrap(),
        )
        .unwrap();

    store.save(&state).unwrap();
    let restored = store.load().unwrap();

    assert_eq!(
        restored.scope_state(&room("kitchen")).unwrap().mode(),
        &CurveMode::Follow
    );
    let connection = Connection::open(path).unwrap();
    let payloads: String = connection
        .query_row(
            "SELECT COALESCE(group_concat(payload_json, ''), '') FROM (\
                SELECT payload_json FROM scope_state \
                UNION ALL SELECT payload_json FROM control_state \
                UNION ALL SELECT payload_json FROM metadata\
            )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    for forbidden in ["converging", "overlay", "mqtt", "animation"] {
        assert!(
            !payloads.contains(forbidden),
            "persisted {forbidden}: {payloads}"
        );
    }
}

#[test]
fn online_backup_restores_same_snapshot_and_refuses_overwrite() {
    let directory = TempDir::new().unwrap();
    let source_path = database_path(&directory);
    let backup_path = directory.path().join("backup.sqlite3");
    let store = SqliteStateStore::open(&source_path).unwrap();
    let state = populated_state();
    store.save(&state).unwrap();

    store.backup_to(&backup_path).unwrap();
    let restored = SqliteStateStore::open(&backup_path)
        .unwrap()
        .load()
        .unwrap();

    assert_eq!(restored.snapshot(), state.snapshot());
    assert!(store.backup_to(&backup_path).is_err());
    assert!(store.backup_to(&source_path).is_err());
    assert!(fs::metadata(&source_path).unwrap().len() > 0);
}

#[test]
fn failed_backup_publish_preserves_destination_and_cleans_temporary_file() {
    let directory = TempDir::new().unwrap();
    let source_path = database_path(&directory);
    let backup_path = directory.path().join("backup.sqlite3");
    let store = SqliteStateStore::open(&source_path).unwrap();
    store.save(&populated_state()).unwrap();
    fs::write(&backup_path, b"existing backup").unwrap();
    let entries_before = fs::read_dir(directory.path()).unwrap().count();

    assert!(store.backup_to(&backup_path).is_err());

    assert_eq!(fs::read(&backup_path).unwrap(), b"existing backup");
    assert_eq!(
        fs::read_dir(directory.path()).unwrap().count(),
        entries_before
    );
    assert!(
        store
            .backup_to(directory.path().join("missing/backup.sqlite3"))
            .is_err()
    );
    assert_eq!(
        fs::read_dir(directory.path()).unwrap().count(),
        entries_before
    );
}

#[test]
fn configured_busy_timeout_allows_a_short_concurrent_writer() {
    let directory = TempDir::new().unwrap();
    let path = database_path(&directory);
    let store = SqliteStateStore::open(&path).unwrap();
    let locker = Connection::open(&path).unwrap();
    locker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(75));
        locker.execute_batch("ROLLBACK").unwrap();
    });

    store.save(&populated_state()).unwrap();

    release.join().unwrap();
    assert_eq!(
        store.load().unwrap().snapshot(),
        populated_state().snapshot()
    );
}

#[test]
fn backup_subcommand_creates_restorable_online_backup() {
    let directory = TempDir::new().unwrap();
    let source_path = database_path(&directory);
    let backup_path = directory.path().join("cli-backup.sqlite3");
    let store = SqliteStateStore::open(&source_path).unwrap();
    store.save(&populated_state()).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_house-automationd"))
        .args([
            "backup",
            "--database",
            source_path.to_str().unwrap(),
            "--destination",
            backup_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let restored = SqliteStateStore::open(backup_path).unwrap().load().unwrap();
    assert_eq!(restored.snapshot(), populated_state().snapshot());
}

#[test]
fn backup_subcommand_refuses_to_create_a_missing_source_database() {
    let directory = TempDir::new().unwrap();
    let source_path = database_path(&directory);
    let backup_path = directory.path().join("cli-backup.sqlite3");

    let output = Command::new(env!("CARGO_BIN_EXE_house-automationd"))
        .args([
            "backup",
            "--database",
            source_path.to_str().unwrap(),
            "--destination",
            backup_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(!source_path.exists());
    assert!(!backup_path.exists());
}

#[test]
fn backup_subcommand_rejects_sqlite_uri_destination_without_literal_or_hidden_output() {
    let directory = TempDir::new().unwrap();
    let source_path = database_path(&directory);
    SqliteStateStore::open(&source_path)
        .unwrap()
        .save(&populated_state())
        .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_house-automationd"))
        .current_dir(directory.path())
        .args([
            "backup",
            "--database",
            source_path.to_str().unwrap(),
            "--destination",
            "file:backup.sqlite3?mode=memory&cache=shared",
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(!directory.path().join("backup.sqlite3").exists());
    assert!(
        !directory
            .path()
            .join("file:backup.sqlite3?mode=memory&cache=shared")
            .exists()
    );
}

#[test]
fn backup_subcommand_rejects_memory_and_uri_sources() {
    let directory = TempDir::new().unwrap();
    for source in [":memory:", "file:state.sqlite3?mode=memory&cache=shared"] {
        let backup = directory
            .path()
            .join(format!("backup-{}.sqlite3", source.len()));
        let output = Command::new(env!("CARGO_BIN_EXE_house-automationd"))
            .current_dir(directory.path())
            .args([
                "backup",
                "--database",
                source,
                "--destination",
                backup.to_str().unwrap(),
            ])
            .output()
            .unwrap();

        assert!(!output.status.success(), "accepted {source}");
        assert!(!backup.exists());
    }
    assert!(!directory.path().join("state.sqlite3").exists());
}

#[cfg(unix)]
#[test]
fn new_state_and_backup_files_are_owner_only() {
    const CHILD_MARKER: &str = "HOUSE_AUTOMATION_PERMISSION_TEST_CHILD";
    const DIRECTORY_ENV: &str = "HOUSE_AUTOMATION_PERMISSION_TEST_DIRECTORY";
    if std::env::var_os(CHILD_MARKER).is_none() {
        let directory = TempDir::new().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", "new_state_and_backup_files_are_owner_only"])
            .env(CHILD_MARKER, "1")
            .env(DIRECTORY_ENV, directory.path());
        // SAFETY: this closure runs after fork and before exec, calls only async-signal-safe umask,
        // and mutates no parent-process state.
        unsafe {
            child.pre_exec(|| {
                libc::umask(0);
                Ok(())
            });
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let directory_path = std::env::var_os(DIRECTORY_ENV).unwrap();
    let directory_path = Path::new(&directory_path);
    let source_path = directory_path.join("state.sqlite3");
    let backup_path = directory_path.join("backup.sqlite3");
    let store = SqliteStateStore::open(&source_path).unwrap();
    store.save(&populated_state()).unwrap();

    store.backup_to(&backup_path).unwrap();

    assert_eq!(
        fs::metadata(source_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(backup_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn backup_rejects_symlink_alias_of_source_without_changing_source() {
    let directory = TempDir::new().unwrap();
    let source_path = database_path(&directory);
    let alias_path = directory.path().join("source-alias.sqlite3");
    let store = SqliteStateStore::open(&source_path).unwrap();
    let expected = populated_state();
    store.save(&expected).unwrap();
    symlink(&source_path, &alias_path).unwrap();

    assert!(store.backup_to(&alias_path).is_err());

    assert_eq!(store.load().unwrap().snapshot(), expected.snapshot());
    assert_eq!(fs::read_link(alias_path).unwrap(), source_path);
}
