{ pkgs }:

pkgs.runCommand "smarthome-publish-workflow-contract"
  { nativeBuildInputs = [ pkgs.yq-go ]; }
  ''
    ci=${../../.github/workflows/ci.yml}
    publish=${../../.github/workflows/publish.yml}

    assert_pinned_actions() {
      candidate="$1"
      while IFS= read -r action; do
        [[ "$action" =~ ^[^@]+@[0-9a-f]{40}$ ]] || {
          echo "action is not pinned by full commit: $action" >&2
          return 1
        }
      done < <(yq -r '.. | select(tag == "!!map" and has("uses")) | .uses' "$candidate")
    }

    assert_no_secrets() {
      candidate="$1"
      if yq -r '.. | select(tag == "!!str")' "$candidate" \
        | grep -Ei '\$\{\{[^}]*[Ss][Ee][Cc][Rr][Ee][Tt][Ss]([^[:alnum:]_]|$)' \
          >/dev/null; then
        return 1
      fi
      test "$(yq -r '[.. | select(tag == "!!map") | keys[] | select(. == "secrets")] | length' "$candidate")" -eq 0 \
        || return 1
    }

    assert_no_continue_on_error() {
      candidate="$1"
      test "$(yq -r '[.. | select(tag == "!!map" and has("continue-on-error"))] | length' "$candidate")" -eq 0 \
        || return 1
    }

    validate_ci() {
      candidate="$1"

      yq -e '
        .name == "CI" and
        ((.permissions | keys | join(",")) == "contents") and
        (.permissions.contents == "read") and
        (.on | has("push")) and
        (.on | has("pull_request")) and
        ((.jobs | keys | sort | join(",")) == "app,ci,classify,evaluate,system")
      ' "$candidate" >/dev/null || return 1
      yq -e '
        (.jobs.classify.outputs.app == "''${{ steps.changes.outputs.app }}") and
        (.jobs.classify.outputs.system == "''${{ steps.changes.outputs.system }}") and
        (.jobs.classify.steps[] | select(.id == "changes") | .run | contains("classify-paths.sh")) and
        (.jobs.evaluate.steps[] | select(has("run")) | .run | contains("nix flake check --no-build"))
      ' "$candidate" >/dev/null || return 1
      yq -e '
        (.jobs.app.needs == "classify") and
        (.jobs.app.if | (contains("needs.classify.outputs.app") and contains("true"))) and
        (.jobs.app.steps[] | select(has("run")) | .run | contains("checks.x86_64-linux.app-source")) and
        (.jobs.app.steps[] | select(has("run")) | .run | contains("checks.x86_64-linux.simulated-house")) and
        (.jobs.system.needs == "classify") and
        (.jobs.system.if | (contains("needs.classify.outputs.system") and contains("true"))) and
        (.jobs.system.steps[] | select(has("run")) | .run | contains("nixosConfigurations.home-server.config.system.build.toplevel")) and
        (.jobs.system.steps[] | select(has("run")) | .run | contains("checks.x86_64-linux.vm-home-server")) and
        (.jobs.system.steps[] | select(has("run")) | .run | contains("checks.x86_64-linux.vm-home-server-cd"))
      ' "$candidate" >/dev/null || return 1
      yq -e '
        (.jobs.ci.if == "always()") and
        ((.jobs.ci.needs | sort | join(",")) == "app,classify,evaluate,system") and
        (.jobs.ci.steps | length == 1) and
        (.jobs.ci.steps[0].env.EVALUATE_RESULT == "''${{ needs.evaluate.result }}") and
        (.jobs.ci.steps[0].env.APP_RESULT == "''${{ needs.app.result }}") and
        (.jobs.ci.steps[0].env.SYSTEM_RESULT == "''${{ needs.system.result }}") and
        (.jobs.ci.steps[0].run | contains("cancelled")) and
        (.jobs.ci.steps[0].run | contains("failure"))
      ' "$candidate" >/dev/null || return 1
      assert_pinned_actions "$candidate" || return 1
      assert_no_secrets "$candidate" || return 1
      assert_no_continue_on_error "$candidate" || return 1
    }

    validate_publish() {
      candidate="$1"

      yq -e '
        .name == "Publish releases" and
        ((.permissions | keys | join(",")) == "contents") and
        (.permissions.contents == "read") and
        ((.on | keys | join(",")) == "push") and
        ((.on.push.branches | join(",")) == "main") and
        ((.jobs | keys | sort | join(",")) == "classify,promote-app,promote-system,publish-app,publish-system,verify-app,verify-system")
      ' "$candidate" >/dev/null || return 1
      yq -e '
        (.jobs.classify.outputs.app == "''${{ steps.changes.outputs.app }}") and
        (.jobs.classify.outputs.system == "''${{ steps.changes.outputs.system }}") and
        (.jobs.classify.steps[] | select(.id == "changes") | .run | contains("classify-paths.sh"))
      ' "$candidate" >/dev/null || return 1

      for track in app system; do
        if [[ "$track" == app ]]; then
          release_ref=app
        else
          release_ref=home-server
        fi
        yq -e ".jobs.\"publish-$track\".needs == \"classify\"" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"publish-$track\".if | contains(\"needs.classify.outputs.$track == 'true'\")" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"publish-$track\".steps[] | select(has(\"run\")) | .run | contains(\"push-closure.sh\")" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"verify-$track\".needs == \"publish-$track\"" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"verify-$track\" | (has(\"if\") | not)" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"promote-$track\".needs == \"verify-$track\"" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"promote-$track\" | (has(\"if\") | not)" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"promote-$track\".permissions | (((keys | join(\",\")) == \"contents\") and (.contents == \"write\"))" "$candidate" >/dev/null || return 1
        yq -e ".jobs.\"promote-$track\".steps[] | select(has(\"run\")) | .run | contains(\"promote-release-ref.sh release/$release_ref\")" "$candidate" >/dev/null || return 1
      done

      yq -e '
        (.jobs."publish-app".steps[] | select(has("run")) | .run | contains("packages.x86_64-linux.default")) and
        (.jobs."publish-system".steps[] | select(has("run")) | .run | contains("nixosConfigurations.home-server.config.system.build.toplevel"))
      ' "$candidate" >/dev/null || return 1

      for track in app system; do
        verify_script="$(yq -r ".jobs.\"verify-$track\".steps[] | select(has(\"run\")) | .run" "$candidate")"
        grep -Fq 'https://jonathanmoregard.cachix.org' <<<"$verify_script" || return 1
        grep -Fq 'https://cache.nixos.org' <<<"$verify_script" || return 1
        grep -Fq 'jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=' <<<"$verify_script" || return 1
        grep -Fq 'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=' <<<"$verify_script" || return 1
        grep -Fq 'nix path-info --store https://jonathanmoregard.cachix.org' <<<"$verify_script" || return 1
        grep -Fq 'nix store verify' <<<"$verify_script" || return 1
        grep -Fq -- '--no-contents --sigs-needed 1' <<<"$verify_script" || return 1
        grep -Fq -- '--option trusted-public-keys "$project_key" "$root"' <<<"$verify_script" || return 1
        grep -Fq -- '--option max-jobs 0' <<<"$verify_script" || return 1
        grep -Fq -- '--option fallback false' <<<"$verify_script" || return 1
        grep -Fq -- '--option builders ""' <<<"$verify_script" || return 1
      done

      test "$(yq -r '[.jobs[] | select(.permissions.contents == "write")] | length' "$candidate")" -eq 2 || return 1
      assert_pinned_actions "$candidate" || return 1
      assert_no_continue_on_error "$candidate" || return 1
    }

    assert_rejected() {
      validator="$1"
      source="$2"
      description="$3"
      mutation="$4"
      rm -f mutant.yml
      cp "$source" mutant.yml
      chmod u+w mutant.yml
      yq -i "$mutation" mutant.yml
      if "$validator" mutant.yml; then
        echo "contract accepted adversarial mutation: $description" >&2
        return 1
      fi
    }

    validate_ci "$ci"
    validate_publish "$publish"

    assert_rejected validate_ci "$ci" "PR secret use" '.jobs.app.env.TOKEN = "''${{ secrets.CACHIX_AUTH_TOKEN }}"'
    assert_rejected validate_ci "$ci" "PR secret object use" '.jobs.app.env.TOKEN = "''${{ toJSON(secrets) }}"'
    assert_rejected validate_ci "$ci" "unstable summary" '.jobs.ci.if = "success()"'
    assert_rejected validate_ci "$ci" "app check silently tolerated" '.jobs.app."continue-on-error" = true'
    assert_rejected validate_ci "$ci" "expression-controlled app failure" '.jobs.app."continue-on-error" = "''${{ true }}"'
    assert_rejected validate_ci "$ci" "system VM omitted" '(.jobs.system.steps[] | select(has("run")) | .run) |= sub("checks.x86_64-linux.vm-home-server-cd"; "checks.x86_64-linux.standalone-host")'

    assert_rejected validate_publish "$publish" "missing official cache" '(.jobs."verify-app".steps[] | select(has("run")) | .run) |= sub("https://cache.nixos.org"; "")'
    assert_rejected validate_publish "$publish" "wrong official key" '(.jobs."verify-system".steps[] | select(has("run")) | .run) |= sub("6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="; "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")'
    assert_rejected validate_publish "$publish" "missing project root proof" '(.jobs."verify-app".steps[] | select(has("run")) | .run) |= sub("nix path-info --store https://jonathanmoregard.cachix.org"; "nix path-info")'
    assert_rejected validate_publish "$publish" "vacuous signature threshold" '(.jobs."verify-app".steps[] | select(has("run")) | .run) |= sub("--sigs-needed 1"; "--sigs-needed 0")'
    assert_rejected validate_publish "$publish" "builders enabled" '(.jobs."verify-system".steps[] | select(has("run")) | .run) |= sub("--option max-jobs 0"; "")'
    assert_rejected validate_publish "$publish" "verification skipped" '.jobs."verify-app".if = "false"'
    assert_rejected validate_publish "$publish" "promotion before verification" '.jobs."promote-system".needs = "publish-system"'
    assert_rejected validate_publish "$publish" "raw main deployment" '(.jobs."promote-app".steps[] | select(has("run")) | .run) = "gh api repos/$GITHUB_REPOSITORY/git/refs/heads/main"'
    assert_rejected validate_publish "$publish" "extra write permission" '.jobs."publish-app".permissions = {"contents": "write"}'

    touch "$out"
  ''
