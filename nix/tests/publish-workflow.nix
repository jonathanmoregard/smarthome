{ pkgs }:

pkgs.runCommand "smarthome-publish-workflow-contract"
  { nativeBuildInputs = [ pkgs.yq-go ]; }
  ''
    workflow=${../../.github/workflows/publish.yml}
    ci=${../../.github/workflows/ci.yml}

    yq -e '(.on | keys) == ["push"]' "$workflow" >/dev/null
    yq -e '(.on.push | keys) == ["branches"]' "$workflow" >/dev/null
    yq -e '.on.push.branches == ["main"]' "$workflow" >/dev/null
    yq -e '.permissions.contents == "read"' "$workflow" >/dev/null
    yq -e '[.jobs.publish.steps[] | select(.uses == "cachix/cachix-action@1eb2ef646ac0255473d23a5907ad7b04ce94065c") | select(.with.authToken == "''${{ secrets.CACHIX_AUTH_TOKEN }}")] | length == 1' "$workflow" >/dev/null
    yq -e '[.. | select(tag == "!!str" and contains("''${{ secrets.CACHIX_AUTH_TOKEN }}"))] | length == 1' "$workflow" >/dev/null
    yq -e '[.jobs.publish.steps[].run] | any(. == "cachix push jonathanmoregard \"''${{ steps.package.outputs.path }}\"")' "$workflow" >/dev/null
    yq -e '[.jobs.verify.steps[].run] | any(test("max-jobs 0") and test("fallback false") and test("builders \\\"\\\""))' "$workflow" >/dev/null
    ! grep -q 'CACHIX_AUTH_TOKEN' "$ci"
    touch "$out"
  ''
