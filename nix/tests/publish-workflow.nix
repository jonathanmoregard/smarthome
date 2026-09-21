{ pkgs }:

pkgs.runCommand "smarthome-publish-workflow-contract"
  { nativeBuildInputs = [ pkgs.yq-go ]; }
  ''
    workflow=${../../.github/workflows/publish.yml}
    ci=${../../.github/workflows/ci.yml}
    expected_push='cachix push jonathanmoregard "''${{ steps.package.outputs.path }}"'
    expected_verify='nix build --no-link --option max-jobs 0 --option fallback false --option builders "" .#packages.x86_64-linux.default'
    export expected_push expected_verify

    yq -e '((.on | keys | length) == 1) and (.on | has("push"))' "$workflow" >/dev/null
    yq -e '((.on.push | keys | length) == 1) and (.on.push | has("branches"))' "$workflow" >/dev/null
    yq -e '((.on.push.branches | length) == 1) and (.on.push.branches[0] == "main")' "$workflow" >/dev/null
    yq -e '.permissions.contents == "read"' "$workflow" >/dev/null
    yq -e '(.jobs.publish | has("if") | not) and (.jobs.verify | has("if") | not)' "$workflow" >/dev/null
    yq -e '[.jobs.publish.steps[] | select(.uses == "cachix/cachix-action@1eb2ef646ac0255473d23a5907ad7b04ce94065c") | select(.with.authToken == "''${{ secrets.CACHIX_AUTH_TOKEN }}") | select(has("if") | not)] | length == 1' "$workflow" >/dev/null
    yq -e '[.. | select(tag == "!!str" and contains("''${{ secrets.CACHIX_AUTH_TOKEN }}"))] | length == 1' "$workflow" >/dev/null
    yq -e '[.jobs.publish.steps[] | select(.run == strenv(expected_push)) | select(has("if") | not)] | length == 1' "$workflow" >/dev/null
    yq -e '[.jobs.verify.steps[] | select(.run == strenv(expected_verify)) | select(has("if") | not)] | length == 1' "$workflow" >/dev/null
    ! grep -q 'CACHIX_AUTH_TOKEN' "$ci"
    touch "$out"
  ''
