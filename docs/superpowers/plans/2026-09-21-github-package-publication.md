# GitHub Package Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every merged smarthome package on GitHub, publish its signed runtime closure to Cachix, and prove a fresh runner can substitute it with all builders disabled.

**Architecture:** Pull requests keep using the secret-free flake check. A separate `main`-only workflow builds the exact package output, pushes it with a cache-scoped secret, then verifies the release from a clean job using `max-jobs = 0`. A Nix check parses the workflow so future edits cannot silently expose the secret or remove the cache-only verification boundary.

**Tech Stack:** GitHub Actions, Nix flakes, Cachix, `yq-go`

---

## File map

- `.github/workflows/publish.yml`: production publication and clean-runner substitution proof.
- `nix/tests/publish-workflow.nix`: evaluated workflow security and behavior contract.
- `flake.nix`: exposes the workflow contract as `checks.x86_64-linux.publish-workflow`.
- `README.md`: concise release/deployment ownership and required-secret documentation.

### Task 1: Add a failing publication contract

**Files:**
- Create: `nix/tests/publish-workflow.nix`
- Modify: `flake.nix`

- [ ] **Step 1: Write the workflow contract before the workflow exists**

Create `nix/tests/publish-workflow.nix`:

```nix
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
```

Add to `checks.${system}` in `flake.nix`:

```nix
publish-workflow = import ./nix/tests/publish-workflow.nix { inherit pkgs; };
```

- [ ] **Step 2: Stage new file and prove red state**

Run:

```bash
git add nix/tests/publish-workflow.nix flake.nix
nix build --no-link .#checks.x86_64-linux.publish-workflow -L
```

Expected: FAIL because `.github/workflows/publish.yml` does not exist.

- [ ] **Step 3: Parse and diff-check edited Nix**

Run:

```bash
nix-instantiate --parse flake.nix >/dev/null
nix-instantiate --parse nix/tests/publish-workflow.nix >/dev/null
git diff --check
```

Expected: both parsers and diff check exit 0.

- [ ] **Step 4: Commit red test**

```bash
git commit -m "test(ci): define package publication contract"
```

### Task 2: Publish and verify the exact package closure

**Files:**
- Create: `.github/workflows/publish.yml`
- Test: `nix/tests/publish-workflow.nix`

- [ ] **Step 1: Add the main-only publisher**

Create `.github/workflows/publish.yml`:

```yaml
name: Publish package

on:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: publish-package-main
  cancel-in-progress: false

jobs:
  publish:
    name: build and publish package
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - name: Check out exact release
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - name: Install Nix
        uses: cachix/install-nix-action@ba0dd844c9180cbf77aa72a116d6fbc515d0e87b # v27
      - name: Configure authenticated Cachix publication
        uses: cachix/cachix-action@1eb2ef646ac0255473d23a5907ad7b04ce94065c # v17
        with:
          name: jonathanmoregard
          authToken: ${{ secrets.CACHIX_AUTH_TOKEN }}
          skipPush: true
      - name: Build exact package
        id: package
        run: |
          set -euo pipefail
          package="$(nix build --no-link --print-out-paths .#packages.x86_64-linux.default)"
          test "$(printf '%s\n' "$package" | wc -l)" -eq 1
          printf 'path=%s\n' "$package" >> "$GITHUB_OUTPUT"
      - name: Push signed runtime closure
        run: cachix push jonathanmoregard "${{ steps.package.outputs.path }}"

  verify:
    name: verify cache-only substitution
    needs: publish
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Check out exact release
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - name: Install Nix with public cache
        uses: cachix/install-nix-action@ba0dd844c9180cbf77aa72a116d6fbc515d0e87b # v27
        with:
          extra_nix_config: |
            substituters = https://cache.nixos.org/ https://jonathanmoregard.cachix.org
            trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbqbrmckqfmq0nFpwH9x8gs6Ro= jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=
      - name: Substitute without builders
        run: >-
          nix build --no-link
          --option max-jobs 0
          --option fallback false
          --option builders ""
          .#packages.x86_64-linux.default
```

