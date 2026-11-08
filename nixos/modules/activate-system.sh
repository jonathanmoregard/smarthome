#!/usr/bin/env bash
set -euo pipefail
set -f
umask 077

die() { printf 'activate-system:' >&2; printf ' %s' "$@" >&2; printf '\n' >&2; exit 1; }
mode=activate
candidate_health_units=()
recovery_health_units=()
recovery_health_unit_groups=()
baseline_exempt=()
# The health window is an input, not a constant buried in the probe loop: a
# unit that execs and only then dies on its own configuration is invisible
# until the probe outlives its start-up, and every second of window is a second
# added to every deploy.
#
# The two numbers buy different things and only one of them is a guarantee.
# health_stable is the floor, and the whole of the detection budget: the probe
# returns the moment the streak reaches it, so 10 samples at 1s means 10s of
# continuous observation and 10s of waiting on every healthy deploy.
# health_samples is only a ceiling on how long a candidate that stumbles may
# keep trying -- a candidate that never stumbles exits at the floor, so one
# that dies 12s in is not caught by a 20-sample window. Buying more detection
# means raising --health-stable, and paying for it on every deploy; raising
# --health-samples alone only buys patience with a flapping candidate.
health_samples=20
health_stable=10
if [ "$#" -ge 4 ] && [ "$1" = --recover ]; then
  mode=recover
  state_dir=$2 profile=$3 current_system=$4
  shift 4
elif [ "$#" -ge 5 ]; then
  system_path=$1 revision=$2 state_dir=$3 profile=$4 current_system=$5
  shift 5
else
  die 'usage: SYSTEM REVISION STATE PROFILE CURRENT_SYSTEM [HEALTH_ARG...] | --recover STATE PROFILE CURRENT_SYSTEM [HEALTH_ARG...]'
fi
valid_unit() { [[ "$1" =~ ^[A-Za-z0-9@_.:-]+[.](service|timer)$ ]]; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit)
      [ "$#" -ge 2 ] && valid_unit "$2" || die 'invalid required health unit'
      candidate_health_units+=("$2")
      shift 2
      ;;
    --recovery-unit)
      [ "$#" -ge 2 ] && valid_unit "$2" || die 'invalid required recovery health unit'
      recovery_health_units+=("$2")
      shift 2
      ;;
    --recovery-any-unit-group)
      [ "$#" -ge 2 ] || die 'missing required health unit group'
      case "$2" in ,*|*,|*,,*) die 'invalid required health unit group' ;; esac
      IFS=',' read -r -a group_members <<< "$2"
      [ "${#group_members[@]}" -gt 0 ] || die 'empty required health unit group'
      for group_member in "${group_members[@]}"; do
        valid_unit "$group_member" || die 'invalid required health unit group'
      done
      recovery_health_unit_groups+=("$2")
      shift 2
      ;;
    --health-samples)
      [ "$#" -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]{0,3}$ ]] || die 'invalid health sample count'
      health_samples=$2
      shift 2
      ;;
    --health-stable)
      [ "$#" -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]{0,3}$ ]] || die 'invalid health stable count'
      health_stable=$2
      shift 2
      ;;
    *) die 'invalid health argument' ;;
  esac
done
[ "$health_stable" -le "$health_samples" ] || die 'health stable count exceeds sample count'
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

reset_health_units() {
  local contract=$1 unit group group_member load_state failed_status
  local -a health_units health_unit_groups group_members
  case "$contract" in
    candidate)
      health_units=("${candidate_health_units[@]}")
      health_unit_groups=()
      ;;
    recovery)
      health_units=("${recovery_health_units[@]}")
      health_unit_groups=("${recovery_health_unit_groups[@]}")
      ;;
    *) return 1 ;;
  esac
  for group in "${health_unit_groups[@]}"; do
    IFS=',' read -r -a group_members <<< "$group"
    health_units+=("${group_members[@]}")
  done
  for unit in "${health_units[@]}"; do
    load_state=$(timeout --signal=KILL 1s systemctl show --property=LoadState --value -- "$unit") || return 1
    case "$load_state" in
      loaded)
        failed_status=0
        timeout --signal=KILL 1s systemctl is-failed --quiet -- "$unit" || failed_status=$?
        case "$failed_status" in
          0) timeout --signal=KILL 1s systemctl reset-failed -- "$unit" || return 1 ;;
          1) ;;
          *) return 1 ;;
        esac
        ;;
      not-found) ;;
      *) return 1 ;;
    esac
  done
}

is_baseline_exempt() {
  local unit=$1 exempt
  for exempt in "${baseline_exempt[@]}"; do
    [ "$exempt" = "$unit" ] && return 0
  done
  return 1
}

