#!/usr/bin/env bash
set -euo pipefail
set -f
umask 077

die() { printf 'activate-system:' >&2; printf ' %s' "$@" >&2; printf '\n' >&2; exit 1; }
mode=activate
health_units=()
if [ "$#" -ge 4 ] && [ "$1" = --recover ]; then
  mode=recover
  state_dir=$2 profile=$3 current_system=$4
  health_units=("${@:5}")
elif [ "$#" -ge 5 ]; then
  system_path=$1 revision=$2 state_dir=$3 profile=$4 current_system=$5
  health_units=("${@:6}")
else
  die 'usage: SYSTEM REVISION STATE PROFILE CURRENT_SYSTEM [UNIT...] | --recover STATE PROFILE CURRENT_SYSTEM [UNIT...]'
fi
store_dir=${NIX_STORE_DIR:-/nix/store}
store_dir=${store_dir%/}
mkdir -p "$state_dir" "$(dirname "$profile")"
chmod 0700 "$state_dir"

is_system_path() {
  local path=$1
  [[ "$path" =~ ^$store_dir/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] &&
    [ -x "$path/bin/switch-to-configuration" ]
}

write_marker() {
  local name=$1 contents=$2 tmp
  tmp=$(mktemp "$state_dir/.${name}.XXXXXXXX") || return 1
  printf '%s' "$contents" > "$tmp" && chmod 0600 "$tmp" && mv -f "$tmp" "$state_dir/$name"
}

switch_system() {
  local path=$1 status=0
  timeout --signal=KILL 120s "$path/bin/switch-to-configuration" switch || status=$?
  return "$status"
}

# Short probes bound both candidate validation and TERM-triggered recovery.
health_check() {
  local expected=$1 attempt consecutive=0 status running unit unit_status units_healthy
  for attempt in $(seq 1 6); do
    status=0
    timeout --signal=KILL 1s systemctl is-system-running || status=$?
    running=$(readlink -f "$current_system" 2>/dev/null || true)
    units_healthy=1
    for unit in "${health_units[@]}"; do
      unit_status=0
      timeout --signal=KILL 1s systemctl is-active --quiet "$unit" || unit_status=$?
      [ "$unit_status" -eq 0 ] || units_healthy=0
    done
    if [ "$status" -eq 0 ] && [ "$running" = "$expected" ] && [ "$units_healthy" -eq 1 ]; then
      consecutive=$((consecutive + 1))
      [ "$consecutive" -lt 3 ] || return 0
    else
      consecutive=0
    fi
    [ "$attempt" -eq 6 ] || sleep 1
  done
  return 1
}

list_generations() {
  nix-env --profile "$profile" --list-generations
}

delete_generations_newer_than() {
  local keep=$1 generations_output line generation
  local -a remove=()
  generations_output=$(list_generations) || return 1
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] || continue
    if [ "$keep" = none ] || [ "$generation" -gt "$keep" ]; then
      remove+=("$generation")
    fi
  done <<< "$generations_output"
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

recover_pending() {
  local pending="$state_dir/pending-activation" key value
  local pending_old_path= pending_old_generation=
  [ -s "$pending" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      previous_path) pending_old_path=$value ;;
      previous_generation) pending_old_generation=$value ;;
    esac
  done < "$pending"
  [ -n "$pending_old_path" ] && [ -n "$pending_old_generation" ] || return 1
  if [ "$pending_old_path" = none ] && [ "$pending_old_generation" = none ]; then
    rm -f "$profile" || return 1
    delete_generations_newer_than none || return 1
    rm -f "$pending"
    return 0
  fi
  is_system_path "$pending_old_path" || return 1
  [[ "$pending_old_generation" =~ ^[0-9]+$ ]] || return 1
  nix-env --profile "$profile" --switch-generation "$pending_old_generation" >/dev/null || return 1
  systemctl reset-failed || return 1
  switch_system "$pending_old_path" || return 1
  health_check "$pending_old_path" || return 1
  delete_generations_newer_than "$pending_old_generation" || return 1
  rm -f "$pending"
}

if [ "$mode" = recover ]; then
  trap '' HUP INT TERM
  recover_pending || die 'interrupted activation recovery failed'
  exit 0
