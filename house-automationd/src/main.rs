use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};

use house_automationd::persistence::SqliteStateStore;

const USAGE: &str =
    "usage: house-automationd backup --database <state.sqlite3> --destination <backup.sqlite3>";

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(CliError::Usage) => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        Err(CliError::Operation(error)) => {
            eprintln!("backup failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: Vec<OsString>) -> Result<(), CliError> {
    let [
        command,
        database_flag,
        database,
        destination_flag,
        destination,
    ] = arguments.as_slice()
    else {
        return Err(CliError::Usage);
    };
    if command != "backup" || database_flag != "--database" || destination_flag != "--destination" {
        return Err(CliError::Usage);
    }

    let store =
        SqliteStateStore::open_existing(PathBuf::from(database)).map_err(CliError::Operation)?;
    store
        .backup_to(PathBuf::from(destination))
        .map_err(CliError::Operation)
}

enum CliError {
    Usage,
    Operation(house_automationd::persistence::PersistenceError),
}