# A unit that is already down when the deploy starts was not brought down by
# this deploy. Holding the deploy to it means one unrelated outage blocks every
# later deploy until a human clears it -- and because zigbee2mqtt.service is
# BindsTo= its USB coordinator, "unrelated outage" includes an unplugged dongle.
#
# Absence is not the same as being down: a unit that is not-found before the
# switch is new in the candidate and must come up, so it is never exempt. A
# unit that was active and goes inactive is the regression this gate exists to
# catch, so it is never exempt either.
#
# Nor is "inactive" by itself enough, because it does not distinguish a unit
# that was meant to be running and was not, from one the running system was
# never trying to start. Only the first is a pre-existing outage; the second may
# be a unit the candidate is the generation to enable, and the gate's whole job
# is to prove that it starts. The question is therefore whether anything wanted
# or required it, not whether its unit file was installed or enabled:
# LoadState says only that the file exists, and UnitFileState calls a unit
# static when it has no [Install] section even though a target pulls it in --
# home-assistant.service on this host is exactly that shape.
#
# Group members are deliberately not baselined. The one group is the
# system-deploy/nixos-deploy timer rename, whose members are timers; a timer
# cannot exec and then die, which is the failure this exemption is about.
#
# Exempting a unit does not abandon it, and the switch rather than anything here
# is what saves it: it starts every active target, and starting an
# already-active target still pulls up its inactive Wants=. Exemption keys on
# having an *active* wanter, the same fact that earns the unit that start job --
# measured on real systemd, including for a unit reset from failed to inactive
# by reset_health_units below. The watchdog next door depends on it, since it
# leaves an `inactive` unit alone as somebody's deliberate stop. A merely
# non-empty WantedBy would not do: both properties list the links of whichever
# wanting units are loaded, so a target that stays loaded while inactive keeps
# its link while giving the unit no start job, and the unit would be exempted
# into exactly the stranding this paragraph rules out. home-server-cd pins the
# live half by stopping a health unit before a deploy and requiring it back
# after.
#
# Exemption is partial, not a pass: it drops the unit from the per-unit check
# only. `systemctl is-system-running` reports degraded while any unit is failed,
# and health_check requires that too, so an exempt unit that fails again after
# the switch still fails the deploy. That direction is safe -- the deploy is
# blocked and nothing is stranded -- but it means an unrelated outage can still
# block deploys for a unit that fails on start rather than restart-looping.
# zigbee2mqtt carries Restart=always and so keeps restarting rather than
# settling in failed; a health unit without Restart= has no such cover.
capture_baseline() {
  local unit load_state active_status wanted_by required_by wanter wanter_status wanter_active
  local -a units=() wanters=()
  local -A considered=()
  for unit in "${candidate_health_units[@]}" "${recovery_health_units[@]}"; do
    [ -z "${considered[$unit]+considered}" ] || continue
    considered[$unit]=1
    units+=("$unit")
  done
  baseline_exempt=()
  for unit in "${units[@]}"; do
    load_state=$(timeout --signal=KILL 1s systemctl show --property=LoadState --value -- "$unit") || return 1
    case "$load_state" in
      loaded) ;;
      not-found) continue ;;
      *) return 1 ;;
    esac
    active_status=0
    timeout --signal=KILL 1s systemctl is-active --quiet -- "$unit" || active_status=$?
    [ "$active_status" -eq 0 ] && continue
    wanted_by=$(timeout --signal=KILL 1s systemctl show --property=WantedBy --value -- "$unit") || return 1
    required_by=$(timeout --signal=KILL 1s systemctl show --property=RequiredBy --value -- "$unit") || return 1
    # An active wanter, not merely a listed one; see above. A unit nothing
    # wants splits to an empty list and falls through unexempted.
    read -r -a wanters <<< "$wanted_by $required_by"
    wanter_active=0
    for wanter in "${wanters[@]}"; do
      wanter_status=0
      timeout --signal=KILL 1s systemctl is-active --quiet -- "$wanter" || wanter_status=$?
      [ "$wanter_status" -ne 0 ] || { wanter_active=1; break; }
    done
    [ "$wanter_active" -eq 1 ] || continue
    baseline_exempt+=("$unit")
  done
}

