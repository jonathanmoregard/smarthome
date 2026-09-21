{ pkgs }:

pkgs.runCommand "smarthome-publish-workflow-contract"
  { nativeBuildInputs = [ pkgs.yq-go ]; }
  ''
    workflow=${../../.github/workflows/publish.yml}
    ci=${../../.github/workflows/ci.yml}
    checkout_action='actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'
    install_nix_action='cachix/install-nix-action@ba0dd844c9180cbf77aa72a116d6fbc515d0e87b'
    cachix_action='cachix/cachix-action@1eb2ef646ac0255473d23a5907ad7b04ce94065c'
    expected_push='cachix push jonathanmoregard "''${{ steps.package.outputs.path }}"'
    expected_verify='nix build --no-link --option max-jobs 0 --option fallback false --option builders "" .#packages.x86_64-linux.default'

    IFS= read -r -d $'\0' expected_build <<'EOF' || true
    set -euo pipefail
    package="$(nix build --no-link --print-out-paths .#packages.x86_64-linux.default)"
    test "$(printf '%s\n' "$package" | wc -l)" -eq 1
    printf 'path=%s\n' "$package" >> "$GITHUB_OUTPUT"
    EOF

    IFS= read -r -d $'\0' expected_extra_nix_config <<'EOF' || true
    substituters = https://cache.nixos.org/ https://jonathanmoregard.cachix.org
    trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY= jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=
    EOF

    export checkout_action install_nix_action cachix_action
    export expected_build expected_push expected_verify expected_extra_nix_config

    validate_workflow() {
      candidate="$1"

      yq -e '((keys | length) == 4) and has("name") and has("on") and has("permissions") and has("jobs") and (.name == "Publish package")' "$candidate" >/dev/null || return 1
      yq -e '((.on | keys | length) == 1) and (.on | has("push"))' "$candidate" >/dev/null || return 1
      yq -e '((.on.push | keys | length) == 1) and (.on.push | has("branches"))' "$candidate" >/dev/null || return 1
      yq -e '((.on.push.branches | length) == 1) and (.on.push.branches[0] == "main")' "$candidate" >/dev/null || return 1
      yq -e '((.permissions | keys | length) == 1) and (.permissions | has("contents")) and (.permissions.contents == "read")' "$candidate" >/dev/null || return 1

      yq -e '((.jobs | keys | length) == 2) and (.jobs | has("publish")) and (.jobs | has("verify"))' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.publish | keys | length) == 4) and (.jobs.publish | has("name")) and (.jobs.publish | has("runs-on")) and (.jobs.publish | has("timeout-minutes")) and (.jobs.publish | has("steps")) and (.jobs.publish.name == "build and publish package") and (.jobs.publish."runs-on" == "ubuntu-latest") and (.jobs.publish."timeout-minutes" == 45)' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.verify | keys | length) == 5) and (.jobs.verify | has("name")) and (.jobs.verify | has("needs")) and (.jobs.verify | has("runs-on")) and (.jobs.verify | has("timeout-minutes")) and (.jobs.verify | has("steps")) and (.jobs.verify.name == "verify cache-only substitution") and (.jobs.verify.needs == "publish") and (.jobs.verify."runs-on" == "ubuntu-latest") and (.jobs.verify."timeout-minutes" == 20)' "$candidate" >/dev/null || return 1

      yq -e '(.jobs.publish.steps | length) == 5' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.publish.steps[0] | keys | length) == 3) and (.jobs.publish.steps[0] | has("name")) and (.jobs.publish.steps[0] | has("uses")) and (.jobs.publish.steps[0] | has("with")) and (.jobs.publish.steps[0].name == "Check out exact release") and (.jobs.publish.steps[0].uses == strenv(checkout_action)) and ((.jobs.publish.steps[0].with | keys | length) == 1) and (.jobs.publish.steps[0].with | has("persist-credentials")) and (.jobs.publish.steps[0].with."persist-credentials" == false)' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.publish.steps[1] | keys | length) == 2) and (.jobs.publish.steps[1] | has("name")) and (.jobs.publish.steps[1] | has("uses")) and (.jobs.publish.steps[1].name == "Install Nix") and (.jobs.publish.steps[1].uses == strenv(install_nix_action))' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.publish.steps[2] | keys | length) == 3) and (.jobs.publish.steps[2] | has("name")) and (.jobs.publish.steps[2] | has("uses")) and (.jobs.publish.steps[2] | has("with")) and (.jobs.publish.steps[2].name == "Configure authenticated Cachix publication") and (.jobs.publish.steps[2].uses == strenv(cachix_action)) and ((.jobs.publish.steps[2].with | keys | length) == 3) and (.jobs.publish.steps[2].with | has("name")) and (.jobs.publish.steps[2].with | has("authToken")) and (.jobs.publish.steps[2].with | has("skipPush")) and (.jobs.publish.steps[2].with.name == "jonathanmoregard") and (.jobs.publish.steps[2].with.authToken == "''${{ secrets.CACHIX_AUTH_TOKEN }}") and (.jobs.publish.steps[2].with.skipPush == true)' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.publish.steps[3] | keys | length) == 3) and (.jobs.publish.steps[3] | has("name")) and (.jobs.publish.steps[3] | has("id")) and (.jobs.publish.steps[3] | has("run")) and (.jobs.publish.steps[3].name == "Build exact package") and (.jobs.publish.steps[3].id == "package") and (.jobs.publish.steps[3].run == strenv(expected_build))' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.publish.steps[4] | keys | length) == 2) and (.jobs.publish.steps[4] | has("name")) and (.jobs.publish.steps[4] | has("run")) and (.jobs.publish.steps[4].name == "Push signed runtime closure") and (.jobs.publish.steps[4].run == strenv(expected_push))' "$candidate" >/dev/null || return 1

      yq -e '(.jobs.verify.steps | length) == 3' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.verify.steps[0] | keys | length) == 3) and (.jobs.verify.steps[0] | has("name")) and (.jobs.verify.steps[0] | has("uses")) and (.jobs.verify.steps[0] | has("with")) and (.jobs.verify.steps[0].name == "Check out exact release") and (.jobs.verify.steps[0].uses == strenv(checkout_action)) and ((.jobs.verify.steps[0].with | keys | length) == 1) and (.jobs.verify.steps[0].with | has("persist-credentials")) and (.jobs.verify.steps[0].with."persist-credentials" == false)' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.verify.steps[1] | keys | length) == 3) and (.jobs.verify.steps[1] | has("name")) and (.jobs.verify.steps[1] | has("uses")) and (.jobs.verify.steps[1] | has("with")) and (.jobs.verify.steps[1].name == "Install Nix with public cache") and (.jobs.verify.steps[1].uses == strenv(install_nix_action)) and ((.jobs.verify.steps[1].with | keys | length) == 1) and (.jobs.verify.steps[1].with | has("extra_nix_config")) and (.jobs.verify.steps[1].with.extra_nix_config == strenv(expected_extra_nix_config))' "$candidate" >/dev/null || return 1
      yq -e '((.jobs.verify.steps[2] | keys | length) == 2) and (.jobs.verify.steps[2] | has("name")) and (.jobs.verify.steps[2] | has("run")) and (.jobs.verify.steps[2].name == "Substitute without builders") and (.jobs.verify.steps[2].run == strenv(expected_verify))' "$candidate" >/dev/null || return 1

      yq -e '[.. | select(tag == "!!str") | select(test("\\$\\{\\{[[:space:]]*secrets[[:space:]]*(\\.|\\[)"))] | length == 1' "$candidate" >/dev/null || return 1
    }

    assert_rejected() {
      description="$1"
      mutation="$2"
      rm -f mutant.yml
      cp "$workflow" mutant.yml
      yq -i "$mutation" mutant.yml
      if validate_workflow mutant.yml; then
        echo "contract accepted adversarial mutation: $description" >&2
        return 1
      fi
    }

    validate_ci() {
      yq -e '[.. | select(tag == "!!str") | select(test("\\$\\{\\{[[:space:]]*secrets[[:space:]]*(\\.|\\[)"))] | length == 0' "$1" >/dev/null
    }

    assert_ci_rejected() {
      description="$1"
      mutation="$2"
      rm -f ci-mutant.yml
      cp "$ci" ci-mutant.yml
      yq -i "$mutation" ci-mutant.yml
      if validate_ci ci-mutant.yml; then
        echo "CI contract accepted adversarial mutation: $description" >&2
        return 1
      fi
    }

    validate_workflow "$workflow"

    assert_rejected "extra permission" '.permissions.actions = "read"'
    assert_rejected "top-level concurrency" '.concurrency = {"group": "publish-package-main", "cancel-in-progress": false}'
    assert_rejected "wrong checkout action pin" '.jobs.publish.steps[0].uses = "actions/checkout@0000000000000000000000000000000000000000"'
    assert_rejected "persisted credentials enabled" '.jobs.publish.steps[0].with."persist-credentials" = true'
    assert_rejected "persist-credentials missing" 'del(.jobs.verify.steps[0].with."persist-credentials")'
    assert_rejected "wrong build package attribute" '(.jobs.publish.steps[] | select(.id == "package").run) |= sub("x86_64-linux.default"; "x86_64-linux.wrong")'
    assert_rejected "altered build script" '(.jobs.publish.steps[] | select(.id == "package").run) += "echo altered\\n"'
    assert_rejected "missing verify dependency" 'del(.jobs.verify.needs)'
    assert_rejected "wrong Cachix URL" '(.jobs.verify.steps[] | select(.uses == strenv(install_nix_action)).with.extra_nix_config) |= sub("https://jonathanmoregard.cachix.org"; "https://wrong.example")'
    assert_rejected "wrong cache.nixos.org public key" '(.jobs.verify.steps[] | select(.uses == strenv(install_nix_action)).with.extra_nix_config) |= sub("6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="; "6NCHdD59X431o0gWypbqbrmckqfmq0nFpwH9x8gs6Ro=")'
    assert_rejected "conditional required step" '.jobs.publish.steps[0].if = "always()"'
    assert_rejected "verify continue-on-error" '.jobs.verify.steps[2].continue-on-error = true'
    assert_rejected "extra run step" '.jobs.verify.steps += [{"name": "Unexpected run", "run": "true"}]'
    assert_rejected "job permissions write" '.jobs.publish.permissions = {"contents": "write"}'
    assert_rejected "job NIX_CONFIG environment" '.jobs.verify.env.NIX_CONFIG = "sandbox = false"'
    assert_rejected "top-level NIX_CONFIG environment" '.env.NIX_CONFIG = "sandbox = false"'
    assert_rejected "bracket-syntax extra secret" '.jobs.verify.steps[2].name = "''${{ secrets[\"EXTRA\"] }}"'
    assert_rejected "unexpected extra job with action" '.jobs.audit = {"runs-on": "ubuntu-latest", "steps": [{"uses": "example/action@0000000000000000000000000000000000000000"}]}'
    assert_rejected "unexpected extra action" '.jobs.verify.steps += [{"name": "Unexpected action", "uses": "example/action@0000000000000000000000000000000000000000"}]'

    validate_ci "$ci"
    assert_ci_rejected "dot-syntax secret reference" '.env.EXTRA = "''${{ secrets.OTHER_TOKEN }}"'
    assert_ci_rejected "bracket-syntax secret reference" '.env.EXTRA = "''${{ secrets[\"OTHER_TOKEN\"] }}"'
    touch "$out"
  ''
