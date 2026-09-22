# The activator owns atomic switching, exact generation rollback, start-limit
# recovery, and pruning only after a healthy candidate.
{ pkgs, script }:

let
  package = name: pkgs.runCommand name { } ''mkdir -p "$out/bin"; touch "$out/bin/house-automationd"; chmod +x "$out/bin/house-automationd"'';
  v1 = package "app-v1";
  v2 = package "app-v2";
  v3 = package "app-v3";
  v4 = package "app-v4";
  v5 = package "app-v5";
in
pkgs.runCommand "app-activator-contract" { nativeBuildInputs = with pkgs; [ bash coreutils gnugrep ]; } ''
  set -euo pipefail
  state="$PWD/state" profile="$PWD/profile" log="$PWD/systemctl.log"
  mkdir -p "$PWD/bin"
  cat > "$PWD/bin/systemctl" <<'EOF'
#!${pkgs.runtimeShell}
printf 'systemctl %s\n' "$*" >> "$ACTIVATOR_LOG"
if [ "$1" = reset-failed ] && [ "''${CANDIDATE_RESET_FAILURE:-0}" = 1 ] && [ ! -e "$CANDIDATE_RESET_MARKER" ] && [ "$(readlink -f "$PROFILE")" = "$RESET_CANDIDATE" ]; then touch "$CANDIDATE_RESET_MARKER"; exit 1; fi
if [ "$1" = reset-failed ]; then rm -f "$START_LIMIT"; exit 0; fi
if [ "$1" = restart ] && [ "''${MISSING_PROFILE_RECOVERY_FAILURE:-0}" = 1 ] && [ ! -e "$PROFILE" ] && [ ! -L "$PROFILE" ]; then touch "$MISSING_PROFILE_RECOVERY_MARKER"; exit 1; fi
if [ "$1" = restart ] && [ "$(readlink -f "$PROFILE")" = "$CRASHING" ]; then touch "$START_LIMIT"; exit 1; fi
if [ "$1" = restart ] && [ "''${RECOVERY_FAILURE:-0}" = 1 ] && [ "$(readlink -f "$PROFILE")" = "$RECOVERY_PATH" ]; then exit 1; fi
exit 0
EOF
  cat > "$PWD/bin/curl" <<'EOF'
