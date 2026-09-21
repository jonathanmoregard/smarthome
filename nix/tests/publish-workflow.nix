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

      yq -e '((.on | keys | length) == 1) and (.on | has("push"))' "$candidate" >/dev/null || return 1
      yq -e '((.on.push | keys | length) == 1) and (.on.push | has("branches"))' "$candidate" >/dev/null || return 1
      yq -e '((.on.push.branches | length) == 1) and (.on.push.branches[0] == "main")' "$candidate" >/dev/null || return 1
      yq -e '((.permissions | keys | length) == 1) and (.permissions | has("contents")) and (.permissions.contents == "read")' "$candidate" >/dev/null || return 1
      yq -e 'has("concurrency") | not' "$candidate" >/dev/null || return 1
      yq -e '(.jobs.publish | has("if") | not) and (.jobs.verify | has("if") | not)' "$candidate" >/dev/null || return 1
      yq -e '([.jobs.publish.steps[] | select(has("if"))] | length == 0) and ([.jobs.verify.steps[] | select(has("if"))] | length == 0)' "$candidate" >/dev/null || return 1

      yq -e '[.jobs.publish.steps[] | select(.uses == strenv(checkout_action))] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.publish.steps[] | select(.uses == strenv(checkout_action)) | select(.with."persist-credentials" == false) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.verify.steps[] | select(.uses == strenv(checkout_action))] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.verify.steps[] | select(.uses == strenv(checkout_action)) | select(.with."persist-credentials" == false) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1

      yq -e '[.jobs.publish.steps[] | select(.uses == strenv(install_nix_action))] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.publish.steps[] | select(.uses == strenv(install_nix_action)) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.verify.steps[] | select(.uses == strenv(install_nix_action))] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.verify.steps[] | select(.uses == strenv(install_nix_action)) | select(.with.extra_nix_config == strenv(expected_extra_nix_config)) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1

      yq -e '[.jobs.publish.steps[] | select(.uses == strenv(cachix_action))] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.publish.steps[] | select(.uses == strenv(cachix_action)) | select((.with | keys | length) == 3) | select(.with.name == "jonathanmoregard") | select(.with.authToken == "''${{ secrets.CACHIX_AUTH_TOKEN }}") | select(.with.skipPush == true) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.. | select(tag == "!!str") | select(test("\\$\\{\\{[[:space:]]*secrets\\."))] | length == 1' "$candidate" >/dev/null || return 1

      yq -e '[.jobs.publish.steps[] | select(.id == "package")] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.publish.steps[] | select(.id == "package") | select(.run == strenv(expected_build)) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.publish.steps[] | select(.run == strenv(expected_push)) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1

      yq -e '.jobs.verify.needs == "publish"' "$candidate" >/dev/null || return 1
      yq -e '[.jobs.verify.steps[] | select(.run == strenv(expected_verify)) | select(has("if") | not)] | length == 1' "$candidate" >/dev/null || return 1
    }

    assert_rejected() {
      description="$1"
      mutation="$2"
      cp "$workflow" mutant.yml
      yq -i "$mutation" mutant.yml
      if validate_workflow mutant.yml; then
        echo "contract accepted adversarial mutation: $description" >&2
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

    ! grep -q 'CACHIX_AUTH_TOKEN' "$ci"
    touch "$out"
  ''
