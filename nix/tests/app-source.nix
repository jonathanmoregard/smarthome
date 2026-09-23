{ pkgs, appSource, package }:

assert package.src == appSource;
pkgs.runCommand "smarthome-app-source-contract" { } ''
  require_file() {
    test -f "${appSource}/$1" || {
      echo "app source is missing required file: $1" >&2
      exit 1
    }
  }

  require_tree() {
    test -d "${appSource}/$1" || {
      echo "app source is missing required tree: $1" >&2
      exit 1
    }
  }

  reject_path() {
    test ! -e "${appSource}/$1" || {
      echo "app source contains forbidden path: $1" >&2
      exit 1
    }
  }

  require_file Cargo.toml
  require_file Cargo.lock
  require_file rust-toolchain.toml
  require_file examples/house.toml
  require_file house-automation-core/Cargo.toml
  require_file house-automation-core/src/lib.rs
  require_file house-automationd/Cargo.toml
  require_file house-automationd/src/main.rs
  require_tree house-automation-core
  require_tree house-automationd

  reject_path nixos
  reject_path docs
  reject_path .github
  reject_path nix/tests

  touch "$out"
''
