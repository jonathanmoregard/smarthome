{ pkgs }:

pkgs.runCommand "smarthome-publish-workflow-contract"
  { nativeBuildInputs = [ pkgs.yq-go ]; }
  ''
    workflow=${../../.github/workflows/publish.yml}
    ci=${../../.github/workflows/ci.yml}

    yq -e '.on.push.branches == ["main"]' "$workflow" >/dev/null
    yq -e '.on | has("pull_request") | not' "$workflow" >/dev/null
    yq -e '.permissions.contents == "read"' "$workflow" >/dev/null
    yq -e '[.jobs.publish.steps[].with.authToken] | any(. == "''${{ secrets.CACHIX_AUTH_TOKEN }}")' "$workflow" >/dev/null
    yq -e '[.jobs.publish.steps[].run] | any(. == "cachix push jonathanmoregard \"''${{ steps.package.outputs.path }}\"")' "$workflow" >/dev/null
    yq -e '[.jobs.verify.steps[].run] | any(test("max-jobs 0") and test("fallback false") and test("builders \\\"\\\""))' "$workflow" >/dev/null
    ! grep -q 'CACHIX_AUTH_TOKEN' "$ci"
    touch "$out"
  ''
