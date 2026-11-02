#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/classify-paths.sh"

assert_classification() {
  local name="$1"
  local expected="$2"
  shift 2

  local actual
  actual="$(printf '%s\0' "$@" | "$classifier")"

  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected:\n%s\nactual:\n%s\n' \
      "$name" "$expected" "$actual" >&2
    return 1
  fi

  printf 'PASS: %s\n' "$name"
}

assert_classification \
  'lighting scripts select only the scripts lane' \
  $'system=false\nscripts=true' \
  'lighting-scripts/src/engine.ts'

assert_classification \
  'NixOS paths select only the system lane' \
  $'system=true\nscripts=false' \
  'nixos/home-server.nix'

assert_classification \
  'unknown paths fail closed to the system lane' \
  $'system=true\nscripts=false' \
  'whatever/x'

assert_classification \
  'documentation paths select neither lane' \
  $'system=false\nscripts=false' \
  'docs/operations.md'

assert_classification \
  'mixed paths select both lanes' \
  $'system=true\nscripts=true' \
  'lighting-scripts/tests/runtime/engine.test.ts' \
  'nixos/home-server.nix'
