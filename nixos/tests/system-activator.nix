# Atomic NixOS system-profile activation, health, and exact rollback contract.
{ pkgs, script }:

let
  system = name: pkgs.runCommand name { } ''
    mkdir -p "$out/bin"
    cat > "$out/bin/switch-to-configuration" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
printf 'switch ${name} %s\n' "$*" >> "$SWITCH_LOG"
[ "$#" -eq 1 ] && [ "$1" = switch ]
if [ "''${FAIL_SWITCH_PATH:-}" = "$(readlink -f "$(dirname "$0")/..")" ]; then
  exit 75
fi
ln -sfn "$(readlink -f "$(dirname "$0")/..")" "$CURRENT_SYSTEM"
EOF
    chmod +x "$out/bin/switch-to-configuration"
  '';
  v1 = system "system-v1";
  v2 = system "system-v2";
  unhealthy = system "system-unhealthy";
  v3 = system "system-v3";
  v4 = system "system-v4";
  legacy = system "system-legacy";
in
pkgs.runCommand "system-activator-contract" {
  nativeBuildInputs = with pkgs; [ bash coreutils gnugrep gnused ];
} ''
  set -euo pipefail
  state="$PWD/state" profile="$PWD/system" events="$PWD/events.log"
  mkdir -p "$PWD/bin"

  cat > "$PWD/bin/systemctl" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
printf 'systemctl %s\n' "$*" >> "$EVENTS"
running=$(readlink -f "$PROFILE" 2>/dev/null || true)
printf 'health %s %s\n' "$running" "$*" >> "$EVENTS"
case "$1" in
  reset-failed)
    rm -f "$START_LIMIT"
    ;;
  is-system-running)
    exit 0
    ;;
  is-active)
    [ "$#" -eq 4 ] && [ "$2" = --quiet ] && [ "$3" = -- ] && [ -n "$4" ] || exit 64
    if [ "$running" = "$UNHEALTHY" ] && [ "$4" = mosquitto.service ]; then
      exit 3
    fi
    case "$4" in
      sshd.service|tailscaled.service|mosquitto.service|zigbee2mqtt.service) ;;
      app-deploy.timer|system-deploy.timer)
        [ "$running" != "$LEGACY" ] || exit 3
        ;;
      smarthome-deploy.timer|nixos-deploy.timer)
        [ "$running" = "$LEGACY" ] || exit 3
        ;;
      *) exit 3 ;;
    esac
    ;;
  *) exit 64 ;;
esac
EOF
  cat > "$PWD/bin/timeout" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
[ "$1" = --signal=KILL ] || exit 64
duration=$2 command=$3
shift 3
printf 'timeout %s %s %s\n' "$duration" "$command" "$*" >> "$EVENTS"
if [ "''${SIGNAL_DURING_SWITCH_PATH:-}" = "$(readlink -f "$(dirname "$command")/..")" ]; then
  kill -TERM "$PPID"
  touch "$RECOVERY_SIGNAL_SENT"
fi
if [ "''${TIMEOUT_PATH:-}" = "$(readlink -f "$(dirname "$command")/..")" ] && [ ! -e "$TIMEOUT_MARKER" ]; then
  touch "$TIMEOUT_MARKER"
  exit 124
fi
exec "$command" "$@"
EOF
  cat > "$PWD/bin/sleep" <<'EOF'
#!${pkgs.runtimeShell}
printf 'sleep %s\n' "$*" >> "$EVENTS"
exit 0
EOF
  cat > "$PWD/bin/mv" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
