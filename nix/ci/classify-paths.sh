#!/usr/bin/env bash
set -euo pipefail

app=false
system=false

classify_path() {
  local path="$1"

  case "$path" in
    docs/* | README.md)
      ;;
    flake.nix | flake.lock | .github/* | nix/ci/* | nix/tests/release-scripts.nix | nix/tests/publish-workflow.nix)
      app=true
      system=true
      ;;
    Cargo.toml | Cargo.lock | rust-toolchain.toml | examples/* | house-automation-core/* | house-automationd/* | nix/package.nix | nix/source.nix | nix/module.nix | nix/tests/app-source.nix | nix/tests/module.nix | nix/tests/simulated-house.nix)
      app=true
      ;;
    nixos/*)
      system=true
      ;;
    *)
      # Unknown paths are deliberately fail-closed.
      app=true
      system=true
      ;;
  esac
}

while true; do
  path=
  if IFS= read -r -d '' path; then
    if [[ -z "$path" ]]; then
      echo 'empty path in NUL-delimited input' >&2
      exit 2
    fi
    classify_path "$path"
  else
    if [[ -n "$path" ]]; then
      echo 'input is not NUL-terminated' >&2
      exit 2
    fi
    break
  fi
done

printf 'app=%s\nsystem=%s\n' "$app" "$system"