- [ ] **Step 2: Run contract and full flake gates**

Run:

```bash
git add .github/workflows/publish.yml
nix build --no-link .#checks.x86_64-linux.publish-workflow -L
nix flake check -L
git diff --check
```

Expected: PASS. Workflow contract proves release trigger and secret boundary; full app checks remain green.

- [ ] **Step 3: Commit publisher**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: publish signed smarthome package"
```

### Task 3: Document release ownership and credential scope

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add deployment section**

Append:

```markdown
## Releases

Pull requests run the complete flake check without credentials. Merges to
protected `main` build `packages.x86_64-linux.default` on GitHub, push its
signed runtime closure to `jonathanmoregard.cachix.org`, then prove a clean
runner can substitute it with builders disabled.

`CACHIX_AUTH_TOKEN` is a cache-scoped GitHub Actions secret used only by the
`main` publication workflow. Home-server never receives that write token. It
uses a separate read-only GitHub deploy key and the public Cachix signing key,
pulls the exact `main` commit, and atomically switches a dedicated app profile.
Application publication does not use dellan.
```

- [ ] **Step 2: Check documentation and regression gate**

Run:

```bash
git diff --check
nix build --no-link .#checks.x86_64-linux.publish-workflow -L
```

Expected: PASS.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain direct release pipeline"
```

### Task 4: Provision and observe publication

**External state:**
- GitHub Actions secret: `CACHIX_AUTH_TOKEN`
- GitHub branch protection: `main`

- [ ] **Step 1: Obtain explicit credential authorization**

Pause before decrypting, copying, creating, or uploading any Cachix token. Ask
one question: permission to install the existing cache-scoped token as the
smarthome repository's `CACHIX_AUTH_TOKEN` secret.

- [ ] **Step 2: Install only the authorized secret**

Pipe the existing agenix-managed cache token directly to GitHub so it never
appears in shell arguments, logs, commits, chat, or a plaintext disk file:

```bash
nix run nixpkgs#agenix -- \
  -d /home/jonathan/Repos/nixos-config-worktrees/smarthome-direct-deploy/secrets/cachix-auth-token.age \
  | gh secret set CACHIX_AUTH_TOKEN --repo jonathanmoregard/smarthome
```

Expected: `gh secret list --repo jonathanmoregard/smarthome` lists the name,
not the value.

- [ ] **Step 3: Push branch and open pull request**

```bash
git push -u origin feat/direct-deploy
gh pr create --base main --head feat/direct-deploy \
  --title "ci: publish smarthome releases for direct deployment" \
  --body 'Builds merged app releases on GitHub, publishes the signed runtime closure to Cachix, and verifies cache-only substitution with builders disabled. Server-side activation ships separately in nixos-config.'
```

- [ ] **Step 4: Protect production release branch**

Run:

```bash
gh api --method PUT repos/jonathanmoregard/smarthome/branches/main/protection \
  -F 'required_status_checks[strict]=true' \
  -F 'required_status_checks[contexts][]=nix flake check' \
  -F 'enforce_admins=true' \
  -F 'required_pull_request_reviews[required_approving_review_count]=0' \
  -F 'required_pull_request_reviews[dismiss_stale_reviews]=true' \
  -F 'required_pull_request_reviews[require_code_owner_reviews]=false' \
  -F 'required_pull_request_reviews[require_last_push_approval]=false' \
  -F 'restrictions=' \
  -F 'required_conversation_resolution=true' \
  -F 'allow_force_pushes=false' \
  -F 'allow_deletions=false'
gh api repos/jonathanmoregard/smarthome/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts, force_pushes: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
```

Expected: strict status checks are enabled for `nix flake check`; force pushes
and branch deletion are false.

- [ ] **Step 5: Observe hosted checks without merging**

Run:

```bash
gh pr checks --watch
```

Expected: pull-request flake check and workflow contract pass. Publication does
not run until a human merges to `main`; after that merge, both `build and
publish package` and `verify cache-only substitution` must pass before server
activation is enabled.
