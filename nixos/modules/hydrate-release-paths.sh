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
deadline=$((SECONDS + timeout_seconds))
within_deadline() {
  local remaining=$((deadline - SECONDS))
  [ "$remaining" -gt 0 ] || die 'hydration deadline exceeded'
  timeout --signal=KILL "$remaining" "$@"
}

metadata_for() {
  local cache=$1 key=$2 path=$3 metadata
  within_deadline nix store verify --store "$cache" --sigs-needed 1 --no-contents \
    --option trusted-public-keys "$key" "$path" >/dev/null 2>&1 || return 1
  metadata=$(within_deadline nix path-info --refresh --store "$cache" --json "$path" 2>/dev/null) || return 1
  printf '%s' "$metadata" | jq -e --arg path "$path" 'type == "object" and (.[$path] | type == "object")' >/dev/null || return 1
  printf '%s' "$metadata"
}

# The promoted root must be present and signed by the project cache.  Once its
# closure is known, each member may come from either explicitly pinned cache.
root=$1
if ! root_diagnostics=$(within_deadline nix store verify --store "${caches[0]}" --sigs-needed 1 --no-contents \
  --option trusted-public-keys "${keys[0]}" "$root" 2>&1); then
  printf '%s\n' "$root_diagnostics" >&2
  case "$root_diagnostics" in *not\ available*) die 'release root is not available from project cache' ;; esac
  die 'project release root signature verification failed'
fi
all_keys=$(IFS=' '; printf '%s' "${keys[*]}")
declare -A seen=()
declare -a queue=("$root") closure=()
while [ "${#queue[@]}" -gt 0 ]; do
  path=${queue[0]}; queue=("${queue[@]:1}")
  [ "${seen[$path]+yes}" ] && continue
  seen[$path]=1
  metadata= selected_cache= selected_key=
  if [ "$path" = "$root" ]; then
    metadata=$(metadata_for "${caches[0]}" "${keys[0]}" "$path") || die 'could not read signed project release root metadata'
    selected_cache=${caches[0]}; selected_key=${keys[0]}
  else
    for index in "${!caches[@]}"; do
      if metadata=$(metadata_for "${caches[$index]}" "${keys[$index]}" "$path"); then
        selected_cache=${caches[$index]}; selected_key=${keys[$index]}; break
      fi
    done
    [ -n "$selected_cache" ] || die "release path is not available from pinned caches: $path"
  fi
  # A pre-existing local path is not provenance: import a pinned signature.
  within_deadline nix store copy-sigs --refresh --substituter "$selected_cache" "$path" || die "could not import pinned cache signature: $path"
  within_deadline nix copy --refresh --no-recursive --from "$selected_cache" \
    --option max-jobs 0 --option fallback false --option builders "" \
    --option trusted-public-keys "$all_keys" "$path" || die "could not copy release path: $path"
  closure+=("$path")
  while IFS= read -r reference; do queue+=("$reference"); done < <(
    printf '%s' "$metadata" | jq -er --arg path "$path" '.[$path].references[]?' 2>/dev/null || true
  )
done
[ "${#closure[@]}" -gt 0 ] || die 'project release closure is empty'
within_deadline nix store verify --recursive --sigs-needed 1 --option trusted-public-keys "$all_keys" "$root" || \
  die 'release closure signature verification failed'
