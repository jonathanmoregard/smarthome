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
  state="$PWD/state" profile="$PWD/profile" log="$PWD/log"
  mkdir -p "$state" "$PWD/bin"
  cat > "$PWD/bin/systemctl" <<'EOF'
#!${pkgs.runtimeShell}
printf 'systemctl %s\n' "$*" >> "$ACTIVATOR_LOG"
if [ "$1" = reset-failed ]; then rm -f "$START_LIMIT"; exit 0; fi
if [ "$1" = restart ] && [ "$(readlink -f "$PROFILE")" = "$CRASHING" ]; then touch "$START_LIMIT"; exit 1; fi
exit 0
EOF
  cat > "$PWD/bin/curl" <<'EOF'
#!${pkgs.runtimeShell}
[ "$(readlink -f "$PROFILE")" != "$UNHEALTHY" ]
EOF
  cat > "$PWD/bin/sleep" <<'EOF'
#!${pkgs.runtimeShell}
exit 0
EOF
  cat > "$PWD/bin/nix-env" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
[ "$1" = --profile ]
profile=$2 operation=$3
shift 3
case "$operation" in
  --set)
    generation=1
    [ -s "$GENERATIONS" ] && generation=$(( $(tail -n1 "$GENERATIONS") + 1 ))
    ln -sfn "$1" "$profile-$generation-link"
    ln -sfn "$profile-$generation-link" "$profile"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    ;;
  --list-generations)
    while read -r generation; do
      suffix=
      [ "$(readlink "$profile")" = "$profile-$generation-link" ] && suffix=' (current)'
      printf '%s 2026-09-22%s\n' "$generation" "$suffix"
    done < "$GENERATIONS"
    ;;
  --switch-generation)
    ln -sfn "$profile-$1-link" "$profile"
    ;;
  --delete-generations)
    [ "''${FAIL_PRUNE:-0}" != 1 ] || exit 75
    for generation in "$@"; do rm -f "$profile-$generation-link"; done
    grep -vxF -f <(printf '%s\n' "$@") "$GENERATIONS" > "$GENERATIONS.tmp" || true
    mv "$GENERATIONS.tmp" "$GENERATIONS"
    ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "$PWD/bin/systemctl" "$PWD/bin/curl" "$PWD/bin/sleep" "$PWD/bin/nix-env"
  export PATH="$PWD/bin:$PATH" ACTIVATOR_LOG="$log" PROFILE="$profile" START_LIMIT="$PWD/start-limit" GENERATIONS="$PWD/generations" CRASHING=${v2} UNHEALTHY=${v3}
  : > "$GENERATIONS"
  run() { bash ${script} "$@" "$state" "$profile" house-automationd.service http://127.0.0.1:9876/healthz; }
  run ${v1} 1111111111111111111111111111111111111111
  before=$(readlink "$profile")
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  [ "$(readlink "$profile")" = "$before" ]
  grep -qxF 'rollback=complete' "$state/last-failure"
  grep -qF 'systemctl reset-failed house-automationd.service' "$log"
  [ ! -e "$START_LIMIT" ]
  rollback_sequence=$(tail -n 3 "$log")
  [ "$(printf '%s\n' "$rollback_sequence" | sed -n '1p')" = 'systemctl restart house-automationd.service' ]
  [ "$(printf '%s\n' "$rollback_sequence" | sed -n '2p')" = 'systemctl reset-failed house-automationd.service' ]
  [ "$(printf '%s\n' "$rollback_sequence" | sed -n '3p')" = 'systemctl restart house-automationd.service' ]
  if run ${v3} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink "$profile")" = "$before" ]
  grep -qF 'previous_generation=1' "$state/last-failure"
  # Three actual healthy candidates retain exactly current and previous.
  run ${v4} 4444444444444444444444444444444444444444
  export FAIL_PRUNE=1
  if run ${v5} 5555555555555555555555555555555555555555; then exit 1; fi
  unset FAIL_PRUNE
  ! grep -qF 'rev=5555555555555555555555555555555555555555' "$state/last-success"
  grep -qF 'reason=generation-pruning-failed' "$state/last-failure"
  run ${v5} 5555555555555555555555555555555555555555
  generations=$(find "$(dirname "$profile")" -name 'profile-*-link' | wc -l)
  [ "$generations" -eq 2 ]
  [ "$(readlink -f "$profile")" = "${v5}" ]
  touch "$out"
''