#!${pkgs.runtimeShell}
[ "$#" -eq 8 ] || exit 64
[ "$1" = --connect-timeout ] && [ "$2" = 2 ] && [ "$3" = --max-time ] && [ "$4" = 2 ] && [ "$5" = --fail ] && [ "$6" = --silent ] && [ "$7" = --show-error ] && [ "$8" = http://127.0.0.1:9876/healthz ] || exit 64
printf '%s\n' "$*" >> "$CURL_LOG"
[ "$(readlink -f "$PROFILE")" != "$UNHEALTHY" ]
EOF
  cat > "$PWD/bin/sleep" <<'EOF'
#!${pkgs.runtimeShell}
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
{
  printf '%s' "$operation"
  [ "$#" -eq 0 ] || printf ' %s' "$@"
  printf '\n'
} >> "$NIX_ENV_LOG"
case "$operation" in
  --set)
    generation=1
    [ ! -s "$GENERATIONS" ] || generation=$(( $(sort -n "$GENERATIONS" | tail -n1) + 1 ))
    ln -sfn "$1" "$profile-$generation-link"
    ln -sfn "$profile-$generation-link" "$profile"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    ;;
  --list-generations)
    list_calls=0
    [ ! -s "$LIST_CALLS" ] || list_calls=$(cat "$LIST_CALLS")
    list_calls=$((list_calls + 1))
    printf '%s\n' "$list_calls" > "$LIST_CALLS"
    if [ -n "''${LIST_FAIL_AT:-}" ] && [ "$list_calls" -eq "$LIST_FAIL_AT" ]; then exit 75; fi
    while read -r generation; do
      suffix=
      [ "$(readlink "$profile" 2>/dev/null || true)" = "$profile-$generation-link" ] && suffix=' (current)'
      printf '%s 2026-09-22%s\n' "$generation" "$suffix"
    done < "$GENERATIONS"
    ;;
  --switch-generation)
    ln -sfn "$profile-$1-link" "$profile"
    ;;
  --delete-generations)
    current_link=$(readlink "$profile" 2>/dev/null || true)
    current_generation=$(printf '%s\n' "$current_link" | sed -n "s|^$profile-\([0-9][0-9]*\)-link$|\1|p")
    only_newer=1
    any_older=0
    for generation in "$@"; do
      [ -n "$current_generation" ] && [ "$generation" -gt "$current_generation" ] || only_newer=0
      if [ -n "$current_generation" ] && [ "$generation" -lt "$current_generation" ]; then any_older=1; fi
    done
    if [ "''${FAIL_STARTUP_DELETE:-0}" = 1 ] && [ "$only_newer" = 1 ]; then exit 75; fi
    if [ "''${FAIL_PRUNE_DELETE:-0}" = 1 ] && [ "$any_older" = 1 ]; then exit 75; fi
    for generation in "$@"; do rm -f "$profile-$generation-link"; done
    grep -vxF -f <(printf '%s\n' "$@") "$GENERATIONS" > "$GENERATIONS.tmp" || true
    mv "$GENERATIONS.tmp" "$GENERATIONS"
    ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "$PWD/bin/systemctl" "$PWD/bin/curl" "$PWD/bin/sleep" "$PWD/bin/mv" "$PWD/bin/nix-env"
  export PATH="$PWD/bin:$PATH"
  export ACTIVATOR_LOG="$log" CURL_LOG="$PWD/curl.log" NIX_ENV_LOG="$PWD/nix-env.log"
  export PROFILE="$profile" START_LIMIT="$PWD/start-limit" GENERATIONS="$PWD/generations"
  export LIST_CALLS="$PWD/list-calls" CANDIDATE_RESET_MARKER="$PWD/candidate-reset-once"
  export MISSING_PROFILE_RECOVERY_MARKER="$PWD/missing-profile-recovery-failed"
  export SUCCESS_MARKER="$state/last-success"
  export SUCCESS_MOVE_SIGNAL_SENT="$PWD/success-move-signal-sent"
  export SUCCESS_MOVE_FAILURE_TRIGGERED="$PWD/success-move-failure-triggered"
  export RESET_CANDIDATE=${v4} RECOVERY_PATH=${v1} CRASHING=${v2} UNHEALTHY=${v3}

  reset_observations() {
    : > "$ACTIVATOR_LOG"
    : > "$CURL_LOG"
    : > "$NIX_ENV_LOG"
    : > "$LIST_CALLS"
    rm -f "$START_LIMIT" "$CANDIDATE_RESET_MARKER" "$MISSING_PROFILE_RECOVERY_MARKER" "$SUCCESS_MOVE_SIGNAL_SENT" "$SUCCESS_MOVE_FAILURE_TRIGGERED"
    export CANDIDATE_RESET_FAILURE=0 RECOVERY_FAILURE=0 FAIL_STARTUP_DELETE=0 FAIL_PRUNE_DELETE=0
    export MISSING_PROFILE_RECOVERY_FAILURE=0
    export SIGNAL_AFTER_SUCCESS_MOVE=0 FAIL_SUCCESS_MARKER_MOVE=0
    unset LIST_FAIL_AT
  }
  reset_fixture() {
    rm -rf "$state"
    rm -f "$profile" "$profile"-*-link "$GENERATIONS"
    mkdir -p "$state"
    : > "$GENERATIONS"
    reset_observations
  }
  seed_generation() {
    generation=$1 package_path=$2 current=$3
    ln -sfn "$package_path" "$profile-$generation-link"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    [ "$current" != current ] || ln -sfn "$profile-$generation-link" "$profile"
  }
  seed_old_success() {
    reset_fixture
    seed_generation 1 ${v1} current
    cat > "$state/last-success" <<EOF
rev=1111111111111111111111111111111111111111
path=${v1}
previous_path=none
previous_generation=none
EOF
  }
  generation_links() {
    find "$PWD" -maxdepth 1 -name 'profile-*-link' | wc -l
  }
  count_operation() {
    grep -c "^$1" "$NIX_ENV_LOG" || true
  }
  assert_operations() {
    expected=$1 actual=$(cat "$NIX_ENV_LOG")
    if [ "$actual" != "$expected" ]; then
      printf 'unexpected nix-env operations\nexpected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
      return 1
    fi
  }
  run() { bash ${script} "$@" "$state" "$profile" house-automationd.service http://127.0.0.1:9876/healthz; }

  # An unreadable initial generation snapshot fails before profile mutation.
  reset_fixture
  export LIST_FAIL_AT=1
  if run ${v1} 1111111111111111111111111111111111111111 2> "$PWD/initial-list.err"; then exit 1; fi
  grep -qxF 'activate-app: could not list profile generations' "$PWD/initial-list.err"
  assert_operations '--list-generations'
  [ "$(count_operation --set)" -eq 0 ]
  [ ! -e "$profile" ]
  [ ! -s "$GENERATIONS" ]

  # A healthy first activation records success and allocates one generation.
  reset_fixture
  run ${v1} 1111111111111111111111111111111111111111
  [ "$(readlink -f "$profile")" = "${v1}" ]
  [ "$(generation_links)" -eq 1 ]
  grep -qxF 'rev=1111111111111111111111111111111111111111' "$state/last-success"

  # Candidate restart failure clears a start limit and rolls back exactly.
  seed_old_success
  touch "$START_LIMIT"
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  [ "$(readlink -f "$profile")" = "${v1}" ]
  grep -qxF 'reason=candidate-restart-failed' "$state/last-failure"
  grep -qxF 'previous_generation=1' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ ! -e "$START_LIMIT" ]
  [ "$(cat "$ACTIVATOR_LOG")" = "systemctl reset-failed house-automationd.service
systemctl restart house-automationd.service
systemctl reset-failed house-automationd.service
systemctl restart house-automationd.service" ]
  [ "$(generation_links)" -eq 1 ]

  # A failed health check performs all retries, then verifies the restored app.
  seed_old_success
  if run ${v3} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink -f "$profile")" = "${v1}" ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ "$(wc -l < "$CURL_LOG")" -eq 31 ]

  # Reset failure is classified separately and never reaches candidate health.
  seed_old_success
  export CANDIDATE_RESET_FAILURE=1
  if run ${v4} 4444444444444444444444444444444444444444; then exit 1; fi
  [ "$(readlink -f "$profile")" = "${v1}" ]
  grep -qxF 'reason=candidate-reset-failed' "$state/last-failure"
  ! grep -qF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"

  # Failure to restart the restored service retains the candidate as a root.
  seed_old_success
  export RECOVERY_FAILURE=1
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  [ "$(readlink -f "$profile")" = "${v1}" ]
  grep -qxF 'rollback=incomplete' "$state/last-failure"
  [ -e "$profile-2-link" ]
  [ "$(generation_links)" -eq 2 ]

  # Three healthy releases retain exactly the current and previous generation.
  reset_fixture
  run ${v1} 1111111111111111111111111111111111111111
  run ${v4} 4444444444444444444444444444444444444444
  run ${v5} 5555555555555555555555555555555555555555
  [ "$(readlink -f "$profile")" = "${v5}" ]
  [ "$(generation_links)" -eq 2 ]
  [ ! -e "$profile-1-link" ]

  # The third snapshot is post-health pruning. If it cannot be read, the
  # healthy candidate is rolled back and last-success remains unchanged.
  seed_old_success
  success_before=$(cat "$state/last-success")
  export LIST_FAIL_AT=3
  if run ${v4} 4444444444444444444444444444444444444444; then exit 1; fi
  [ "$(cat "$LIST_CALLS")" -eq 4 ]
  assert_operations "--list-generations
