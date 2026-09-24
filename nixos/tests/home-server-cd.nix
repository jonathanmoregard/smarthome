# vm-home-server-cd: exercise both promoted deployment tracks against a real
# local Git origin, real profiles, and real NixOS generation switches.
{
  pkgsSystem,
  agenix,
  inputSources,
  homeServerCdSystem,
  homeServerCdBadSystem,
  homeServerCdV2System,
}:

let
  repositorySource = ../..;
in
pkgsSystem.testers.runNixOSTest {
  name = "vm-home-server-cd";
  skipTypeCheck = true;

  nodes.home-server =
    { lib, ... }:
    {
      imports = [
        agenix.nixosModules.default
        ../hosts/home-server/default.nix
        ./fixtures/home-server-cd-module.nix
      ];

      # The host module records self.rev when it is evaluated by a flake. The
      # test node is evaluated directly by runNixOSTest, so provide the same
      # argument without coupling the lane to the outer flake object.
      _module.args.self = { };

      # The guest must only evaluate already-built release closures. Retain
      # every flake input and candidate system in its store; the deployers
      # themselves still run with max-jobs=0, fallback=false, and no builders.
      system.extraDependencies = inputSources ++ [
        homeServerCdSystem
        homeServerCdBadSystem
        homeServerCdV2System
        pkgsSystem.stdenvNoCC
      ];
      environment.etc."home-server-cd-source".source = repositorySource;

      virtualisation = {
        cores = 4;
        memorySize = 8192;
        diskSize = 131072;
      };
    };

  testScript = ''
    import json
    from shlex import quote

    WORK = "/var/lib/home-server-cd/work"
    ORIGIN = "/var/lib/home-server-cd-origin.git"
    APP_PROFILE = "/nix/var/nix/profiles/smarthome"
    SYSTEM_PROFILE = "/nix/var/nix/profiles/system"
    APP_STATE = "/var/lib/smarthome-deploy"
    SYSTEM_STATE = "/var/lib/smarthome-system-deploy"
    APP_RELEASE = WORK + "/nixos/tests/fixtures/home-server-cd-release/app-path"
    SYSTEM_RELEASE = WORK + "/nixos/tests/fixtures/home-server-cd-release/system-state"
    LOCK = "/run/smarthome-deploy/deploy.lock"

    def profile_path(profile):
        return home_server.succeed(f"readlink -f {quote(profile)}").strip()

    def current_generation(profile):
        return int(home_server.succeed(
            f"nix-env --list-generations -p {quote(profile)} "
            "| awk '/\\(current\\)/ {print $1}'"
        ))

    def generation_count(profile):
        output = home_server.succeed(
            f"nix-env --list-generations -p {quote(profile)} "
            "| awk '$1 ~ /^[0-9]+$/ {count++} END {print count+0}'"
        )
        return int(output)

    def marker_field(path, field):
        return home_server.succeed(
            f"awk -F= -v wanted={quote(field)} "
            "'$1 == wanted {print substr($0, index($0, \"=\") + 1); exit}' "
            f"{quote(path)}"
        ).strip()

    def unit_state(unit):
        return home_server.succeed(
            f"systemctl show --property=ActiveState --value {quote(unit)}"
        ).strip()

    def service_executable(unit):
        return home_server.succeed(
            f"systemctl show -P ExecStart {quote(unit)} "
            "| sed -n 's/^{ path=\\([^ ;]*\\).*/\\1/p'"
        ).strip()

    def git_commit(message, app_path=None, system_state=None):
        if app_path is not None:
            home_server.succeed(
                f"printf '%s\\n' {quote(app_path)} > {quote(APP_RELEASE)}"
            )
        if system_state is not None:
            home_server.succeed(
                f"printf '%s\\n' {quote(system_state)} > {quote(SYSTEM_RELEASE)}"
            )
        home_server.succeed(
            f"git -C {quote(WORK)} add nixos/tests/fixtures/home-server-cd-release "
            f"&& git -C {quote(WORK)} commit -q -m {quote(message)}"
        )
        return home_server.succeed(f"git -C {quote(WORK)} rev-parse HEAD").strip()

    def promote(*refs):
        refspecs = " ".join(
            quote(f"HEAD:refs/heads/{ref}") for ref in refs
        )
        home_server.succeed(
            f"git -C {quote(WORK)} push -q origin {refspecs}"
        )

    def diagnostics(label):
        print(f"[diag] ===== {label} =====")
        print("[diag] profiles/generations:\n" + home_server.succeed(
            "for p in /nix/var/nix/profiles/system /nix/var/nix/profiles/smarthome; do "
            "echo PROFILE=$p TARGET=$(readlink -f $p 2>/dev/null || true); "
            "nix-env --list-generations -p $p 2>&1 || true; done"
        ))
        print("[diag] release refs:\n" + home_server.succeed(
            f"git --git-dir={quote(ORIGIN)} show-ref 2>&1 || true"
        ))
        print("[diag] deployment state:\n" + home_server.succeed(
            "for d in /var/lib/smarthome-deploy /var/lib/smarthome-system-deploy; do "
            "echo STATE=$d; "
            "if test -d $d; then find $d -maxdepth 1 -type f -printf '%f\\n' | sort; fi; "
            "for f in last-success last-failure pending-activation; do "
            "test ! -f $d/$f || { echo FILE=$d/$f; cat $d/$f; }; done; done; "
            "echo RUNNING=$(readlink -f /run/current-system 2>/dev/null || true); "
            "echo SYSTEM_STATE=$(cat /etc/home-server-cd/system-state 2>/dev/null || true); "
            "echo ACTIVATION_SENTINEL; cat /run/home-server-cd-activation 2>/dev/null || true; "
            "echo HYDRATOR_LOG; tail -n 40 /var/lib/home-server-cd/hydrator.log 2>/dev/null || true"
        ))
        print("[diag] deployment units:\n" + home_server.succeed(
            "systemctl --no-pager --full status app-deploy.service system-deploy.service "
            "app-deploy.timer system-deploy.timer smarthome-deploy.timer nixos-deploy.timer "
            "2>&1 || true"
        ))
        print("[diag] failed units:\n" + home_server.succeed(
            "systemctl --failed --no-pager --full 2>&1 || true"
        ))
        print("[diag] app journal:\n" + home_server.succeed(
            "journalctl -u app-deploy.service -n 120 --no-pager 2>&1 || true"
        ))
        print("[diag] system journal:\n" + home_server.succeed(
            "journalctl -u system-deploy.service -n 180 --no-pager 2>&1 || true"
        ))

    def assert_no_failed(label):
        diagnostics(label)
        failed = home_server.succeed(
            "systemctl --failed --no-legend --plain || true"
        ).strip()
        assert failed == "", failed

    start_all()
    home_server.wait_for_unit("multi-user.target")
    home_server.wait_for_unit("mosquitto.service")
    home_server.wait_for_unit("sshd.service")
    home_server.wait_for_unit("tailscaled.service")
    home_server.wait_for_unit("house-automationd.service")
    home_server.wait_until_succeeds(
        "curl -fsS http://127.0.0.1:9876/healthz >/dev/null", timeout=60
    )

    # Boot-time agenix state must survive the system switch below. Never print
    # the secret; retain only its digest.
    secret_digest = home_server.succeed(
        "sha256sum /run/agenix/home-server-cd-secret | awk '{print $1}'"
    ).strip()
    assert secret_digest, "empty agenix fixture secret"

    # Create one real local origin. main is the ancestry authority while each
    # promoted ref advances independently through the scenario.
    app_v1 = home_server.succeed("cat /etc/home-server-cd/app-v1-path").strip()
    app_v2 = home_server.succeed("cat /etc/home-server-cd/app-v2-path").strip()
    app_broken = home_server.succeed("cat /etc/home-server-cd/app-broken-path").strip()
    home_server.succeed(
        f"install -d -m 0755 {quote(WORK)} "
        f"&& cp -aL /etc/home-server-cd-source/. {quote(WORK)}/ "
        f"&& chmod -R u+w {quote(WORK)} "
        f"&& printf '%s\\n' {quote(app_v1)} > {quote(APP_RELEASE)} "
        f"&& printf '%s\\n' legacy > {quote(SYSTEM_RELEASE)} "
        f"&& git -C {quote(WORK)} init -q -b main "
        f"&& git -C {quote(WORK)} config user.email cd-vm@example.invalid "
        f"&& git -C {quote(WORK)} config user.name cd-vm "
        f"&& git -C {quote(WORK)} add -A "
        f"&& git -C {quote(WORK)} commit -q -m legacy"
    )
    legacy_revision = home_server.succeed(
        f"git -C {quote(WORK)} rev-parse HEAD"
    ).strip()
    home_server.succeed(
        f"git clone -q --bare {quote(WORK)} {quote(ORIGIN)} "
        f"&& git -C {quote(WORK)} remote add origin {quote(ORIGIN)}"
    )
    promote("release/app", "release/home-server")

    # NixOS test VMs boot a direct toplevel. Register and activate the exact
    # legacy fixture to establish generation 1 and an exact rollback root.
    home_server.succeed(
        "nix-env --profile /nix/var/nix/profiles/system "
        "--set ${homeServerCdSystem} "
        "&& timeout --signal=KILL 180s "
        "${homeServerCdSystem}/bin/switch-to-configuration switch",
        timeout=240,
    )
    home_server.wait_for_unit("smarthome-deploy.timer")
    home_server.wait_for_unit("nixos-deploy.timer")
    baseline_generation = current_generation(SYSTEM_PROFILE)
    baseline_system = profile_path(SYSTEM_PROFILE)
    baseline_app_generation = current_generation(APP_PROFILE)
    baseline_app = profile_path(APP_PROFILE)
    baseline_health = json.loads(
        home_server.succeed("curl -fsS http://127.0.0.1:9876/healthz")
    )
    diagnostics("legacy system and app v1 seeded")
    print(f"[diag] baseline app health={baseline_health}")
    assert baseline_system == "${homeServerCdSystem}", baseline_system
    assert baseline_app == app_v1, (baseline_app, app_v1)
    assert generation_count(SYSTEM_PROFILE) == 1
    assert generation_count(APP_PROFILE) == 1
    assert baseline_health == {"ready": True, "version": "v1"}, baseline_health
    assert home_server.succeed("readlink -f /run/current-system").strip() == baseline_system

    # Both deployers must block on the same lock. Stop them before releasing
    # the holder so this probe cannot mutate either track's state.
    home_server.succeed("install -d -m 0755 /run/smarthome-deploy")
    home_server.succeed(
        "systemd-run --quiet --unit=home-server-cd-lock-holder "
        "--service-type=exec /bin/sh -c "
        + quote(
            f"exec 9>{LOCK}; ${pkgsSystem.util-linux}/bin/flock --exclusive 9; "
            "${pkgsSystem.coreutils}/bin/touch /run/home-server-cd-lock-held; "
            "exec ${pkgsSystem.coreutils}/bin/sleep infinity"
        )
    )
    home_server.wait_until_succeeds("test -f /run/home-server-cd-lock-held")
    home_server.succeed(
        "systemctl start --no-block app-deploy.service system-deploy.service"
    )
    home_server.wait_until_succeeds(
        "test \"$(systemctl show -P ActiveState app-deploy.service)\" = activating "
        "&& test \"$(systemctl show -P ActiveState system-deploy.service)\" = activating"
    )
    app_lock_state = unit_state("app-deploy.service")
    system_lock_state = unit_state("system-deploy.service")
    print(
        f"[diag] held shared lock: app={app_lock_state} system={system_lock_state}"
    )
    assert app_lock_state == "activating", app_lock_state
    assert system_lock_state == "activating", system_lock_state
    home_server.succeed(
        "systemctl stop app-deploy.service system-deploy.service "
        "&& systemctl stop home-server-cd-lock-holder.service "
        "&& rm -f /run/home-server-cd-lock-held "
        "&& systemctl reset-failed app-deploy.service system-deploy.service"
    )
    assert_no_failed("shared-lock probe reset")

    # Promote app v2 only. The app deployer must check out the release, record
    # hydration, switch the stable profile, restart/health-check the daemon,
    # and retain exactly the old and new generations.
    app_v2_revision = git_commit("app-v2", app_path=app_v2)
    promote("main", "release/app")

    # Production shape: the retired depth-1 deployer left a shallow checkout
    # in the shared source dir, cut at a main commit newer than release/app.
    # Ancestry of release/app must still be provable once main moves on.
    home_server.succeed(
        f"git -C {quote(WORK)} commit -q --allow-empty -m shallow-cut"
    )
    promote("main")
    source_dir = APP_STATE + "/source"
    home_server.succeed(
        f"rm -rf {quote(source_dir)} "
        f"&& install -d -m 0700 {quote(APP_STATE)} "
        f"&& git init -q {quote(source_dir)} "
        f"&& git -C {quote(source_dir)} remote add origin file://{ORIGIN} "
        f"&& git -C {quote(source_dir)} fetch -q --depth=1 origin "
        "+refs/heads/main:refs/remotes/origin/main "
        f"&& git -C {quote(source_dir)} reset -q --hard refs/remotes/origin/main"
    )
    assert home_server.succeed(
        f"git -C {quote(source_dir)} rev-parse --is-shallow-repository"
    ).strip() == "true"
    home_server.succeed(
        f"git -C {quote(WORK)} commit -q --allow-empty -m main-ahead"
    )
    promote("main")

    home_server.succeed("systemctl start app-deploy.service", timeout=600)
    assert home_server.succeed(
        f"git -C {quote(source_dir)} rev-parse --is-shallow-repository"
    ).strip() == "false"
    app_v2_generation = current_generation(APP_PROFILE)
    app_v2_active = profile_path(APP_PROFILE)
    app_last_success = APP_STATE + "/last-success"
    app_checkout = home_server.succeed(
        f"git -C {quote(APP_STATE + '/source')} rev-parse HEAD"
    ).strip()
    app_health = json.loads(
        home_server.succeed("curl -fsS http://127.0.0.1:9876/healthz")
    )
    diagnostics("app v2 deployed")
    print(f"[diag] app health response={app_health}")
    assert app_checkout == app_v2_revision, (app_checkout, app_v2_revision)
    assert app_v2_active == app_v2, (app_v2_active, app_v2)
    assert app_v2_generation > baseline_app_generation
    assert generation_count(APP_PROFILE) == 2
    assert marker_field(app_last_success, "rev") == app_v2_revision
    assert marker_field(app_last_success, "path") == app_v2
    assert app_health == {"ready": True, "version": "v2"}, app_health
    assert home_server.succeed("readlink -f /run/current-system").strip() == baseline_system
    assert current_generation(SYSTEM_PROFILE) == baseline_generation
    home_server.succeed(
        f"grep -F -- {quote(app_v2)} /var/lib/home-server-cd/hydrator.log"
    )

    home_server.succeed("systemctl start app-deploy.service", timeout=300)
    app_replay_generation = current_generation(APP_PROFILE)
    diagnostics("app v2 replay")
    assert app_replay_generation == app_v2_generation
    assert generation_count(APP_PROFILE) == 2
    home_server.succeed(
        f"journalctl -u app-deploy.service --no-pager | grep -F "
        f"'already deployed {app_v2_revision}'"
    )

    # A deterministically unhealthy app candidate must restore the exact v2
    # profile, poison only that revision, and leave the system track untouched.
    broken_app_revision = git_commit("app-broken", app_path=app_broken)
    promote("main", "release/app")
    home_server.fail("systemctl start app-deploy.service", timeout=600)
    recovered_app_health = json.loads(
        home_server.succeed("curl -fsS http://127.0.0.1:9876/healthz")
    )
    diagnostics("broken app rolled back")
    print(f"[diag] recovered app health={recovered_app_health}")
    assert profile_path(APP_PROFILE) == app_v2
    assert current_generation(APP_PROFILE) == app_v2_generation
    assert generation_count(APP_PROFILE) == 2
    assert marker_field(APP_STATE + "/last-failure", "rev") == broken_app_revision
    assert marker_field(APP_STATE + "/last-failure", "reason") == "candidate-health-failed"
    assert marker_field(APP_STATE + "/last-failure", "rollback") == "complete"
    assert marker_field(app_last_success, "rev") == app_v2_revision
    assert marker_field(app_last_success, "path") == app_v2
    assert recovered_app_health == {"ready": True, "version": "v2"}, recovered_app_health
    assert profile_path(SYSTEM_PROFILE) == baseline_system
    assert current_generation(SYSTEM_PROFILE) == baseline_generation
    home_server.succeed("systemctl reset-failed app-deploy.service house-automationd.service")

    home_server.fail("systemctl start app-deploy.service", timeout=300)
    diagnostics("broken app poison replay")
    assert profile_path(APP_PROFILE) == app_v2
    assert current_generation(APP_PROFILE) == app_v2_generation
    assert generation_count(APP_PROFILE) == 2
    home_server.succeed(
        "journalctl -u app-deploy.service --no-pager "
        "| grep -F 'candidate is poisoned after deterministic unhealthy activation'"
    )
    home_server.succeed("systemctl reset-failed app-deploy.service")

    # The first standalone system candidate performs a real switch but fails
    # strict candidate health. Recovery must select the exact legacy generation
    # and accept its old timer names; the bad revision is then poisoned.
    bad_system_revision = git_commit("system-bad", system_state="bad")
    promote("main", "release/home-server")
    pre_bad_app_path = profile_path(APP_PROFILE)
    pre_bad_app_generation = current_generation(APP_PROFILE)
    system_deploy_executable = service_executable("system-deploy.service")
    print(f"[diag] strict candidate health program={system_deploy_executable}")
    home_server.succeed(
        f"grep -F -- '--unit app-deploy.timer' {quote(system_deploy_executable)} "
        f"&& grep -F -- '--unit system-deploy.timer' {quote(system_deploy_executable)}"
    )
    home_server.fail("systemctl start system-deploy.service", timeout=600)
    diagnostics("bad system candidate rolled back")
    assert marker_field(SYSTEM_STATE + "/last-failure", "rev") == bad_system_revision
    assert marker_field(SYSTEM_STATE + "/last-failure", "path") == "${homeServerCdBadSystem}"
    assert marker_field(SYSTEM_STATE + "/last-failure", "reason") == "candidate-health-failed"
    assert marker_field(SYSTEM_STATE + "/last-failure", "rollback") == "complete"
    assert profile_path(SYSTEM_PROFILE) == baseline_system
    assert current_generation(SYSTEM_PROFILE) == baseline_generation
    assert generation_count(SYSTEM_PROFILE) == 1
    assert home_server.succeed("readlink -f /run/current-system").strip() == baseline_system
    assert unit_state("smarthome-deploy.timer") == "active"
    assert unit_state("nixos-deploy.timer") == "active"
    assert profile_path(APP_PROFILE) == pre_bad_app_path
    assert current_generation(APP_PROFILE) == pre_bad_app_generation
    home_server.succeed("grep -F bad /run/home-server-cd-activation")
    home_server.succeed(
        "grep -F -- '${homeServerCdBadSystem}' /var/lib/home-server-cd/hydrator.log"
    )
    home_server.succeed("systemctl reset-failed system-deploy.service")

    home_server.fail("systemctl start system-deploy.service", timeout=300)
    diagnostics("bad system poison replay")
    assert profile_path(SYSTEM_PROFILE) == baseline_system
    assert current_generation(SYSTEM_PROFILE) == baseline_generation
    assert generation_count(SYSTEM_PROFILE) == 1
    home_server.succeed(
        "journalctl -u system-deploy.service --no-pager "
        "| grep -F 'candidate is poisoned after deterministic unhealthy activation'"
    )
    home_server.succeed("systemctl reset-failed system-deploy.service")

    # Promote the healthy standalone system. It must survive service exit with
    # its activation and agenix mounts visible, run the required units/new
    # timers, retain two system generations, and not touch the app profile.
    v2_system_revision = git_commit("system-v2", system_state="v2")
    promote("main", "release/home-server")
    home_server.succeed("systemctl start system-deploy.service", timeout=600)
    v2_system_generation = current_generation(SYSTEM_PROFILE)
    v2_system = profile_path(SYSTEM_PROFILE)
    system_last_success = SYSTEM_STATE + "/last-success"
    system_checkout = home_server.succeed(
        f"git -C {quote(SYSTEM_STATE + '/source')} rev-parse HEAD"
    ).strip()
    secret_digest_after = home_server.succeed(
        "sha256sum /run/agenix/home-server-cd-secret | awk '{print $1}'"
    ).strip()
    diagnostics("healthy system v2 deployed")
    assert system_checkout == v2_system_revision, (system_checkout, v2_system_revision)
    assert v2_system == "${homeServerCdV2System}", (v2_system, "${homeServerCdV2System}")
    assert home_server.succeed("readlink -f /run/current-system").strip() == v2_system
    assert v2_system_generation > baseline_generation
    assert generation_count(SYSTEM_PROFILE) == 2
    assert marker_field(system_last_success, "rev") == v2_system_revision
    assert marker_field(system_last_success, "path") == v2_system
    assert home_server.succeed("cat /etc/home-server-cd/system-state").strip() == "v2"
    assert unit_state("system-deploy.service") == "inactive"
    assert secret_digest_after == secret_digest
    home_server.succeed("grep -F v2 /run/home-server-cd-activation")
    for unit in [
        "sshd.service",
        "tailscaled.service",
        "mosquitto.service",
        "house-automationd.service",
        "app-deploy.timer",
        "system-deploy.timer",
    ]:
        state = unit_state(unit)
        print(f"[diag] required unit {unit}={state}")
        assert state == "active", (unit, state)
    assert profile_path(APP_PROFILE) == pre_bad_app_path
    assert current_generation(APP_PROFILE) == pre_bad_app_generation
    assert marker_field(app_last_success, "rev") == app_v2_revision
    home_server.succeed(
        f"grep -F -- {quote(v2_system)} /var/lib/home-server-cd/hydrator.log"
    )

    home_server.succeed("systemctl start system-deploy.service", timeout=300)
    system_replay_generation = current_generation(SYSTEM_PROFILE)
    diagnostics("system v2 replay")
    assert system_replay_generation == v2_system_generation
    assert generation_count(SYSTEM_PROFILE) == 2
    home_server.succeed(
        f"journalctl -u system-deploy.service --no-pager | grep -F "
        f"'already deployed {v2_system_revision}'"
    )

    # The state/source roots are intentionally separate even though both
    # deployers consume the same origin and serialize on the same runtime lock.
    app_source = APP_STATE + "/source"
    system_source = SYSTEM_STATE + "/source"
    app_remote = home_server.succeed(
        f"git -C {quote(app_source)} remote get-url origin"
    ).strip()
    system_remote = home_server.succeed(
        f"git -C {quote(system_source)} remote get-url origin"
    ).strip()
    print(
        f"[diag] sources app={app_source}@{broken_app_revision} "
        f"system={system_source}@{system_checkout} remotes={app_remote},{system_remote}"
    )
    assert app_source != system_source
    assert APP_STATE != SYSTEM_STATE
    assert app_remote == "file://" + ORIGIN, app_remote
    assert system_remote == "file://" + ORIGIN, system_remote
    assert home_server.succeed(f"git -C {quote(app_source)} rev-parse HEAD").strip() == broken_app_revision
    assert system_checkout == v2_system_revision

    # Assert the no-build boundary on the actual scripts installed in the VM.
    # These are supplemental to the behavioral proof: every candidate closure
    # above was already in the guest store and no builder is configured.
    for unit in ["app-deploy.service", "system-deploy.service"]:
        executable = service_executable(unit)
        print(f"[diag] {unit} executable={executable}")
        home_server.succeed(
            f"grep -F -- '--option max-jobs 0' {quote(executable)} "
            f"&& grep -F -- '--option fallback false' {quote(executable)} "
            f"&& grep -F -- '--option builders \"\"' {quote(executable)}"
        )

    # Perform a real operator rollback. The deployment guard must preserve the
    # selected old generation rather than recreating or clobbering v2.
    home_server.succeed("nixos-rebuild switch --rollback --fast", timeout=600)
    rolled_generation = current_generation(SYSTEM_PROFILE)
    rolled_system = profile_path(SYSTEM_PROFILE)
    diagnostics("manual rollback to legacy")
    assert rolled_generation == baseline_generation, (
        rolled_generation,
        baseline_generation,
    )
    assert rolled_system == baseline_system, (rolled_system, baseline_system)
    assert home_server.succeed("readlink -f /run/current-system").strip() == baseline_system
    assert home_server.succeed("cat /etc/home-server-cd/system-state").strip() == "legacy"
    assert generation_count(SYSTEM_PROFILE) == 2

    home_server.fail("systemctl start system-deploy.service", timeout=300)
    diagnostics("manual rollback guard")
    assert profile_path(SYSTEM_PROFILE) == baseline_system
    assert current_generation(SYSTEM_PROFILE) == baseline_generation
    assert generation_count(SYSTEM_PROFILE) == 2
    assert marker_field(system_last_success, "rev") == v2_system_revision
    home_server.succeed(
        "journalctl -u system-deploy.service --no-pager "
        "| grep -F 'rollback in effect; refusing to clobber'"
    )
    home_server.succeed("systemctl reset-failed system-deploy.service")

    assert_no_failed("final state after expected failure resets")
  '';
}
