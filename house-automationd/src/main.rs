use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};

use house_automationd::{logging, persistence::SqliteStateStore, runtime::run_service};

const DEFAULT_CONFIG: &str = "/etc/house-automation/config.toml";
const DEFAULT_STATE: &str = "/var/lib/house-automation/state.sqlite3";
const USAGE: &str = "usage: house-automationd [--config <config.toml> --state <state.sqlite3>]\n       house-automationd backup --database <state.sqlite3> --destination <backup.sqlite3>";

#[tokio::main]
async fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(CliError::Usage) => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        Err(CliError::Operation(error)) => {
            eprintln!("house automation failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(arguments: Vec<OsString>) -> Result<(), CliError> {
    match parse_arguments(arguments)? {
        Command::Run { config, state } => {
            logging::init().map_err(|error| CliError::Operation(Box::new(error)))?;
            run_service(&config, &state)
                .await
                .map_err(|error| CliError::Operation(Box::new(error)))
        }
        Command::Backup {
            database,
            destination,
        } => {
            let store = SqliteStateStore::open_existing(database)
                .map_err(|error| CliError::Operation(Box::new(error)))?;
            store
                .backup_to(destination)
                .map_err(|error| CliError::Operation(Box::new(error)))
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Run {
        config: PathBuf,
        state: PathBuf,
    },
    Backup {
        database: PathBuf,
        destination: PathBuf,
    },
}

fn parse_arguments(arguments: Vec<OsString>) -> Result<Command, CliError> {
    match arguments.as_slice() {
        [] => Ok(Command::Run {
            config: PathBuf::from(DEFAULT_CONFIG),
            state: PathBuf::from(DEFAULT_STATE),
        }),
        [config_flag, config, state_flag, state]
            if config_flag == "--config" && state_flag == "--state" =>
        {
            Ok(Command::Run {
                config: PathBuf::from(config),
                state: PathBuf::from(state),
            })
        }
        [
            command,
            database_flag,
            database,
            destination_flag,
            destination,
        ] if command == "backup"
            && database_flag == "--database"
            && destination_flag == "--destination" =>
        {
            Ok(Command::Backup {
                database: PathBuf::from(database),
                destination: PathBuf::from(destination),
            })
        }
        _ => Err(CliError::Usage),
    }
}

#[derive(Debug)]
enum CliError {
    Usage,
    Operation(Box<dyn std::error::Error>),
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, path::PathBuf};

    use super::{Command, parse_arguments};

    #[test]
    fn no_arguments_uses_safe_service_paths() {
        assert_eq!(
            parse_arguments(Vec::new()).unwrap(),
            Command::Run {
                config: PathBuf::from("/etc/house-automation/config.toml"),
                state: PathBuf::from("/var/lib/house-automation/state.sqlite3"),
            }
        );
    }

    #[test]
    fn explicit_run_paths_are_accepted_without_shell_parsing() {
        let arguments = [
            "--config",
            "/run/config.toml",
            "--state",
            "/var/lib/test.sqlite3",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(
            parse_arguments(arguments).unwrap(),
            Command::Run {
                config: PathBuf::from("/run/config.toml"),
                state: PathBuf::from("/var/lib/test.sqlite3"),
            }
        );
    }
}
