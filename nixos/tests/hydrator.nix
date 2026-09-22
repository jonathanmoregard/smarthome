# Cache hydration is fail-closed: exact trusted caches only, no builds, and no
# poisoned partial result after missing, unsigned, or hanging publication.
{ pkgs, script }:

let
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
in
pkgs.runCommand "hydrator-contract" { nativeBuildInputs = with pkgs; [ bash coreutils gnugrep jq ]; } ''
  set -euo pipefail
  mkdir bin
  cat > bin/nix <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
printf '%s\n' "$*" >> "$HYDRATOR_LOG"
argv=("$@")
has_token() {
  local wanted=$1 argument
  for argument in "''${argv[@]}"; do
    [ "$argument" = "$wanted" ] && return 0
  done
  return 1
}
require() { has_token "$1" || { echo "missing argument: $1" >&2; exit 64; }; }
if has_token --add-root; then echo 'nix build roots are forbidden' >&2; exit 64; fi
case "$*" in
  *unsigned*) echo 'signature verification failed' >&2; exit 1 ;;
  *hanging*) sleep 30 ;;
  *missing*) echo 'not available' >&2; exit 1 ;;
esac
case "''${1:-}:''${2:-}" in
  build:*|realise:*|store:realise)
    echo "build/realise command is forbidden: $*" >&2
    exit 64
    ;;
  store:verify)
    require --sigs-needed
    require 1
    require --option
    require trusted-public-keys
    exit 0
    ;;
  path-info:--refresh)
    require --store
    require --json
    root=/nix/store/00000000000000000000000000000000-healthy
    dependency=/nix/store/11111111111111111111111111111111-nixos-dependency
    if has_token "$root" && has_token https://jonathanmoregard.cachix.org; then
      printf '%s\n' '{"/nix/store/00000000000000000000000000000000-healthy":{"references":["/nix/store/11111111111111111111111111111111-nixos-dependency"]}}'
    elif has_token "$dependency" && has_token https://jonathanmoregard.cachix.org; then
      # This is deliberately valid empty metadata: project publication has no
      # dependency, so traversal must continue at the official cache.
      printf '%s\n' '{}'
    elif has_token "$dependency" && has_token https://cache.nixos.org; then
      printf '%s\n' '{"/nix/store/11111111111111111111111111111111-nixos-dependency":{"references":[]}}'
    else
      echo "unexpected path-info routing: $*" >&2; exit 64
    fi
    ;;
  store:copy-sigs)
    require --substituter
    ;;
  copy:--refresh)
    require --from
    require --no-recursive
    require --option
    require max-jobs
    require 0
    require fallback
    require false
    require builders
    root=/nix/store/00000000000000000000000000000000-healthy
    dependency=/nix/store/11111111111111111111111111111111-nixos-dependency
    if has_token "$root"; then
      require https://jonathanmoregard.cachix.org
      has_token https://cache.nixos.org && { echo 'root must not copy from official cache' >&2; exit 64; }
    elif has_token "$dependency"; then
      if has_token https://jonathanmoregard.cachix.org; then
        echo 'not available from project cache' >&2
        exit 1
      fi
      require https://cache.nixos.org
    else
      echo "unexpected copy path: $*" >&2
      exit 64
    fi
    exit 0
    ;;
  *) echo "unexpected nix invocation: $*" >&2; exit 64 ;;
esac
EOF
  chmod +x bin/nix
  export PATH="$PWD/bin:$PATH" HYDRATOR_LOG="$PWD/log"
  on_failure() {
    status=$?
    [ "$status" -eq 0 ] && return
    for log in *.log; do
      [ -f "$log" ] || continue
      printf '\n--- %s ---\n' "$log" >&2
      cat "$log" >&2
    done
    printf '\n--- fake nix argv log ---\n' >&2
    cat "$HYDRATOR_LOG" >&2
  }
  trap on_failure EXIT
  invoke() { timeout 2 bash ${script} --timeout-seconds 1 --from '${projectCache}' --trusted-key '${projectKey}' --from '${nixosCache}' --trusted-key '${nixosKey}' "$@"; }
  if invoke > empty.log 2>&1; then exit 1; fi
  grep -qF 'at least one store path' empty.log
  invoke /nix/store/00000000000000000000000000000000-healthy > healthy.log 2>&1
  grep -qF '/nix/store/11111111111111111111111111111111-nixos-dependency' "$HYDRATOR_LOG"
  grep -qF 'copy --refresh --no-recursive' "$HYDRATOR_LOG"
  if invoke /nix/store/00000000000000000000000000000000-unsigned > unsigned.log 2>&1; then exit 1; fi
  grep -qF 'signature verification failed' unsigned.log
  if invoke /nix/store/00000000000000000000000000000000-missing > missing.log 2>&1; then exit 1; fi
  grep -qF 'not available' missing.log
  if invoke /nix/store/00000000000000000000000000000000-hanging > hanging.log 2>&1; then exit 1; fi
  grep -qF -- '--option max-jobs 0' "$HYDRATOR_LOG"
  grep -qF -- '--option fallback false' "$HYDRATOR_LOG"
  grep -qF -- '--option builders ' "$HYDRATOR_LOG"
  grep -qF '${projectCache}' "$HYDRATOR_LOG"
  grep -qF '${projectKey}' "$HYDRATOR_LOG"
  grep -qF '${nixosCache}' "$HYDRATOR_LOG"
  grep -qF '${nixosKey}' "$HYDRATOR_LOG"
  ! grep -Eq '(^| )(build|realise|--add-root)( |$)' "$HYDRATOR_LOG"
  touch "$out"
''
