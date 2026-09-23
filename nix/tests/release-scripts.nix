{ pkgs }:

let
  classifier = ../ci/classify-paths.sh;
  publisher = ../ci/push-closure.sh;
  promoter = ../ci/promote-release-ref.sh;
in
pkgs.runCommand "smarthome-release-scripts-contract"
  { nativeBuildInputs = [ pkgs.bash pkgs.coreutils ]; }
  ''
    set -euo pipefail

    assert_classification() {
      expected="$1"
      path="$2"
      printf '%s\n' "$expected" > "$TMPDIR/classification-expected"
      printf '%s\0' "$path" | bash ${classifier} > "$TMPDIR/classification-actual"
      if ! cmp "$TMPDIR/classification-expected" "$TMPDIR/classification-actual"; then
        printf 'classification mismatch for %s\nexpected:\n%s\nactual:\n%s\n' \
          "$path" "$expected" "$(cat "$TMPDIR/classification-actual")" >&2
        return 1
      fi
    }

    assert_classification $'app=true\nsystem=false' 'house-automation-core/src/lib.rs'
    assert_classification $'app=false\nsystem=true' 'nixos/modules/system-auto-deploy.nix'
    assert_classification $'app=true\nsystem=false' 'nix/tests/simulated-house.nix'
    assert_classification $'app=true\nsystem=true' 'flake.lock'
    assert_classification $'app=false\nsystem=false' 'docs/home-server/recovery.md'
    assert_classification $'app=true\nsystem=true' 'unknown.bin'

    combined="$(
      printf '%s\0' \
        'docs/home-server/recovery.md' \
        'house-automation-core/src/lib.rs' \
        'nixos/modules/system-auto-deploy.nix' |
        bash ${classifier}
    )"
    test "$combined" = $'app=true\nsystem=true'

    fake_bin="$TMPDIR/fake-bin"
    mkdir -p "$fake_bin"

    cat > "$fake_bin/nix" <<'EOF'
    #!${pkgs.bash}/bin/bash
    set -euo pipefail
    test "$#" -eq 4
    test "$1" = path-info
    test "$2" = --recursive
    test "$3" = --
    test "$4" = "$EXPECTED_ROOT"
    test "''${NIX_FAIL:-false}" = false
    cat "$NIX_CLOSURE"
    EOF

    cat > "$fake_bin/cachix" <<'EOF'
    #!${pkgs.bash}/bin/bash
    set -euo pipefail
    test "$#" -ge 3
    test "$1" = push
    test "$2" = "$EXPECTED_CACHE"
    shift 2
    test "$#" -gt 0
    test "$#" -le 128
    printf '%s\n' "$#" >> "$CACHIX_BATCHES"
    printf '%s\n' "$@" >> "$CACHIX_PATHS"
    EOF
    chmod +x "$fake_bin/nix" "$fake_bin/cachix"

    export PATH="$fake_bin:$PATH"
    export EXPECTED_CACHE=contract-cache
    export EXPECTED_ROOT=/nix/store/release-root
    export NIX_CLOSURE="$TMPDIR/closure"
    export CACHIX_BATCHES="$TMPDIR/cachix-batches"
    export CACHIX_PATHS="$TMPDIR/cachix-paths"

    : > "$NIX_CLOSURE"
    for number in $(seq -w 1 300); do
      printf '/nix/store/fake-path-%s\n' "$number" >> "$NIX_CLOSURE"
    done
    cp "$NIX_CLOSURE" "$TMPDIR/expected-paths"
    : > "$CACHIX_BATCHES"
    : > "$CACHIX_PATHS"

    bash ${publisher} "$EXPECTED_CACHE" "$EXPECTED_ROOT"
    test "$(wc -l < "$CACHIX_BATCHES")" -eq 3
    test "$(sed -n '1p' "$CACHIX_BATCHES")" -eq 128
    test "$(sed -n '2p' "$CACHIX_BATCHES")" -eq 128
    test "$(sed -n '3p' "$CACHIX_BATCHES")" -eq 44
    cmp "$TMPDIR/expected-paths" "$CACHIX_PATHS"

    if bash ${publisher}; then
      echo 'publisher accepted missing arguments' >&2
      exit 1
    fi
    if bash ${publisher} "" "$EXPECTED_ROOT"; then
      echo 'publisher accepted an empty cache name' >&2
      exit 1
    fi
    if bash ${publisher} "$EXPECTED_CACHE" ""; then
      echo 'publisher accepted an empty root' >&2
      exit 1
    fi
    if bash ${publisher} "$EXPECTED_CACHE" "$EXPECTED_ROOT" extra; then
      echo 'publisher accepted extra arguments' >&2
      exit 1
    fi
    : > "$NIX_CLOSURE"
    if bash ${publisher} "$EXPECTED_CACHE" "$EXPECTED_ROOT"; then
      echo 'publisher accepted an empty closure' >&2
      exit 1
    fi
    printf 'not-a-store-path\n' > "$NIX_CLOSURE"
    if bash ${publisher} "$EXPECTED_CACHE" "$EXPECTED_ROOT"; then
      echo 'publisher accepted an invalid closure path' >&2
      exit 1
    fi
    export NIX_FAIL=true
    if bash ${publisher} "$EXPECTED_CACHE" "$EXPECTED_ROOT"; then
      echo 'publisher ignored nix path-info failure' >&2
      exit 1
    fi
    unset NIX_FAIL

    cat > "$fake_bin/gh" <<'EOF'
    #!${pkgs.bash}/bin/bash
    set -euo pipefail

    printf '%s\n' "$*" >> "$GH_LOG"
    test "$1" = api
    shift
    method=GET
    endpoint=
    ref_field=
    sha_field=
    force_field=
    while test "$#" -gt 0; do
      case "$1" in
        --method)
          method="$2"
          shift 2
          ;;
        --jq)
          shift 2
          ;;
        --silent)
          shift
          ;;
        -f|-F)
          field="$2"
          case "$field" in
            ref=*) ref_field="''${field#ref=}" ;;
            sha=*) sha_field="''${field#sha=}" ;;
            force=*) force_field="''${field#force=}" ;;
          esac
          shift 2
          ;;
        *)
          test -z "$endpoint"
          endpoint="$1"
          shift
          ;;
      esac
    done

    case "$method:$endpoint" in
      GET:repos/test-owner/test-repo/git/ref/heads/release/app|GET:repos/test-owner/test-repo/git/ref/heads/release/home-server)
        test -s "$GH_STATE"
        cat "$GH_STATE"
        ;;
      GET:repos/test-owner/test-repo/compare/*)
        test -n "''${GH_COMPARE_STATUS:-}"
        test "$endpoint" = "repos/test-owner/test-repo/compare/$GH_EXPECTED_COMPARE"
        printf '%s\n' "$GH_COMPARE_STATUS"
        ;;
      POST:repos/test-owner/test-repo/git/refs)
        test ! -s "$GH_STATE"
        case "$ref_field" in
          refs/heads/release/app|refs/heads/release/home-server) ;;
          *) exit 1 ;;
        esac
        test -n "$sha_field"
        printf '%s\n' "$sha_field" > "$GH_STATE"
        printf 'create %s %s\n' "$ref_field" "$sha_field" >> "$GH_MUTATIONS"
        ;;
      PATCH:repos/test-owner/test-repo/git/refs/heads/release/app|PATCH:repos/test-owner/test-repo/git/refs/heads/release/home-server)
        test "$force_field" = false
        test -n "$sha_field"
        printf '%s\n' "$sha_field" > "$GH_STATE"
        printf 'update %s force=%s\n' "$sha_field" "$force_field" >> "$GH_MUTATIONS"
        ;;
      *)
        echo "unexpected gh call: $method $endpoint" >&2
        exit 1
        ;;
    esac
    EOF
    chmod +x "$fake_bin/gh"

    export GH_LOG="$TMPDIR/gh-log"
    export GH_MUTATIONS="$TMPDIR/gh-mutations"
    export GH_STATE="$TMPDIR/gh-state"
    export GITHUB_REPOSITORY=test-owner/test-repo
    first=1111111111111111111111111111111111111111
    second=2222222222222222222222222222222222222222
    divergent=3333333333333333333333333333333333333333

    : > "$GH_STATE"
    : > "$GH_LOG"
    : > "$GH_MUTATIONS"
    export GITHUB_SHA="$first"
    bash ${promoter} release/app "$first"
    test "$(cat "$GH_STATE")" = "$first"
    grep -Fx "create refs/heads/release/app $first" "$GH_MUTATIONS"

    printf '%s\n' "$first" > "$GH_STATE"
    : > "$GH_LOG"
    : > "$GH_MUTATIONS"
    export GITHUB_SHA="$second"
    export GH_COMPARE_STATUS=ahead
    export GH_EXPECTED_COMPARE="$first...$second"
    bash ${promoter} release/app "$second"
    test "$(cat "$GH_STATE")" = "$second"
    grep -Fx "update $second force=false" "$GH_MUTATIONS"

    printf '%s\n' "$second" > "$GH_STATE"
    : > "$GH_LOG"
    : > "$GH_MUTATIONS"
    export GITHUB_SHA="$first"
    export GH_COMPARE_STATUS=behind
    export GH_EXPECTED_COMPARE="$second...$first"
    bash ${promoter} release/app "$first"
    test "$(cat "$GH_STATE")" = "$second"
    test ! -s "$GH_MUTATIONS"

    printf '%s\n' "$second" > "$GH_STATE"
    : > "$GH_LOG"
    : > "$GH_MUTATIONS"
    export GITHUB_SHA="$second"
    unset GH_COMPARE_STATUS
    bash ${promoter} release/home-server "$second"
    test ! -s "$GH_MUTATIONS"
    if grep -F '/compare/' "$GH_LOG" >/dev/null; then
      echo 'equal promotion made an unnecessary ancestry request' >&2
      exit 1
    fi

    printf '%s\n' "$first" > "$GH_STATE"
    : > "$GH_LOG"
    : > "$GH_MUTATIONS"
    export GITHUB_SHA="$divergent"
    export GH_COMPARE_STATUS=diverged
    export GH_EXPECTED_COMPARE="$first...$divergent"
    if bash ${promoter} release/app "$divergent"; then
      echo 'promoter accepted divergent history' >&2
      exit 1
    fi
    test "$(cat "$GH_STATE")" = "$first"
    test ! -s "$GH_MUTATIONS"

    : > "$GH_LOG"
    export GITHUB_SHA="$second"
    if bash ${promoter} release/app "$first"; then
      echo 'promoter accepted a candidate other than GITHUB_SHA' >&2
      exit 1
    fi
    test ! -s "$GH_LOG"
    if bash ${promoter} release/other "$second"; then
      echo 'promoter accepted an invalid release ref' >&2
      exit 1
    fi
    test ! -s "$GH_LOG"

    touch "$out"
  ''
