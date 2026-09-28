#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "push-closure: $*" >&2
  exit 2
}

[[ "$#" -eq 2 ]] || die 'usage: push-closure.sh <cache> <root>'

cache="$1"
root="$2"

[[ "$cache" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'cache must be a non-empty Cachix cache name'
[[ "$root" == /nix/store/* && "$root" != *$'\n'* ]] || die 'root must be a non-empty Nix store path'

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
raw_closure="$work_dir/closure.raw"
sorted_closure="$work_dir/closure.sorted"

nix path-info --recursive -- "$root" > "$raw_closure"
LC_ALL=C sort -u "$raw_closure" > "$sorted_closure"
mapfile -t closure_paths < "$sorted_closure"

[[ "${#closure_paths[@]}" -gt 0 ]] || die 'nix returned an empty closure'
for path in "${closure_paths[@]}"; do
  [[ "$path" == /nix/store/* && "$path" != *[[:space:]]* ]] || die "invalid closure path: $path"
done

batch_size=128
for ((offset = 0; offset < ${#closure_paths[@]}; offset += batch_size)); do
  batch=("${closure_paths[@]:offset:batch_size}")
  cachix push "$cache" "${batch[@]}"
done
