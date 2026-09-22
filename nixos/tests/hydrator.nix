# Cache hydration is fail-closed: exact trusted caches only, no builds, and no
# poisoned partial result after missing, unsigned, or hanging publication.
{ pkgs, script }:

let
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
in
pkgs.runCommand "hydrator-contract" { nativeBuildInputs = with pkgs; [ bash coreutils gnugrep ]; } ''
  set -euo pipefail
  mkdir bin
  cat > bin/nix <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
printf '%s\n' "$*" >> "$HYDRATOR_LOG"
case "$*" in
  *unsigned*) echo 'signature verification failed' >&2; exit 1 ;;
  *hanging*) sleep 30 ;;
  *missing*) echo 'not available' >&2; exit 1 ;;
  *path-info*) printf '{"%s": {}}\n' "''${*: -1}"; exit 0 ;;
esac
exit 0
EOF
  chmod +x bin/nix
  export PATH="$PWD/bin:$PATH" HYDRATOR_LOG="$PWD/log"
  invoke() { timeout 2 bash ${script} --timeout-seconds 1 --from '${projectCache}' --trusted-key '${projectKey}' --from '${nixosCache}' --trusted-key '${nixosKey}' "$@"; }
  if invoke > empty.log 2>&1; then exit 1; fi
  grep -qF 'at least one store path' empty.log
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
  ! grep -Eq 'build|realise|--add-root' "$HYDRATOR_LOG"
  touch "$out"
''
