#!/usr/bin/env bash
set -euo pipefail
set -f

die() { printf 'hydrate-release-paths:' >&2; printf ' %s' "$@" >&2; printf '\n' >&2; exit 1; }
declare -a caches=() keys=()
timeout_seconds=300 interval=5 attempts=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) [ "$#" -ge 2 ] || die 'missing cache URL'; caches+=("$2"); shift 2 ;;
    --trusted-key) [ "$#" -ge 2 ] || die 'missing trusted key'; keys+=("$2"); shift 2 ;;
    --timeout-seconds) timeout_seconds=$2; shift 2 ;;
    --interval) interval=$2; shift 2 ;;
    --attempts) attempts=$2; shift 2 ;;
    --*) die "unknown option: $1" ;;
    *) break ;;
  esac
done
[ "${#caches[@]}" -ge 2 ] && [ "${#caches[@]}" -eq "${#keys[@]}" ] || die 'project and official cache/key pairs are required'
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ && "$interval" =~ ^[1-9][0-9]*$ && "$attempts" =~ ^[0-9]+$ ]] || die 'invalid retry settings'
[ "$#" -gt 0 ] || die 'at least one store path is required'
store_dir=${NIX_STORE_DIR:-/nix/store}; store_dir=${store_dir%/}
for path in "$@"; do [[ "$path" =~ ^$store_dir/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || die "invalid store path: $path"; done
within_deadline() { timeout --signal=KILL "$timeout_seconds" "$@"; }

# The promoted root must be present and signed by the project cache.  Once its
# closure is known, each member may come from either explicitly pinned cache.
root=$1
if ! root_diagnostics=$(within_deadline nix store verify --store "${caches[0]}" --sigs-needed 1 --no-contents \
  --option trusted-public-keys "${keys[0]}" "$root" 2>&1); then
  printf '%s\n' "$root_diagnostics" >&2
  case "$root_diagnostics" in *not\ available*) die 'release root is not available from project cache' ;; esac
  die 'project release root signature verification failed'
fi
metadata=$(within_deadline nix path-info --refresh --store "${caches[0]}" --json --recursive "$root") || die 'could not read project release closure'
mapfile -t closure < <(printf '%s' "$metadata" | jq -er 'keys[]') || die 'could not decode project release closure'
[ "${#closure[@]}" -gt 0 ] || die 'project release closure is empty'
all_keys=$(IFS=' '; printf '%s' "${keys[*]}")
for path in "${closure[@]}"; do
  copied=0
  for index in "${!caches[@]}"; do
    if within_deadline nix copy --refresh --from "${caches[$index]}" \
      --option max-jobs 0 --option fallback false --option builders "" \
      --option trusted-public-keys "$all_keys" "$path"; then copied=1; break; fi
  done
  [ "$copied" -eq 1 ] || die "release path is not available from pinned caches: $path"
done
nix store verify --recursive --sigs-needed 1 --option trusted-public-keys "$all_keys" "${closure[@]}" || \
  die 'release closure signature verification failed'
