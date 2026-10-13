#!/usr/bin/env bash
set -euo pipefail

system=false

classify_path() {
  local path="$1"

  case "$path" in
    docs/* | README.md)
      ;;
    flake.nix | flake.lock | .github/* | nix/ci/*)
      system=true
      ;;
    nixos/*)
      system=true
      ;;
    *)
      # Unknown paths are deliberately fail-closed.
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

printf 'system=%s\n' "$system"