fi

is_system_path "$system_path" || die 'invalid system path or missing bin/switch-to-configuration'
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die 'invalid revision'
trap '' HUP INT TERM
recover_pending || die 'interrupted activation recovery failed'
trap - HUP INT TERM

old_path=none old_generation=
declare -a original_generations=()
capture_generations() {
  local generations_output line generation
  generations_output=$(list_generations) || return 1
  original_generations=()
  old_generation=
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] || continue
    original_generations+=("$generation")
    [[ "$line" == *'(current)'* ]] && old_generation=$generation
  done <<< "$generations_output"
  return 0
}
capture_generations || die 'could not list profile generations'
if [ -e "$profile" ] || [ -L "$profile" ]; then
  old_path=$(readlink -f "$profile") || die 'could not resolve profile'
  [ -n "$old_generation" ] || die 'profile has no active generation'
  is_system_path "$old_path" || die 'active system has no executable bin/switch-to-configuration'
  [ "$(readlink -f "$current_system" 2>/dev/null || true)" = "$old_path" ] || \
    die 'active profile does not match running system'
fi

# A pending journal is the only proof that a newer non-current generation was
# allocated by an interrupted auto-deploy. Without one, Nix's topology means an
# operator selected an older generation and that rollback must be preserved.
for generation in "${original_generations[@]}"; do
  if [ -n "$old_generation" ] && [ "$generation" -gt "$old_generation" ]; then
    die 'active generation is older than newest generation; refusing manual rollback'
  fi
done

remove_new_generations() {
  local generations_output line generation original known
  local -a remove=()
  generations_output=$(list_generations) || return 1
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] || continue
    known=0
    for original in "${original_generations[@]}"; do
      [ "$generation" = "$original" ] && known=1
    done
    [ "$known" -eq 1 ] || remove+=("$generation")
  done <<< "$generations_output"
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

prune_generations() {
  local generations_output sorted_output line generation index
  local -a all=() remove=()
  generations_output=$(list_generations) || return 1
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] && all+=("$generation")
  done <<< "$generations_output"
  sorted_output=$(printf '%s\n' "${all[@]}" | sort -n) || return 1
  mapfile -t all <<< "$sorted_output"
  for ((index = 0; index + 2 < ${#all[@]}; index++)); do
    remove+=("${all[$index]}")
  done
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

rollback() {
  if [ "$old_path" = none ]; then
    rm -f "$profile" || return 1
    return 1
  fi
  nix-env --profile "$profile" --switch-generation "$old_generation" >/dev/null || return 1
  systemctl reset-failed || return 1
  switch_system "$old_path" || return 1
  health_check "$old_path" || return 1
  remove_new_generations || return 1
}

fail() {
  local reason=$1 rollback_state=complete
  trap '' HUP INT TERM
  rollback || rollback_state=incomplete
  write_marker last-failure "rev=$revision
path=$system_path
previous_path=$old_path
previous_generation=${old_generation:-none}
reason=$reason
rollback=$rollback_state
" || true
  if [ "$rollback_state" = complete ]; then
    rm -f "$state_dir/pending-activation"
  fi
  exit 1
}

# This journal is the future last-success marker. Its atomic rename is the only
# commit point, so any pre-commit crash is distinguishable from operator drift.
write_marker pending-activation "rev=$revision
path=$system_path
previous_path=$old_path
previous_generation=${old_generation:-none}
" || die 'could not record pending activation'
trap 'fail received-signal' HUP INT TERM
nix-env --profile "$profile" --set "$system_path" >/dev/null || fail profile-switch-failed
systemctl reset-failed || fail candidate-reset-failed
switch_status=0
switch_system "$system_path" || switch_status=$?
case "$switch_status" in
  0) ;;
  124|137) fail candidate-switch-timeout ;;
  *) fail candidate-switch-failed ;;
esac
health_check "$system_path" || fail candidate-health-failed
prune_generations || fail generation-pruning-failed
trap '' HUP INT TERM
mv -f "$state_dir/pending-activation" "$state_dir/last-success" || {
  trap 'fail received-signal' HUP INT TERM
  fail success-marker-failed
}
trap - HUP INT TERM
