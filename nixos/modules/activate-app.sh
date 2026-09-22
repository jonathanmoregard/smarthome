#!/usr/bin/env bash
set -euo pipefail
set -f
umask 077

die() { printf 'activate-app:' >&2; printf ' %s' "$@" >&2; printf '\n' >&2; exit 1; }
[ "$#" -eq 6 ] || die 'usage: PACKAGE REVISION STATE PROFILE SERVICE HEALTH_URL'
package_path=$1 revision=$2 state_dir=$3 profile=$4 service=$5 health_url=$6
store_dir=${NIX_STORE_DIR:-/nix/store}
store_dir=${store_dir%/}
[[ "$package_path" =~ ^$store_dir/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || die 'invalid package path'
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die 'invalid revision'
[ -x "$package_path/bin/house-automationd" ] || die 'package has no executable bin/house-automationd'
[ "$service" = - ] || { [ "$health_url" != - ] && [[ "$health_url" == http://* || "$health_url" == https://* ]]; } || die 'service and health URL must be paired'
mkdir -p "$state_dir" "$(dirname "$profile")"
chmod 0700 "$state_dir"

old_path=none old_generation=
declare -a original_generations=()
while IFS= read -r line; do
  read -r generation _ <<< "$line"
  [[ "$generation" =~ ^[0-9]+$ ]] || continue
  original_generations+=("$generation")
  [[ "$line" == *'(current)'* ]] && old_generation=$generation
done < <(nix-env --profile "$profile" --list-generations)
if [ -e "$profile" ] || [ -L "$profile" ]; then
  old_path=$(readlink -f "$profile") || die 'could not resolve profile'
  [ -n "$old_generation" ] || die 'profile has no active generation'
fi

write_marker() {
  local name=$1 contents=$2 tmp
  tmp=$(mktemp "$state_dir/.${name}.XXXXXXXX") || return 1
  printf '%s' "$contents" > "$tmp" && chmod 0600 "$tmp" && mv -f "$tmp" "$state_dir/$name"
}

health_check() {
  local attempt
  [ "$service" = - ] && return 0
  for attempt in $(seq 1 30); do
    curl --fail --silent --show-error "$health_url" >/dev/null && return 0
    [ "$attempt" -eq 30 ] || sleep 1
  done
  return 1
}

remove_new_generations() {
  local line generation original known
  local -a remove=()
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] || continue
    known=0
    for original in "${original_generations[@]}"; do [ "$generation" = "$original" ] && known=1; done
    [ "$known" -eq 1 ] || remove+=("$generation")
  done < <(nix-env --profile "$profile" --list-generations)
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

prune_generations() {
  local line generation index
  local -a all=() remove=()
  while IFS= read -r line; do
    read -r generation _ <<< "$line"
    [[ "$generation" =~ ^[0-9]+$ ]] && all+=("$generation")
  done < <(nix-env --profile "$profile" --list-generations)
  mapfile -t all < <(printf '%s\n' "${all[@]}" | sort -n)
  for ((index = 0; index + 2 < ${#all[@]}; index++)); do remove+=("${all[$index]}"); done
  [ "${#remove[@]}" -eq 0 ] || nix-env --profile "$profile" --delete-generations "${remove[@]}" >/dev/null
}

rollback() {
  if [ "$old_path" = none ]; then rm -f "$profile"; else nix-env --profile "$profile" --switch-generation "$old_generation" >/dev/null; fi
  if [ "$service" != - ]; then
    systemctl reset-failed "$service"
    systemctl restart "$service"
    health_check
  fi
  remove_new_generations
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
  exit 1
}
trap 'fail received-signal' HUP INT TERM
nix-env --profile "$profile" --set "$package_path" >/dev/null || fail profile-switch-failed
if [ "$service" != - ]; then systemctl restart "$service" && health_check || fail service-restart-or-health-failed; fi
write_marker last-success "rev=$revision
path=$package_path
previous_path=$old_path
previous_generation=${old_generation:-none}
" || fail success-marker-failed
trap - HUP INT TERM
prune_generations || die 'successful release pruning failed'