# Short probes bound both candidate validation and TERM-triggered recovery.
#
# A probe proves two things per unit: that it is active, and that it is still
# in the same activation it was in when the current streak began. systemd
# reports a Type=simple unit active the instant it execs -- before it has read
# a line of its own configuration -- so is-active alone cannot separate a
# service that stayed up from one that keeps respawning. The activation
# timestamp can, and it catches any restart rather than only the auto-restarts
# NRestarts counts.
health_check() {
  local expected=$1 contract=$2 attempt consecutive=0 status running unit unit_status units_healthy
  local group group_member group_healthy active_enter
  local -a health_units health_unit_groups group_members
  local -A streak_enter=()
  case "$contract" in
    candidate)
      health_units=("${candidate_health_units[@]}")
      health_unit_groups=()
      ;;
    recovery)
      health_units=("${recovery_health_units[@]}")
      health_unit_groups=("${recovery_health_unit_groups[@]}")
      ;;
    *) return 1 ;;
  esac
  for attempt in $(seq 1 "$health_samples"); do
    status=0
    timeout --signal=KILL 1s systemctl is-system-running || status=$?
    running=$(readlink -f "$current_system" 2>/dev/null || true)
    units_healthy=1
    for unit in "${health_units[@]}"; do
      is_baseline_exempt "$unit" && continue
      unit_status=0
      timeout --signal=KILL 1s systemctl is-active --quiet -- "$unit" || unit_status=$?
      if [ "$unit_status" -ne 0 ]; then
        units_healthy=0
        unset "streak_enter[$unit]"
        continue
      fi
      active_enter=$(timeout --signal=KILL 1s systemctl show --property=ActiveEnterTimestampMonotonic --value -- "$unit") || return 1
      if [ -z "${streak_enter[$unit]+recorded}" ]; then
        streak_enter[$unit]=$active_enter
      elif [ "${streak_enter[$unit]}" != "$active_enter" ]; then
        # Active at both probes, but not the same activation: it restarted.
        streak_enter[$unit]=$active_enter
        units_healthy=0
      fi
    done
    for group in "${health_unit_groups[@]}"; do
      group_healthy=0
      IFS=',' read -r -a group_members <<< "$group"
      for group_member in "${group_members[@]}"; do
        unit_status=0
        timeout --signal=KILL 1s systemctl is-active --quiet -- "$group_member" || unit_status=$?
        [ "$unit_status" -ne 0 ] || group_healthy=1
      done
      [ "$group_healthy" -eq 1 ] || units_healthy=0
    done
    if [ "$status" -eq 0 ] && [ "$running" = "$expected" ] && [ "$units_healthy" -eq 1 ]; then
      consecutive=$((consecutive + 1))
      [ "$consecutive" -lt "$health_stable" ] || return 0
    else
      consecutive=0
    fi
    [ "$attempt" -eq "$health_samples" ] || sleep 1
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
  local pending="$state_dir/pending-activation" key value unit
  local pending_old_path= pending_old_generation= pending_baseline_exempt=
  local -a pending_exempt_units=()
  [ -s "$pending" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      previous_path) pending_old_path=$value ;;
      previous_generation) pending_old_generation=$value ;;
      baseline_exempt) pending_baseline_exempt=$value ;;
    esac
  done < "$pending"
  [ -n "$pending_old_path" ] && [ -n "$pending_old_generation" ] || return 1
  # Recovery runs in a fresh process that never saw the pre-switch system, so
  # the exemptions are read back from the journal that recorded them. A marker
  # written before this field existed exempts nothing, which is exactly the
  # previous require-every-unit behaviour.
  baseline_exempt=()
  if [ -n "$pending_baseline_exempt" ]; then
    IFS=',' read -r -a pending_exempt_units <<< "$pending_baseline_exempt"
    for unit in "${pending_exempt_units[@]}"; do
      valid_unit "$unit" || return 1
      baseline_exempt+=("$unit")
    done
  fi
  if [ "$pending_old_path" = none ] && [ "$pending_old_generation" = none ]; then
    rm -f "$profile" || return 1
    delete_generations_newer_than none || return 1
    rm -f "$pending"
    return 0
  fi
  is_system_path "$pending_old_path" || return 1
  [[ "$pending_old_generation" =~ ^[0-9]+$ ]] || return 1
  nix-env --profile "$profile" --switch-generation "$pending_old_generation" >/dev/null || return 1
  reset_health_units recovery || return 1
  switch_system "$pending_old_path" || return 1
  health_check "$pending_old_path" recovery || return 1
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
  reset_health_units recovery || return 1
  switch_system "$old_path" || return 1
  health_check "$old_path" recovery || return 1
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
baseline_exempt=$(IFS=,; printf '%s' "${baseline_exempt[*]}")
reason=$reason
rollback=$rollback_state
" || true
  if [ "$rollback_state" = complete ]; then
    rm -f "$state_dir/pending-activation"
  fi
  exit 1
}

# Sampled before the candidate is switched in, because afterwards there is no
# way left to ask what was already broken.
capture_baseline || die 'could not sample pre-switch unit health'
baseline_exempt_field=$(IFS=,; printf '%s' "${baseline_exempt[*]}")

# This journal is the future last-success marker. Its atomic rename is the only
# commit point, so any pre-commit crash is distinguishable from operator drift.
write_marker pending-activation "rev=$revision
path=$system_path
previous_path=$old_path
previous_generation=${old_generation:-none}
baseline_exempt=$baseline_exempt_field
" || die 'could not record pending activation'
trap 'fail received-signal' HUP INT TERM
nix-env --profile "$profile" --set "$system_path" >/dev/null || fail profile-switch-failed
reset_health_units candidate || fail candidate-reset-failed
switch_status=0
switch_system "$system_path" || switch_status=$?
case "$switch_status" in
  0) ;;
  124|137) fail candidate-switch-timeout ;;
  *) fail candidate-switch-failed ;;
esac
health_check "$system_path" candidate || fail candidate-health-failed
prune_generations || fail generation-pruning-failed
trap '' HUP INT TERM
mv -f "$state_dir/pending-activation" "$state_dir/last-success" || {
  trap 'fail received-signal' HUP INT TERM
  fail success-marker-failed
}
trap - HUP INT TERM
