# The activator owns atomic switching, exact generation rollback, start-limit
# recovery, and pruning only after a healthy candidate.
{ pkgs, script }:

let
  package = name: pkgs.runCommand name { } ''mkdir -p "$out/bin"; touch "$out/bin/house-automationd"'';
  v1 = package "app-v1";
  v2 = package "app-v2";
  v3 = package "app-v3";
in
pkgs.runCommand "app-activator-contract" { nativeBuildInputs = with pkgs; [ bash coreutils gnugrep ]; } ''
  set -euo pipefail
  state="$PWD/state" profile="$PWD/profile" log="$PWD/log"
  mkdir -p "$state" "$PWD/bin"
  cat > "$PWD/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$ACTIVATOR_LOG"
if [ "$1" = reset-failed ]; then rm -f "$START_LIMIT"; exit 0; fi
if [ "$1" = restart ] && [ "$(readlink -f "$PROFILE")" = "$CRASHING" ]; then touch "$START_LIMIT"; exit 1; fi
exit 0
EOF
  cat > "$PWD/bin/curl" <<'EOF'
#!/usr/bin/env bash
[ "$(readlink -f "$PROFILE")" != "$UNHEALTHY" ]
EOF
  cat > "$PWD/bin/nix-env" <<'EOF'
#!/usr/bin/env bash
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
    for generation in "$@"; do rm -f "$profile-$generation-link"; done
    grep -vxF -f <(printf '%s\n' "$@") "$GENERATIONS" > "$GENERATIONS.tmp" || true
    mv "$GENERATIONS.tmp" "$GENERATIONS"
    ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "$PWD/bin/systemctl" "$PWD/bin/curl" "$PWD/bin/nix-env"
  export PATH="$PWD/bin:$PATH" ACTIVATOR_LOG="$log" PROFILE="$profile" START_LIMIT="$PWD/start-limit" GENERATIONS="$PWD/generations" CRASHING=${v2} UNHEALTHY=${v3}
  : > "$GENERATIONS"
  run() { bash ${script} "$@" "$state" "$profile" house-automationd.service http://127.0.0.1:9876/healthz; }
  run ${v1} 1111111111111111111111111111111111111111
  before=$(readlink "$profile")
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  [ "$(readlink "$profile")" = "$before" ]
  grep -qxF 'rollback=complete' "$state/last-failure"
  grep -qF 'systemctl reset-failed house-automationd.service' "$log"
  if run ${v3} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink "$profile")" = "$before" ]
  grep -qF 'previous_generation=1' "$state/last-failure"
  # A healthy replacement can retain only current and immediately previous
  # stable generations; repeated activation must not create a third stable one.
  run ${v1} 1111111111111111111111111111111111111111
  generations=$(find "$(dirname "$profile")" -name 'profile-*-link' | wc -l)
  [ "$generations" -le 2 ]
  touch "$out"
''