destination=''${!#}
if [ "$destination" = "$SUCCESS_MARKER" ]; then
  if [ "''${FAIL_SUCCESS_MARKER_MOVE:-0}" = 1 ]; then
    touch "$SUCCESS_MOVE_FAILURE_TRIGGERED"
    exit 75
  fi
  ${pkgs.coreutils}/bin/mv "$@"
  if [ "''${SIGNAL_AFTER_SUCCESS_MOVE:-0}" = 1 ]; then
    kill -TERM "$PPID"
    touch "$SUCCESS_MOVE_SIGNAL_SENT"
  fi
  exit 0
fi
exec ${pkgs.coreutils}/bin/mv "$@"
EOF
  cat > "$PWD/bin/nix-env" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
[ "$1" = --profile ]
profile=$2 operation=$3
shift 3
printf 'nix-env %s' "$operation" >> "$EVENTS"
printf ' %s' "$@" >> "$EVENTS"
printf '\n' >> "$EVENTS"
case "$operation" in
  --set)
    generation=1
    [ ! -s "$GENERATIONS" ] || generation=$(( $(sort -n "$GENERATIONS" | tail -n1) + 1 ))
    ln -sfn "$1" "$profile-$generation-link"
    ln -sfn "$profile-$generation-link" "$profile"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    if [ "''${CRASH_AFTER_SET:-0}" = 1 ]; then
      kill -KILL "$PPID"
      exit 137
    fi
    ;;
  --list-generations)
    if [ "''${FAIL_LIST_GENERATIONS:-0}" = 1 ]; then exit 75; fi
    while read -r generation; do
      suffix=
      if [ "$(readlink "$profile" 2>/dev/null || true)" = "$profile-$generation-link" ]; then
        suffix=' (current)'
      fi
      printf '%s 2026-09-22%s\n' "$generation" "$suffix"
    done < "$GENERATIONS"
    true
    ;;
  --switch-generation)
    ln -sfn "$profile-$1-link" "$profile"
    ;;
  --delete-generations)
    [ "''${FAIL_DELETE_GENERATIONS:-0}" != 1 ] || exit 75
    for generation in "$@"; do rm -f "$profile-$generation-link"; done
    grep -vxF -f <(printf '%s\n' "$@") "$GENERATIONS" > "$GENERATIONS.tmp" || true
    mv "$GENERATIONS.tmp" "$GENERATIONS"
    ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "$PWD/bin/systemctl" "$PWD/bin/timeout" "$PWD/bin/sleep" "$PWD/bin/mv" "$PWD/bin/nix-env"
  export PATH="$PWD/bin:$PATH"
  export PROFILE="$profile" GENERATIONS="$PWD/generations" EVENTS="$events"
  export CURRENT_SYSTEM="$PWD/current-system"
  export SWITCH_LOG="$events" START_LIMIT="$PWD/start-limit" UNHEALTHY=${unhealthy}
  export LEGACY=${legacy}
  export TIMEOUT_MARKER="$PWD/timeout-once" SUCCESS_MARKER="$state/last-success"
  export SUCCESS_MOVE_SIGNAL_SENT="$PWD/success-move-signal-sent"
  export SUCCESS_MOVE_FAILURE_TRIGGERED="$PWD/success-move-failure-triggered"
  export RECOVERY_SIGNAL_SENT="$PWD/recovery-signal-sent"
  health_units=(sshd.service tailscaled.service mosquitto.service zigbee2mqtt.service)
  health_unit_groups=(app-deploy.timer,smarthome-deploy.timer system-deploy.timer,nixos-deploy.timer)
  health_args=()
  for unit in "''${health_units[@]}"; do health_args+=(--unit "$unit"); done
  for group in "''${health_unit_groups[@]}"; do health_args+=(--any-unit-group "$group"); done

  reset_observations() {
    : > "$EVENTS"
    rm -f "$TIMEOUT_MARKER" "$START_LIMIT" "$SUCCESS_MOVE_SIGNAL_SENT" "$SUCCESS_MOVE_FAILURE_TRIGGERED" "$RECOVERY_SIGNAL_SENT"
    unset FAIL_SWITCH_PATH TIMEOUT_PATH SIGNAL_DURING_SWITCH_PATH
    export FAIL_LIST_GENERATIONS=0 FAIL_DELETE_GENERATIONS=0
    export SIGNAL_AFTER_SUCCESS_MOVE=0 FAIL_SUCCESS_MARKER_MOVE=0
  }
  reset_fixture() {
    rm -rf "$state"
    rm -f "$profile" "$profile"-*-link "$GENERATIONS" "$CURRENT_SYSTEM"
    mkdir -p "$state"
    : > "$GENERATIONS"
    reset_observations
  }
  seed_generation() {
    generation=$1 path=$2 current=$3
    ln -sfn "$path" "$profile-$generation-link"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    if [ "$current" = current ]; then
      ln -sfn "$profile-$generation-link" "$profile"
      ln -sfn "$path" "$CURRENT_SYSTEM"
    fi
  }
  seed_v1() {
    reset_fixture
    seed_generation 1 ${v1} current
    cat > "$state/last-success" <<EOF
rev=1111111111111111111111111111111111111111
path=${v1}
previous_path=none
previous_generation=none
EOF
  }
  seed_v2_with_history() {
    reset_fixture
    seed_generation 1 ${v1} stale
    seed_generation 2 ${v2} current
    cat > "$state/last-success" <<EOF
rev=2222222222222222222222222222222222222222
path=${v2}
previous_path=${v1}
previous_generation=1
EOF
  }
  seed_legacy() {
    reset_fixture
    seed_generation 1 ${legacy} current
    cat > "$state/last-success" <<EOF
rev=0000000000000000000000000000000000000000
path=${legacy}
previous_path=none
previous_generation=none
EOF
  }
  run() { bash ${script} "$1" "$2" "$state" "$profile" "$CURRENT_SYSTEM" "''${health_args[@]}"; }
  links() { find "$PWD" -maxdepth 1 -name 'system-*-link' | wc -l; }

  # A healthy candidate is switched, observed healthy for the sustained
  # window, committed atomically, and only then may old generations be pruned.
  reset_fixture
  run ${v1} 1111111111111111111111111111111111111111 || {
    echo 'structured all-of/any-of unit health contract is absent' >&2
    exit 1
  }
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qxF 'rev=1111111111111111111111111111111111111111' "$state/last-success"
  [ "$(grep -c '^systemctl is-system-running$' "$EVENTS")" -eq 3 ]
  for unit in "''${health_units[@]}"; do
    [ "$(grep -c "^systemctl is-active --quiet -- $unit$" "$EVENTS")" -eq 3 ]
  done
  for unit in app-deploy.timer smarthome-deploy.timer system-deploy.timer nixos-deploy.timer; do
    [ "$(grep -c "^systemctl is-active --quiet -- $unit$" "$EVENTS")" -eq 3 ]
  done
  health_line=$(grep -n '^systemctl is-system-running$' "$EVENTS" | tail -1 | cut -d: -f1)
  prune_line=$(grep -n '^nix-env --delete-generations' "$EVENTS" | cut -d: -f1 || true)
  [ -z "$prune_line" ] || [ "$prune_line" -gt "$health_line" ]

  # A deterministically unhealthy candidate restores the exact old generation,
  # re-runs old activation, proves recovery health, and is poison-eligible.
  seed_v1
  if run ${unhealthy} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  grep -qF 'switch system-v1 switch' "$EVENTS"
  [ "$(links)" -eq 1 ]

  # First-cutover recovery accepts exactly one legacy timer from each deploy
  # compatibility group while candidate health checks the new timer names.
  seed_legacy
  if run ${unhealthy} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink -f "$profile")" = ${legacy} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${legacy} ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure" || {
    cat "$state/last-failure" >&2
    echo 'legacy timer names did not satisfy rollback health' >&2
    exit 1
  }
  grep -qF 'health ${unhealthy} is-active --quiet -- app-deploy.timer' "$EVENTS"
  grep -qF 'health ${unhealthy} is-active --quiet -- system-deploy.timer' "$EVENTS"
  grep -qF 'health ${legacy} is-active --quiet -- smarthome-deploy.timer' "$EVENTS"
  grep -qF 'health ${legacy} is-active --quiet -- nixos-deploy.timer' "$EVENTS"

  # A hard crash immediately after profile allocation leaves an atomic pending
  # journal. Recovery mode bypasses drift, restores the exact old generation,
  # reactivates it, proves its running-system link, and clears the journal.
  seed_v1
  export CRASH_AFTER_SET=1
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  unset CRASH_AFTER_SET
  [ -s "$state/pending-activation" ]
  [ "$(readlink -f "$profile")" = ${v2} ]
  export SIGNAL_DURING_SWITCH_PATH=${v1}
  bash ${script} --recover "$state" "$profile" "$CURRENT_SYSTEM" "''${health_args[@]}"
  unset SIGNAL_DURING_SWITCH_PATH
  [ -e "$RECOVERY_SIGNAL_SENT" ]
  [ "$(readlink -f "$profile")" = ${v1} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v1} ]
  [ ! -e "$state/pending-activation" ]
  [ "$(links)" -eq 1 ]

  # A profile/running-system mismatch is operator or boot drift and fails before
  # allocating a pending transaction or changing any generation.
  seed_v1
  ln -sfn ${v2} "$CURRENT_SYSTEM"
  if run ${v3} 4444444444444444444444444444444444444444 2> "$PWD/running-drift.err"; then exit 1; fi
  grep -qxF 'activate-system: active profile does not match running system' "$PWD/running-drift.err"
  [ ! -e "$state/pending-activation" ]
  [ "$(readlink -f "$profile")" = ${v1} ]
  [ "$(links)" -eq 1 ]

  # A finite candidate switch timeout is retryable, with exact healthy recovery.
  seed_v1
  export TIMEOUT_PATH=${v2}
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  grep -qxF 'reason=candidate-switch-timeout' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qF 'timeout 120s ${v2}/bin/switch-to-configuration switch' "$EVENTS"
  grep -qF 'switch system-v1 switch' "$EVENTS"

  # Start-limit exhaustion in the candidate switch still resets limits before
  # both activations and rolls back to the exact old generation.
  seed_v1
  touch "$START_LIMIT"
  export FAIL_SWITCH_PATH=${v2}
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  grep -qxF 'reason=candidate-switch-failed' "$state/last-failure"
  [ ! -e "$START_LIMIT" ]
  [ "$(grep -c '^systemctl reset-failed$' "$EVENTS")" -eq 2 ]
  [ "$(readlink -f "$profile")" = ${v1} ]

  # Three stable activations retain current + previous only.
  reset_fixture
  run ${v1} 1111111111111111111111111111111111111111
  run ${v2} 2222222222222222222222222222222222222222
  run ${v3} 4444444444444444444444444444444444444444
  [ "$(readlink -f "$profile")" = ${v3} ]
  [ "$(links)" -eq 2 ]
  [ ! -e "$profile-1-link" ]

  # A signal immediately after atomic success rename cannot roll back committed
  # state; a failed rename must roll back and preserve the previous marker.
  seed_v1
  export SIGNAL_AFTER_SUCCESS_MOVE=1
  run ${v2} 2222222222222222222222222222222222222222
  [ -e "$SUCCESS_MOVE_SIGNAL_SENT" ]
  [ "$(readlink -f "$profile")" = ${v2} ]
  grep -qxF 'rev=2222222222222222222222222222222222222222' "$state/last-success"

  seed_v2_with_history
  success_before=$(cat "$state/last-success")
  export FAIL_SUCCESS_MARKER_MOVE=1
  if run ${v3} 4444444444444444444444444444444444444444; then exit 1; fi
  [ -e "$SUCCESS_MOVE_FAILURE_TRIGGERED" ]
  [ "$(readlink -f "$profile")" = ${v2} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v2} ]
  [ "$(cat "$state/last-success")" = "$success_before" ]
  grep -qxF 'reason=success-marker-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ ! -e "$profile-1-link" ]
  [ -e "$profile-2-link" ]
  [ ! -e "$profile-3-link" ]
  [ "$(links)" -eq 1 ]

  # Generation enumeration is fail-closed before any profile mutation.
  reset_fixture
  export FAIL_LIST_GENERATIONS=1
  if run ${v1} 1111111111111111111111111111111111111111 2> "$PWD/list.err"; then exit 1; fi
  grep -qxF 'activate-system: could not list profile generations' "$PWD/list.err"
  [ ! -e "$profile" ]

  # A first-install failure has no prior system whose health can be proven, so
  # rollback is incomplete and retains one recovery root. Retrying first removes
  # that orphan and therefore never grows the generation set without bound.
  reset_fixture
  for retry in 1 2 3; do
    if run ${unhealthy} 3333333333333333333333333333333333333333; then exit 1; fi
    [ ! -e "$profile" ]
    [ -e "$profile-1-link" ]
    [ "$(links)" -eq 1 ]
    [ "$(cat "$GENERATIONS")" = 1 ]
    grep -qxF 'rollback=incomplete' "$state/last-failure"
    reset_observations
  done

  # Journal recovery remains fail-closed when its orphan cannot be removed.
  export FAIL_DELETE_GENERATIONS=1
  if run ${unhealthy} 3333333333333333333333333333333333333333 2> "$PWD/delete.err"; then exit 1; fi
  grep -qxF 'activate-system: interrupted activation recovery failed' "$PWD/delete.err"
  [ ! -e "$profile" ]
  [ -s "$state/pending-activation" ]
  [ -e "$profile-1-link" ]
  [ "$(links)" -eq 1 ]
  ! grep -q '^nix-env --set ' "$EVENTS"

  # Without an auto-deploy journal, a newer non-current generation is a manual
  # rollback topology. Refuse it before deletion or candidate allocation.
  seed_v2_with_history
  seed_generation 3 ${v3} stale
  if run ${v4} 5555555555555555555555555555555555555555 2> "$PWD/manual-rollback.err"; then
    echo 'manual rollback topology was overwritten' >&2
    exit 1
  fi
  grep -qxF 'activate-system: active generation is older than newest generation; refusing manual rollback' "$PWD/manual-rollback.err"
  [ "$(readlink -f "$profile")" = ${v2} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v2} ]
  [ -e "$profile-1-link" ]
  [ -e "$profile-2-link" ]
  [ -e "$profile-3-link" ]
  [ "$(links)" -eq 3 ]
  [ ! -e "$state/pending-activation" ]
  ! grep -q '^nix-env --delete-generations' "$EVENTS"
  ! grep -q '^nix-env --set ' "$EVENTS"

  touch "$out"
''