--list-generations
--set ${v4}
--list-generations
--switch-generation 1
--list-generations
--delete-generations 2"
  [ "$(cat "$ACTIVATOR_LOG")" = "systemctl reset-failed house-automationd.service
systemctl restart house-automationd.service
systemctl reset-failed house-automationd.service
systemctl restart house-automationd.service" ]
  [ "$(wc -l < "$CURL_LOG")" -eq 2 ]
  [ "$(readlink -f "$profile")" = "${v1}" ]
  [ "$(cat "$state/last-success")" = "$success_before" ]
  grep -qxF 'reason=generation-pruning-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ "$(generation_links)" -eq 1 ]

  # If rollback cannot list generations after restoring the old link, it is
  # incomplete and deliberately keeps the failed candidate as a recovery root.
  seed_old_success
  export LIST_FAIL_AT=3
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  [ "$(cat "$LIST_CALLS")" -eq 3 ]
  assert_operations "--list-generations
--list-generations
--set ${v2}
--switch-generation 1
--list-generations"
  [ "$(readlink -f "$profile")" = "${v1}" ]
  [ -e "$profile-2-link" ]
  [ "$(generation_links)" -eq 2 ]
  grep -qxF 'reason=candidate-restart-failed' "$state/last-failure"
  grep -qxF 'rollback=incomplete' "$state/last-failure"

  # Repeated incomplete rollbacks first delete the previous non-current
  # candidate. Each attempt therefore retains only old current + one candidate.
  for retry in 1 2; do
    reset_observations
    export LIST_FAIL_AT=3
    if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
    assert_operations "--list-generations
--delete-generations 2
--list-generations
--set ${v2}
--switch-generation 1
--list-generations"
    [ "$(cat "$LIST_CALLS")" -eq 3 ]
    [ "$(readlink -f "$profile")" = "${v1}" ]
    [ -e "$profile-2-link" ]
    [ "$(generation_links)" -eq 2 ]
    [ "$(tail -n1 "$GENERATIONS")" -eq 2 ]
    grep -qxF 'rollback=incomplete' "$state/last-failure"
  done

  # Failure deleting that stale candidate is fail-closed before --set. The
  # old current link, recovery root, generation file, and markers are retained.
  generations_before=$(cat "$GENERATIONS")
  failure_before=$(cat "$state/last-failure")
  success_before=$(cat "$state/last-success")
  reset_observations
  export FAIL_STARTUP_DELETE=1
  if run ${v4} 4444444444444444444444444444444444444444 2> "$PWD/stale-cleanup.err"; then exit 1; fi
  grep -qxF 'activate-app: could not remove incomplete candidate generations' "$PWD/stale-cleanup.err"
  assert_operations "--list-generations
--delete-generations 2"
  [ "$(count_operation --set)" -eq 0 ]
  [ "$(cat "$LIST_CALLS")" -eq 1 ]
  [ "$(readlink -f "$profile")" = "${v1}" ]
  [ -e "$profile-2-link" ]
  [ "$(generation_links)" -eq 2 ]
  [ "$(cat "$GENERATIONS")" = "$generations_before" ]
  [ "$(cat "$state/last-failure")" = "$failure_before" ]
  [ "$(cat "$state/last-success")" = "$success_before" ]

  # An incomplete first activation has no old profile to restart. Its orphaned
  # candidate is the entire generation snapshot, so retries must delete it
  # before allocating a replacement instead of leaking another root each time.
  reset_fixture
  export MISSING_PROFILE_RECOVERY_FAILURE=1
  if run ${v3} 3333333333333333333333333333333333333333; then exit 1; fi
  [ -e "$MISSING_PROFILE_RECOVERY_MARKER" ]
  [ ! -e "$profile" ]
  [ -e "$profile-1-link" ]
  [ "$(generation_links)" -eq 1 ]
  grep -qxF 'rollback=incomplete' "$state/last-failure"
  for retry in 1 2; do
    reset_observations
    export MISSING_PROFILE_RECOVERY_FAILURE=1
    if run ${v3} 3333333333333333333333333333333333333333; then exit 1; fi
    [ -e "$MISSING_PROFILE_RECOVERY_MARKER" ]
    assert_operations "--list-generations
--delete-generations 1
--list-generations
--set ${v3}"
    [ ! -e "$profile" ]
    [ -e "$profile-1-link" ]
    [ "$(generation_links)" -eq 1 ]
    [ "$(cat "$GENERATIONS")" = 1 ]
    grep -qxF 'rollback=incomplete' "$state/last-failure"
  done

  # A delete failure while pruning is distinct from startup cleanup: rollback
  # can delete the new generation and leaves the two pre-existing roots intact.
  reset_fixture
  run ${v1} 1111111111111111111111111111111111111111
  run ${v4} 4444444444444444444444444444444444444444
  success_before=$(cat "$state/last-success")
  reset_observations
  export FAIL_PRUNE_DELETE=1
  if run ${v5} 5555555555555555555555555555555555555555; then exit 1; fi
  [ "$(readlink -f "$profile")" = "${v4}" ]
  [ "$(cat "$state/last-success")" = "$success_before" ]
  grep -qxF 'reason=generation-pruning-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ -e "$profile-1-link" ]
  [ -e "$profile-2-link" ]
  [ ! -e "$profile-3-link" ]
  [ "$(generation_links)" -eq 2 ]

  # A signal delivered immediately after the atomic success-marker rename is
  # ignored inside the commit window. Both durable state and profile stay on
  # the candidate, and the activation itself reports success.
  seed_old_success
  export SIGNAL_AFTER_SUCCESS_MOVE=1
  run ${v4} 4444444444444444444444444444444444444444
  [ -e "$SUCCESS_MOVE_SIGNAL_SENT" ]
  success_revision=$(sed -n 's/^rev=//p' "$state/last-success")
  success_path=$(sed -n 's/^path=//p' "$state/last-success")
  [ "$success_revision" = 4444444444444444444444444444444444444444 ]
  [ "$success_path" = "${v4}" ]
  [ "$(readlink -f "$profile")" = "${v4}" ]
  [ "$(generation_links)" -eq 2 ]
  [ ! -e "$state/last-failure" ]

  # A failed final success-marker move restores the failure trap. The normal
  # rollback path returns to the old generation without changing last-success.
  seed_old_success
  success_before=$(cat "$state/last-success")
  export FAIL_SUCCESS_MARKER_MOVE=1
  if run ${v4} 4444444444444444444444444444444444444444; then exit 1; fi
  [ -e "$SUCCESS_MOVE_FAILURE_TRIGGERED" ]
  [ "$(readlink -f "$profile")" = "${v1}" ]
  [ "$(cat "$state/last-success")" = "$success_before" ]
  grep -qxF 'reason=success-marker-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ "$(generation_links)" -eq 1 ]

  touch "$out"
''
