#!/usr/bin/env bash
set -euo pipefail
set -f
umask 077

die() { printf 'activate-app:' >&2; printf ' %s' "$@" >&2; printf '\n' >&2; exit 1; }
mode=activate
if [ "${1:-}" = --recover ]; then
  [ "$#" -eq 6 ] || die 'usage: --recover STATE PROFILE SERVICE HEALTH_URL ROLLBACK_DATABASE'
  mode=recover state_dir=$2 profile=$3 service=$4 health_url=$5 database=$6
  package_path= revision=
else
  [ "$#" -eq 7 ] || die 'usage: PACKAGE REVISION STATE PROFILE SERVICE HEALTH_URL ROLLBACK_DATABASE'
  package_path=$1 revision=$2 state_dir=$3 profile=$4 service=$5 health_url=$6 database=$7
fi
store_dir=${NIX_STORE_DIR:-/nix/store}
store_dir=${store_dir%/}
if [ "$mode" = activate ]; then
  [[ "$package_path" =~ ^$store_dir/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || die 'invalid package path'
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die 'invalid revision'
  [ -x "$package_path/bin/house-automationd" ] || die 'package has no executable bin/house-automationd'
fi
if [ "$service" = - ]; then
  [ "$health_url" = - ] && [ "$database" = - ] || die 'service, health URL, and rollback database must be configured together'
else
  [ "$health_url" != - ] && [[ "$health_url" == http://* || "$health_url" == https://* ]] || die 'invalid health URL'
  [[ "$database" == /* ]] && [[ "$database" != *$'\n'* ]] || die 'invalid rollback database path'
fi
mkdir -p "$state_dir" "$(dirname "$profile")"
chmod 0700 "$state_dir"
database_backup="$state_dir/rollback-database.sqlite3"

write_marker() {
  local name=$1 contents=$2 tmp
  tmp=$(mktemp "$state_dir/.${name}.XXXXXXXX") || return 1
  printf '%s' "$contents" > "$tmp" && chmod 0600 "$tmp" && mv -f "$tmp" "$state_dir/$name"
}

health_check() {
  local attempt
  [ "$service" = - ] && return 0
  for attempt in $(seq 1 30); do
    curl --connect-timeout 2 --max-time 2 --fail --silent --show-error "$health_url" >/dev/null && return 0
    [ "$attempt" -eq 30 ] || sleep 1
  done
  return 1
}

delete_generations_newer_than() {
  local keep=$1 generations_output line generation
  local -a remove=()
  generations_output=$(nix-env --profile "$profile" --list-generations) || return 1
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] || continue
    if [ "$keep" = none ] || [ "$generation" -gt "$keep" ]; then
      remove+=("$generation")
    fi
  done <<< "$generations_output"
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

restore_database() {
  local phase=$1 existed=$2 backup=$3 owner=$4 group=$5 mode_bits=$6
  local database_dir restore_tmp
  [ "$service" != - ] || return 0
  [ "$phase" = candidate ] || return 0
  database_dir=$(dirname "$database")
  [ ! -L "$database" ] || return 1
  if [ "$existed" = no ]; then
    rm -f "$database" "$database-wal" "$database-shm" || return 1
    sync -f "$database_dir" || return 1
    return 0
  fi
  [ "$existed" = yes ] && [ "$backup" = "$database_backup" ] && [ -f "$backup" ] && [ ! -L "$backup" ] || return 1
  [[ "$owner" =~ ^[0-9]+$ ]] && [[ "$group" =~ ^[0-9]+$ ]] && [[ "$mode_bits" =~ ^[0-7]{3,4}$ ]] || return 1
  restore_tmp=$(mktemp "$database_dir/.state.sqlite3.restore.XXXXXXXX") || return 1
  install -o "$owner" -g "$group" -m "$mode_bits" "$backup" "$restore_tmp" || { rm -f "$restore_tmp"; return 1; }
  sync -f "$restore_tmp" || { rm -f "$restore_tmp"; return 1; }
  rm -f "$database-wal" "$database-shm" || { rm -f "$restore_tmp"; return 1; }
  mv -f "$restore_tmp" "$database" || { rm -f "$restore_tmp"; return 1; }
  sync -f "$database" || return 1
  sync -f "$database_dir" || return 1
}

recover_pending() {
  local pending="$state_dir/pending-activation" key value
  local pending_phase= pending_old_path= pending_old_generation=
  local pending_database= pending_database_existed= pending_backup=
  local pending_owner= pending_group= pending_mode=
  [ -s "$pending" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      phase) pending_phase=$value ;;
      previous_path) pending_old_path=$value ;;
      previous_generation) pending_old_generation=$value ;;
      database_path) pending_database=$value ;;
      database_existed) pending_database_existed=$value ;;
      database_backup) pending_backup=$value ;;
      database_owner) pending_owner=$value ;;
      database_group) pending_group=$value ;;
      database_mode) pending_mode=$value ;;
    esac
  done < "$pending"
  case "$pending_phase" in pre-switch|switched|candidate) ;; *) return 1 ;; esac
  [ -n "$pending_old_path" ] && [ -n "$pending_old_generation" ] || return 1
  if [ "$service" = - ]; then
    [ "$pending_database" = - ] && [ "$pending_database_existed" = no ] && [ "$pending_backup" = none ] || return 1
  else
    [ "$pending_database" = "$database" ] || return 1
    case "$pending_database_existed" in yes|no) ;; *) return 1 ;; esac
    systemctl stop "$service" || return 1
  fi
  if [ "$pending_old_path" = none ] && [ "$pending_old_generation" = none ]; then
    restore_database "$pending_phase" "$pending_database_existed" "$pending_backup" "$pending_owner" "$pending_group" "$pending_mode" || return 1
    rm -f "$profile" || return 1
    delete_generations_newer_than none || return 1
    rm -f "$pending" "$database_backup"
    return 0
  fi
  [[ "$pending_old_path" =~ ^$store_dir/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || return 1
  [ -x "$pending_old_path/bin/house-automationd" ] || return 1
  [[ "$pending_old_generation" =~ ^[0-9]+$ ]] || return 1
  restore_database "$pending_phase" "$pending_database_existed" "$pending_backup" "$pending_owner" "$pending_group" "$pending_mode" || return 1
  nix-env --profile "$profile" --switch-generation "$pending_old_generation" >/dev/null || return 1
  if [ "$service" != - ]; then
    systemctl reset-failed "$service" || return 1
    systemctl restart "$service" || return 1
    health_check || return 1
  fi
  delete_generations_newer_than "$pending_old_generation" || return 1
  rm -f "$pending" "$database_backup"
}

trap '' HUP INT TERM
recover_pending || die 'interrupted activation recovery failed'
if [ "$mode" = recover ]; then exit 0; fi
trap - HUP INT TERM
rm -f "$database_backup"

old_path=none old_generation=
declare -a original_generations=()
capture_generations() {
  local generations_output line generation
  generations_output=$(nix-env --profile "$profile" --list-generations) || return 1
  original_generations=(); old_generation=
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
fi

# Legacy interrupted activations predate the pending journal. The deployer
# prevents this cleanup from overwriting an operator-selected generation.
stale_generations=()
for generation in "${original_generations[@]}"; do
  if [ -z "$old_generation" ] || [ "$generation" -gt "$old_generation" ]; then
    stale_generations+=("$generation")
  fi
done
[ "${#stale_generations[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${stale_generations[@]}" >/dev/null || die 'could not remove incomplete candidate generations'
capture_generations || die 'could not list profile generations after incomplete cleanup'

remove_new_generations() {
  local generations_output line generation original known
  local -a remove=()
  generations_output=$(nix-env --profile "$profile" --list-generations) || return 1
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] || continue
    known=0
    for original in "${original_generations[@]}"; do [ "$generation" = "$original" ] && known=1; done
    [ "$known" -eq 1 ] || remove+=("$generation")
  done <<< "$generations_output"
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

prune_generations() {
  local generations_output line generation index
  local -a all=() remove=()
  generations_output=$(nix-env --profile "$profile" --list-generations) || return 1
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] && all+=("$generation")
  done <<< "$generations_output"
  mapfile -t all < <(printf '%s\n' "${all[@]}" | sort -n)
  for ((index = 0; index + 2 < ${#all[@]}; index++)); do remove+=("${all[$index]}"); done
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

database_existed=no database_owner=none database_group=none database_mode=none
if [ "$service" != - ] && { [ -e "$database" ] || [ -L "$database" ]; }; then
  [ -f "$database" ] && [ ! -L "$database" ] || die 'rollback database is not an ordinary file'
  [ "$old_path" != none ] && [ -x "$old_path/bin/house-automationd" ] || die 'rollback database exists without an active backup-capable app'
  database_existed=yes
  database_owner=$(stat -c %u "$database") || die 'could not read rollback database owner'
  database_group=$(stat -c %g "$database") || die 'could not read rollback database group'
  database_mode=$(stat -c %a "$database") || die 'could not read rollback database mode'
fi

phase=pre-switch
write_pending() {
  phase=$1
  local backup=none
  [ "$database_existed" = no ] || backup=$database_backup
  write_marker pending-activation "rev=$revision
path=$package_path
previous_path=$old_path
previous_generation=${old_generation:-none}
phase=$phase
database_path=$database
database_existed=$database_existed
database_backup=$backup
database_owner=$database_owner
database_group=$database_group
database_mode=$database_mode
"
}

rollback() {
  if [ "$service" != - ]; then systemctl stop "$service" || return 1; fi
  if [ "$old_path" = none ]; then
    rm -f "$profile" || return 1
    restore_database "$phase" "$database_existed" "$([ "$database_existed" = yes ] && printf '%s' "$database_backup" || printf none)" "$database_owner" "$database_group" "$database_mode" || return 1
  else
    restore_database "$phase" "$database_existed" "$([ "$database_existed" = yes ] && printf '%s' "$database_backup" || printf none)" "$database_owner" "$database_group" "$database_mode" || return 1
    nix-env --profile "$profile" --switch-generation "$old_generation" >/dev/null || return 1
  fi
  if [ "$old_path" = none ]; then
    remove_new_generations || return 1
    return 1
  fi
  if [ "$service" != - ]; then
    systemctl reset-failed "$service" || return 1
    systemctl restart "$service" || return 1
    health_check || return 1
  fi
  remove_new_generations || return 1
  rm -f "$database_backup"
}

fail() {
  local reason=$1 rollback_state=complete
  trap '' HUP INT TERM
  rollback || rollback_state=incomplete
  write_marker last-failure "rev=$revision
path=$package_path
previous_path=$old_path
previous_generation=${old_generation:-none}
reason=$reason
rollback=$rollback_state
" || true
  if [ "$rollback_state" = complete ]; then rm -f "$state_dir/pending-activation" "$database_backup"; fi
  exit 1
}

# The journal is written before quiescing the old app. Any pre-commit crash is
# therefore recoverable without mistaking the candidate profile for operator
# drift. The phase records whether the candidate could have touched SQLite.
write_pending pre-switch || die 'could not record pending activation'
trap 'fail received-signal' HUP INT TERM
if [ "$service" != - ] && [ "$old_path" != none ]; then
  systemctl stop "$service" || fail previous-stop-failed
  if [ "$database_existed" = yes ]; then
    "$old_path/bin/house-automationd" backup --database "$database" --destination "$database_backup" || fail database-backup-failed
    [ -f "$database_backup" ] && [ ! -L "$database_backup" ] || fail database-backup-failed
    chmod 0600 "$database_backup" || fail database-backup-failed
    sync -f "$database_backup" || fail database-backup-failed
    sync -f "$state_dir" || fail database-backup-failed
  fi
fi
nix-env --profile "$profile" --set "$package_path" >/dev/null || fail profile-switch-failed
write_pending switched || fail journal-update-failed
if [ "$service" != - ]; then
  systemctl reset-failed "$service" || fail candidate-reset-failed
  write_pending candidate || fail journal-update-failed
  systemctl restart "$service" || fail candidate-restart-failed
  health_check || fail candidate-health-failed
fi
prune_generations || fail generation-pruning-failed
trap '' HUP INT TERM
mv -f "$state_dir/pending-activation" "$state_dir/last-success" || {
  trap 'fail received-signal' HUP INT TERM
  fail success-marker-failed
}
rm -f "$database_backup"
trap - HUP INT TERM
