# lighting-port: the unit's runtime contract, against a stand-in checkout.
#
# The sandbox has no network, so the origin is a local bare repository and the
# checkout is a stand-in: a lighting-scripts/ with a package-lock.json whose
# only dependency is a local link (so `npm ci` runs offline), and a
# scripts/dev.mjs that records what the unit handed it instead of talking to
# Home Assistant.
#
# What is pinned, and why each matters:
#   - no failure leaves the unit `failed` or auto-restarting on a non-zero
#     status, because switch-to-configuration counts exactly those two as a
#     failed deploy and the deployer rolls back. Covered: an unreachable
#     origin, an interrupted clone, a failing `npm ci`, an unforeseen setup
#     failure (an unreadable package-lock.json), a crashing watcher, a
#     watcher that ignores SIGTERM at stop, and a stop that lands between
#     the watcher's start and the script's stop handling;
#   - a stop, or a restart, is prompt in every phase (a backoff, a stalled
#     clone), and a clone from an origin that stalls gives up and is retried;
#     a checkout moved back during a clone is never cloned into;
#   - repeated setup failures back off, so a dead origin is not hammered,
#     including a step that fails after the install; so does a watcher that
#     exits again right after each start (the port refusing its rooms,
#     catalog or token); that count starts over once the watcher has run a
#     while, while it still runs, so a power cut keeps no old count;
#   - a refusal (env file or LIVE_ROOMS missing, token unreadable, catalog
#     missing or unreadable, node_modules not writable by the service) stops
#     the unit cleanly with status 78 and runs nothing; .runtime exists,
#     writable by the port, from the first refusal on, so the operator can
#     drop the catalog in;
#   - the watcher gets the agreed command line and environment;
#   - with the port's real watcher (fixtures/lighting-port-dev.mjs), a stop
#     reaches the host once, and the host finishes its own shutdown; so does
#     a host whose watcher dies alone, before the unit backs off;
#   - starting over from a fresh clone as the docs say carries the catalog
#     and the journal into it, still the service's;
#   - the checkout follows its branch (lighting-port-follow): a pushed
#     commit arrives, a tracked local edit and a local branch are discarded,
#     and .runtime (catalog, journal), node_modules and untracked files
#     stay. The unit is restarted when the update changes what the watcher
#     does not watch (lighting-scripts outside src/), or package-lock.json
#     differs from what is installed; not for src/ or anything outside
#     lighting-scripts, never while an install runs, and once per
#     package-lock.json. A run cut off before its restart restarts on the
#     next run; a checkout that keeps failing restarts nothing until it gets
#     through. Git's upkeep after a fetch runs to its end instead of being
#     killed with the run. Nothing before the clone, an unreachable origin
#     or a stop in the middle of a fetch fails it;
#   - `npm ci` reruns only when package-lock.json changes, and never runs
#     lifecycle scripts;
#   - the operator, as a member of the group, writes the env file and the
#     catalog without sudo; git trusts the checkout only as lighting-port,
#     which can write its .git/config.
#
#   nix build --no-link -L .#checks.x86_64-linux.lighting-port
{
  pkgsSystem,
  agenix,
  # The module under test; only ever overridden to run this test against
  # another revision of it.
  module ? ../modules/lighting-port.nix,
}:

let
  branch = "feature/typescript-lighting-scripts";
  origin = "/var/lib/lighting-port-origin.git";
  src = "/var/lib/lighting-port/src";
  scripts = "${src}/lighting-scripts";

  testAgenix = pkgsSystem.runCommand "lighting-port-test-agenix"
    {
      nativeBuildInputs = [
        pkgsSystem.age
        pkgsSystem.openssh
      ];
    }
    ''
      mkdir -p "$out"
      ssh-keygen -q -t ed25519 -N "" -C "lighting-port test identity" \
        -f "$out/id_ed25519"
      recipient="$(cat "$out/id_ed25519.pub")"
      printf '%s\n' 'lighting-port-test-token' \
        | age -r "$recipient" -o "$out/lighting-port-ha-token.age"
    '';

  # Records the command line, environment and identity it ran with, then stays
  # up like the real watcher. `.runtime/crash` reading `yes` makes it exit 3,
  # standing in for a host that crashes; `.runtime/stubborn` reading `yes`
  # makes it ignore SIGTERM, standing in for a host whose shutdown hangs on an
  # unreachable Home Assistant.
  standInWatcher = pkgsSystem.writeText "dev.mjs" ''
    import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const flag = name => {
      try { return readFileSync('.runtime/' + name, 'utf8').trim() === 'yes'; } catch { return false; }
    };
    const crashing = () => flag('crash');
    if (crashing()) process.exit(3);
    if (flag('stubborn')) process.on('SIGTERM', () => {});
    const scratch = mkdtempSync(join(tmpdir(), 'stand-in-'));
    writeFileSync('.runtime/record.json', JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      uid: process.getuid(),
      node: process.version,
      haUrl: process.env.HA_URL,
      haTokenFile: process.env.HA_TOKEN_FILE,
      token: readFileSync(process.env.HA_TOKEN_FILE, 'utf8').trim(),
      scratch,
    }));
    setInterval(() => { if (crashing()) process.exit(3); }, 200);
  '';

  # The port's own dev watcher, copied verbatim from
  # feature/typescript-lighting-scripts (lighting-scripts/scripts/dev.mjs at
  # b0ff823). It forwards its SIGTERM to the host it runs, so it decides how
  # often the host is signalled at a stop.
  realWatcher = "${./fixtures/lighting-port-dev.mjs}";
  # The compiler the real watcher runs before each start: every build passes.
  standInCompiler = pkgsSystem.writeText "tsc" "process.exit(0);\n";
  # The host the real watcher starts. Like the port's src/main.ts it handles
  # SIGTERM once (process.once), and its shutdown takes a while; a clean one
  # leaves `.runtime/clean` and gives its journal lock back.
  standInHost = pkgsSystem.writeText "main.ts" ''
    import { unlinkSync, writeFileSync } from 'node:fs';
    const lock = '.runtime/journal.json.lock';
    writeFileSync(lock, String(process.pid) + '\n');
    writeFileSync('.runtime/host-started', String(process.pid) + '\n');
    const stop = () => setTimeout(() => {
      writeFileSync('.runtime/clean', 'clean\n');
      unlinkSync(lock);
      process.exit(0);
    }, 1000);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    setInterval(() => {}, 1 << 30);
  '';

  # An HTTPS origin that completes the TLS handshake and then never answers,
  # as a connection that stalls mid-clone does.
  stallingOriginCert = pkgsSystem.runCommand "lighting-port-stalling-origin-cert"
    { nativeBuildInputs = [ pkgsSystem.openssl ]; }
    ''
      mkdir -p "$out"
      openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=127.0.0.1 \
        -keyout "$out/key.pem" -out "$out/cert.pem" 2>/dev/null
    '';
  stallingOrigin = pkgsSystem.writeScript "stalling-origin" ''
    #!${pkgsSystem.python3}/bin/python3
    import socket, ssl
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain("${stallingOriginCert}/cert.pem", "${stallingOriginCert}/key.pem")
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 8443))
    server.listen(16)
    held = []
    while True:
        connection, _ = server.accept()
        try:
            held.append(context.wrap_socket(connection, server_side=True))
        except (ssl.SSLError, OSError):
            connection.close()
  '';

  # An upload-pack that waits 20 s first: a clone that is slow, then completes.
  slowUploadPack = pkgsSystem.writeShellScript "slow-upload-pack" ''
    ${pkgsSystem.coreutils}/bin/sleep 20
    shift
    exec ${pkgsSystem.git}/bin/git-upload-pack "$@"
  '';

  standInCheckout = pkgsSystem.runCommand "lighting-port-stand-in-checkout" { } ''
    mkdir -p "$out/lighting-scripts/scripts" "$out/lighting-scripts/stand-in-dep"
    cp ${standInWatcher} "$out/lighting-scripts/scripts/dev.mjs"
    printf '%s\n' 'node_modules/' '.runtime/' > "$out/lighting-scripts/.gitignore"
    cat > "$out/lighting-scripts/stand-in-dep/package.json" <<'JSON'
    {"name": "stand-in-dep", "version": "0.0.0"}
    JSON
    cat > "$out/lighting-scripts/package.json" <<'JSON'
    {"name": "stand-in", "version": "0.0.0", "private": true,
     "scripts": {"postinstall": "node -e \"require('fs').writeFileSync('lifecycle-script-ran', 'ran')\""},
     "dependencies": {"stand-in-dep": "file:./stand-in-dep"}}
    JSON
    cat > "$out/lighting-scripts/package-lock.json" <<'JSON'
    {
      "name": "stand-in",
      "version": "0.0.0",
      "lockfileVersion": 3,
      "requires": true,
      "packages": {
        "": {"name": "stand-in", "version": "0.0.0",
             "dependencies": {"stand-in-dep": "file:./stand-in-dep"}},
        "node_modules/stand-in-dep": {"resolved": "stand-in-dep", "link": true},
        "stand-in-dep": {"version": "0.0.0"}
      }
    }
    JSON
  '';
in
pkgsSystem.testers.runNixOSTest {
  name = "lighting-port";
  skipTypeCheck = true;

  nodes.machine =
    { config, lib, ... }:
    {
      imports = [
        agenix.nixosModules.default
        module
      ];

      users.users.jonathan.isNormalUser = true;

      services.lighting-port = {
        enable = true;
        repository = "file://${origin}";
        haTokenFile = config.age.secrets.lighting-port-ha-token.path;
        operators = [ "jonathan" ];
      };

      age.identityPaths = [ "${testAgenix}/id_ed25519" ];
      age.secrets.lighting-port-ha-token = {
        file = "${testAgenix}/lighting-port-ha-token.age";
        owner = "lighting-port";
        group = "lighting-port";
        mode = "0400";
      };

      system.extraDependencies = [
        standInCheckout
        realWatcher
        standInCompiler
        standInHost
        stallingOrigin
        slowUploadPack
      ];
    };

  testScript = ''
    import json
    import shlex
    import time

    def show(prop):
        return machine.succeed(f"systemctl show lighting-port.service -P {prop}").strip()

    def as_operator(command):
        return machine.succeed(f"runuser -u jonathan -- sh -c {shlex.quote(command)}")

    def never_counted_as_failed():
        # switch-to-configuration fails a deploy on `failed`, and on
        # auto-restart with a non-zero main status. Neither may ever show.
        state, sub, status = show("ActiveState"), show("SubState"), show("ExecMainStatus")
        assert state != "failed", (state, sub, status)
        assert not (sub == "auto-restart" and status != "0"), (state, sub, status)

    def refused(reason):
        machine.wait_until_succeeds(
            "journalctl -u lighting-port.service -o cat --no-pager | "
            f"grep -F {shlex.quote('lighting-port: refusing to start: ' + reason)}",
            timeout=120,
        )
        machine.wait_until_succeeds(
            "test \"$(systemctl show lighting-port.service -P ActiveState)\" = inactive",
            timeout=60,
        )
        assert show("Result") == "success", show("Result")
        assert show("ExecMainStatus") == "78", show("ExecMainStatus")

    def restart():
        machine.succeed("systemctl restart lighting-port.service")

    def as_service(command):
        return machine.succeed(f"runuser -u lighting-port -- sh -c {shlex.quote(command)}")

    def logged(text, timeout=120):
        machine.wait_until_succeeds(
            "journalctl -u lighting-port.service -o cat --no-pager | "
            f"grep -F {shlex.quote(text)}",
            timeout=timeout,
        )

    def stays_uncounted(seconds):
        for _ in range(seconds):
            never_counted_as_failed()
            machine.sleep(1)

    def running():
        machine.wait_until_succeeds(
            "test \"$(systemctl show lighting-port.service -P SubState)\" = running", timeout=60
        )

    # SubState=running holds from the moment the script starts, setup
    # included; the stand-in writing its record is what shows the watcher,
    # and so the whole of setup, has run.
    def restart_watcher():
        machine.succeed(": > ${scripts}/.runtime/record.json")
        restart()
        machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=90)

    # A stop that systemd had to time out leaves the unit failed; one that
    # waits on a step of the script is slow. Neither may happen.
    def stops_promptly(within=10):
        started = time.monotonic()
        machine.succeed("systemctl stop lighting-port.service", timeout=60)
        took = time.monotonic() - started
        assert show("Result") == "success", show("Result")
        assert show("ActiveState") == "inactive", show("ActiveState")
        assert took < within, f"the stop took {took:.1f}s"

    def journal_since(marker):
        return f"journalctl -u lighting-port.service -o cat --no-pager --since @{marker}"

    # journald reads a unit's output asynchronously: a read that is not
    # retried syncs the journal first, so what was written is in it.
    def installs():
        return int(machine.succeed(
            "journalctl --sync && journalctl -u lighting-port.service -o cat --no-pager | "
            "grep -cF 'lighting-port: running npm ci' || true"
        ).strip())

    def follow_show(prop):
        return machine.succeed(f"systemctl show lighting-port-follow.service -P {prop}").strip()

    # One run of the follower, started by hand: its timer is stopped below, so
    # a run never lands in the middle of a step. A oneshot, so the start
    # returns once the run and its restart decision are over.
    def follow():
        machine.succeed("systemctl start lighting-port-follow.service", timeout=240)
        # The start returns once the run is over; anything the run left
        # behind is stopped after that.
        machine.wait_until_succeeds(
            "systemctl show lighting-port-follow.service -P ActiveState | grep -vx deactivating",
            timeout=120,
        )
        assert follow_show("Result") == "success", follow_show("Result")
        assert follow_show("ActiveState") == "inactive", follow_show("ActiveState")

    def follow_logged(text):
        machine.succeed(
            "journalctl --sync && journalctl -u lighting-port-follow.service -o cat --no-pager | "
            f"grep -F {shlex.quote(text)}"
        )

    def stop_follow_timer():
        machine.succeed("systemctl is-active lighting-port-follow.timer")
        machine.succeed("systemctl stop lighting-port-follow.timer")

    machine.wait_for_unit("multi-user.target")
    # The follower runs from its timer, which runs from boot.
    stop_follow_timer()
    # Before the first clone there is nothing to follow, and that is no
    # failure.
    follow()
    follow_logged("lighting-port-follow: no checkout at ${src} yet")
    machine.succeed("test \"$(stat -c '%U:%G %a' /var/lib/lighting-port)\" = 'lighting-port:lighting-port 2770'")
    machine.succeed("test \"$(stat -c '%U:%G %a' /run/agenix/lighting-port-ha-token)\" = 'lighting-port:lighting-port 400'")

    # The origin does not exist yet: the clone fails and is retried, waiting
    # longer each time, and the unit stays out of the states a switch would
    # count against a deploy.
    logged("lighting-port: clone failed; retrying in 10s (setup failure 1 in a row)")
    logged("lighting-port: clone failed; retrying in 20s (setup failure 2 in a row)", timeout=90)
    stays_uncounted(3)
    machine.succeed("test ! -e ${src}")
    # A stop in the middle of a backoff does not wait it out.
    stops_promptly()

    # A clone cut short is moved aside, never deleted and never mistaken for
    # a checkout.
    as_service("mkdir /var/lib/lighting-port/.src.partial && touch /var/lib/lighting-port/.src.partial/junk")
    restart()
    logged("lighting-port: moved an interrupted clone aside to /var/lib/lighting-port/.src.partial.")
    logged("lighting-port: clone failed; retrying in 40s (setup failure 3 in a row)")
    machine.succeed("ls /var/lib/lighting-port/.src.partial.*/junk")
    never_counted_as_failed()

    machine.succeed(
        "cp -r ${standInCheckout} /tmp/work && chmod -R u+w /tmp/work && "
        "git -C /tmp/work init -q -b ${branch} && "
        "git -C /tmp/work -c user.name=t -c user.email=t@example.invalid add -A && "
        "git -C /tmp/work -c user.name=t -c user.email=t@example.invalid commit -q -m stand-in && "
        "git clone -q --bare /tmp/work ${origin} && "
        "chown -R lighting-port:lighting-port ${origin}"
    )
    # The unit is in its 40 s backoff: a restart (a deploy that changes the
    # unit) does not wait it out, and the run it stops ends clean.
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    started = time.monotonic()
    restart()
    took = time.monotonic() - started
    assert took < 10, f"the restart took {took:.1f}s"
    machine.fail(journal_since(marker) + " | grep -F 'lighting-port.service: Failed with result'")

    # Cloned, dependencies installed, then refused: there is no env file, so
    # nothing may run. A setup that got through resets the backoff.
    refused("/var/lib/lighting-port/env does not exist")
    machine.succeed("test -d ${src}/.git")
    machine.succeed("test \"$(cat /var/lib/lighting-port/.setup-failures)\" = 0")
    machine.succeed("test -L ${scripts}/node_modules/stand-in-dep")
    # npm ci runs no lifecycle scripts: the token is readable and the network
    # open in this unit.
    machine.succeed("test ! -e ${scripts}/lifecycle-script-ran")
    machine.succeed(
        "test \"$(cat ${scripts}/node_modules/.lighting-port-lock.sha256)\" = "
        "\"$(sha256sum ${scripts}/package-lock.json | cut -d' ' -f1)\""
    )
    machine.succeed("test ! -e ${scripts}/.runtime/record.json")
    # The first start's refusal already left .runtime, made by the unit, so
    # the operator can drop the catalog in (the docs' "First start" puts the
    # catalog before the env file), and the port can write its journal there
    # whatever the operator's umask.
    machine.succeed(
        "test \"$(stat -c '%U:%G %a' ${scripts}/.runtime)\" = 'lighting-port:lighting-port 2770'"
    )

    # The operator writes the env file without sudo, but forgets LIVE_ROOMS.
    as_operator("printf 'UNRELATED=1\\n' > /var/lib/lighting-port/env")
    restart()
    refused("LIVE_ROOMS is not set in /var/lib/lighting-port/env")

    as_operator("printf 'LIVE_ROOMS=bedroom\\n' > /var/lib/lighting-port/env")
    restart()
    refused("${scripts}/.runtime/catalog.json does not exist")

    # The unit made .runtime itself, so the port can write its journal there
    # whatever the operator's umask; the operator drops the catalog in. One
    # the service cannot read (copied in with mode 600) is the operator's to
    # fix, and says so, instead of a port that fails to read it on every
    # start.
    as_operator("umask 077; printf '{}\\n' > ${scripts}/.runtime/catalog.json")
    restart()
    refused("${scripts}/.runtime/catalog.json is not readable by lighting-port")
    as_operator(
        "chgrp lighting-port ${scripts}/.runtime/catalog.json && "
        "chmod g+r ${scripts}/.runtime/catalog.json"
    )

    machine.succeed("chmod 000 /run/agenix/lighting-port-ha-token")
    restart()
    refused("HA token file /run/agenix/lighting-port-ha-token is missing, unreadable or empty")
    machine.succeed("chmod 400 /run/agenix/lighting-port-ha-token")

    restart()
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=60)
    record = json.loads(machine.succeed("cat ${scripts}/.runtime/record.json"))
    uid = machine.succeed("id -u lighting-port").strip()
    assert record["argv"] == [
        "--live", "--config", ".runtime/catalog.json", "--live-rooms", "bedroom",
    ], record
    assert record["cwd"] == "${scripts}", record
    assert str(record["uid"]) == uid, record
    assert record["haUrl"] == "http://127.0.0.1:8123", record
    assert record["haTokenFile"] == "/run/agenix/lighting-port-ha-token", record
    assert record["token"] == "lighting-port-test-token", record
    major, minor = (int(part) for part in record["node"].lstrip("v").split(".")[:2])
    assert (major, minor) >= (22, 18), record
    assert show("ActiveState") == "active", show("ActiveState")

    # An empty LIVE_ROOMS is the port's own "no rooms", not a missing value.
    as_operator("printf 'LIVE_ROOMS=\\n' > /var/lib/lighting-port/env")
    machine.succeed("cp ${scripts}/.runtime/record.json /tmp/record-before")
    restart()
    machine.wait_until_succeeds(
        "! cmp -s /tmp/record-before ${scripts}/.runtime/record.json", timeout=60
    )
    record = json.loads(machine.succeed("cat ${scripts}/.runtime/record.json"))
    assert record["argv"][-2:] == ["--live-rooms", ""], record
    as_operator("printf 'LIVE_ROOMS=bedroom\\n' > /var/lib/lighting-port/env")

    # A crashing watcher is restarted, and its status never reaches systemd.
    # One that exits again right after each start (the port refusing an
    # unknown room, a catalog or a revoked token, which the unit cannot tell
    # from a crash) backs off like a failing setup, instead of restarting,
    # and recompiling, every 10 s for good.
    restarts = int(show("NRestarts"))
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    as_operator("printf 'yes\\n' > ${scripts}/.runtime/crash")
    logged("lighting-port: watcher exited with status 3 after ")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F '; retrying in 10s (watcher exit 1 in a row)'",
        timeout=60,
    )
    machine.wait_until_succeeds(
        f"test \"$(systemctl show lighting-port.service -P NRestarts)\" -gt {restarts}",
        timeout=60,
    )
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F '; retrying in 20s (watcher exit 2 in a row)'",
        timeout=60,
    )
    for _ in range(10):
        never_counted_as_failed()
        machine.sleep(1)
    machine.succeed(": > ${scripts}/.runtime/record.json")
    as_operator("printf 'no\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=90)

    # A watcher whose shutdown hangs (Home Assistant unreachable) is killed
    # by the unit before systemd's stop timeout, and the stop stays clean: a
    # timed-out stop would leave the unit failed.
    as_operator("printf 'yes\\n' > ${scripts}/.runtime/stubborn")
    restart_watcher()
    machine.succeed("systemctl stop lighting-port.service", timeout=60)
    logged("lighting-port: watcher still running 15s after stop; killing it")
    assert show("ActiveState") == "inactive", show("ActiveState")
    assert show("Result") == "success", show("Result")

    # So is a stop that lands after the watcher started but before the
    # script handles a stop by waiting on it. That window is a few shell
    # statements wide; a copy of the unit's script with a pause right after
    # the start widens it, so the stop lands in it.
    exec_start = machine.succeed(
        "systemctl cat lighting-port.service | sed -n 's/^ExecStart=//p'"
    ).strip()
    machine.succeed(
        "mkdir -p /var/lib/lighting-port-widened && "
        f"sed '/^watcher=/a sleep 10 & wait $!' {exec_start} > /var/lib/lighting-port-widened/run && "
        "chmod 555 /var/lib/lighting-port-widened/run && "
        "test \"$(grep -c '^watcher=' /var/lib/lighting-port-widened/run)\" = 1 && "
        "grep -A1 '^watcher=' /var/lib/lighting-port-widened/run | grep -qx 'sleep 10 & wait \\$!'"
    )
    machine.succeed(
        "mkdir -p /run/systemd/system/lighting-port.service.d && "
        "printf '[Service]\\nExecStart=\\nExecStart=/var/lib/lighting-port-widened/run\\n' "
        "> /run/systemd/system/lighting-port.service.d/widened.conf && "
        "systemctl daemon-reload"
    )
    restart_watcher()
    stops_promptly()
    machine.succeed(
        ": > /run/systemd/system/lighting-port.service.d/widened.conf && systemctl daemon-reload"
    )
    as_operator("printf 'no\\n' > ${scripts}/.runtime/stubborn")
    restart_watcher()

    # The count of watcher exits starts over once the port has run a while
    # (5 min; 5 s in a copy of the script), at its next exit or stop: a port
    # that crashes once a day comes back after 10 s, not after the minutes a
    # past crash loop worked up to.
    machine.succeed(
        f"sed 's/^stable_seconds=.*/stable_seconds=5/' {exec_start} > /var/lib/lighting-port-widened/settles && "
        "chmod 555 /var/lib/lighting-port-widened/settles && "
        "grep -qx 'stable_seconds=5' /var/lib/lighting-port-widened/settles && "
        "printf '[Service]\\nExecStart=\\nExecStart=/var/lib/lighting-port-widened/settles\\n' "
        "> /run/systemd/system/lighting-port.service.d/widened.conf && "
        "systemctl daemon-reload"
    )
    as_service("printf '4\\n' > /var/lib/lighting-port/.watcher-exits")
    restart_watcher()
    machine.sleep(6)
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    as_operator("printf 'yes\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F '; retrying in 10s (watcher exit 1 in a row)'",
        timeout=60,
    )
    machine.succeed(": > ${scripts}/.runtime/record.json")
    as_operator("printf 'no\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=90)
    machine.sleep(6)
    stops_promptly()
    machine.succeed("test \"$(cat /var/lib/lighting-port/.watcher-exits)\" = 0")

    # It starts over while the port runs, not only at an exit or a stop the
    # unit sees: after a power cut that ends a long run, the next crash backs
    # off from 1, not from the old count. The reboot also drops the copy of
    # the script, which lives in /run.
    as_service("printf '4\\n' > /var/lib/lighting-port/.watcher-exits")
    restart_watcher()
    machine.sleep(6)
    machine.succeed(": > ${scripts}/.runtime/record.json && sync")
    machine.crash()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    stop_follow_timer()
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=90)
    machine.fail("test -e /run/systemd/system/lighting-port.service.d/widened.conf")
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    as_operator("printf 'yes\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F '; retrying in '",
        timeout=60,
    )
    machine.succeed(journal_since(marker) + " | grep -F '; retrying in 10s (watcher exit 1 in a row)'")
    machine.succeed(": > ${scripts}/.runtime/record.json")
    as_operator("printf 'no\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=90)

    # The checkout follows its branch on origin, and is forced to it. This
    # inverts what was pinned here before (an existing checkout was never
    # pulled or reset): the server's checkout is no longer edited in place.
    # Git trusts the checkout only as lighting-port: anyone who can write
    # .git/config could otherwise run commands as whoever runs git there.
    machine.fail("git config --system --get-all safe.directory")

    def push(change, message):
        machine.succeed(
            f"cd /tmp/work && {change} && "
            "git -c user.name=t -c user.email=t@example.invalid add -A && "
            f"git -c user.name=t -c user.email=t@example.invalid commit -q -m {shlex.quote(message)} && "
            # The origin belongs to lighting-port, and git will not push into
            # a repository another user owns, so root takes it back for the
            # push.
            "chown -R root:root ${origin} && "
            "git push -q ${origin} ${branch} && "
            "chown -R lighting-port:lighting-port ${origin}"
        )
        return machine.succeed("git -C /tmp/work rev-parse HEAD").strip()

    def head():
        return as_service("git -C ${src} rev-parse HEAD").strip()

    def lock_installed():
        machine.wait_until_succeeds(
            "test \"$(cat ${scripts}/node_modules/.lighting-port-lock.sha256)\" = "
            "\"$(sha256sum ${scripts}/package-lock.json | cut -d' ' -f1)\"",
            timeout=120,
        )

    # One follower run, and whether it restarted the unit. The root part
    # logs its restart before it asks for it, within the run, so that run's
    # journal says whether it did, however slow the stop. The stand-in
    # watcher writes its record once, at its start: one that fills again
    # shows the restart happened.
    def follow_restarted():
        started = show("ExecMainStartTimestampMonotonic")
        machine.succeed(
            "cp ${scripts}/.runtime/record.json /tmp/record.kept && "
            ": > ${scripts}/.runtime/record.json"
        )
        follow()
        run = machine.succeed(
            "journalctl --sync && "
            f"journalctl _SYSTEMD_INVOCATION_ID={follow_show('InvocationID')} -o cat --no-pager"
        )
        asked = "lighting-port-follow: restarting lighting-port.service for the update" in run
        if asked:
            machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=90)
            assert show("ExecMainStartTimestampMonotonic") != started
        else:
            assert show("ExecMainStartTimestampMonotonic") == started
            machine.succeed("cat /tmp/record.kept > ${scripts}/.runtime/record.json")
        return asked, run

    def follow_restarts(restarted):
        asked, run = follow_restarted()
        assert asked == restarted, run

    # A pushed commit arrives. It changes nothing the watcher does not watch
    # (a file outside lighting-scripts, a file under src/), so the unit is
    # not restarted. Ignored and untracked files stay.
    as_service("printf 'kept\\n' > ${scripts}/.runtime/journal.json")
    as_service("printf 'untracked\\n' > ${scripts}/untracked.note")
    before = installs()
    target = push(
        "printf 'upstream\\n' > upstream && mkdir -p lighting-scripts/src && "
        "printf 'export {};\\n' > lighting-scripts/src/port.ts",
        "upstream",
    )
    follow_restarts(False)
    assert head() == target
    machine.succeed("grep -Fx upstream ${src}/upstream")
    machine.succeed("grep -Fx kept ${scripts}/.runtime/journal.json")
    machine.succeed("test -s ${scripts}/.runtime/catalog.json")
    machine.succeed("test -L ${scripts}/node_modules/stand-in-dep")
    machine.succeed("grep -Fx untracked ${scripts}/untracked.note")
    follow_logged("lighting-port-follow: updating ${src} to " + target)
    assert installs() == before, "npm ci ran again with an unchanged package-lock.json"

    # A tracked local edit is discarded, and logged with its path, even with
    # nothing new on origin. Under src/, it needs no restart.
    as_service("printf 'local edit\\n' >> ${scripts}/src/port.ts")
    follow_restarts(False)
    machine.succeed("test \"$(cat ${scripts}/src/port.ts)\" = 'export {};'")
    follow_logged("lighting-port-follow: discarding local edits to: lighting-scripts/src/port.ts")
    assert head() == target

    # So is a local branch with a commit of its own: the checkout goes back
    # to the followed branch, at origin.
    as_service(
        "cd ${src} && git checkout -q -b elsewhere && "
        "printf 'local commit\\n' >> lighting-scripts/src/port.ts && "
        "git -c user.name=t -c user.email=t@example.invalid commit -q -am local"
    )
    follow_restarts(False)
    assert head() == target
    assert as_service("git -C ${src} symbolic-ref --short HEAD").strip() == "${branch}"

    # A change outside src/, which the watcher does not watch, restarts the
    # unit; with package-lock.json unchanged, npm ci does not rerun.
    before = installs()
    target = push("printf 'export {};\\n' > lighting-scripts/scripts/helper.mjs", "helper")
    follow_restarts(True)
    assert head() == target
    follow_logged("lighting-port-follow: the update changes lighting-scripts outside src/")
    follow_logged("lighting-port-follow: restarting lighting-port.service for the update")
    running()
    assert installs() == before, "npm ci ran again with an unchanged package-lock.json"

    # A changed package-lock.json restarts the unit, which installs it. Once
    # installed, the next run has nothing to do.
    before = installs()
    target = push(
        "sed -i 's/\"requires\": true/\"requires\": true, \"x-pushed\": 1/' "
        "lighting-scripts/package-lock.json",
        "lock 1",
    )
    follow_restarts(True)
    assert head() == target
    lock_installed()
    assert installs() == before + 1
    follow_restarts(False)

    # No stamp means an install is running (npm ci empties node_modules
    # first), which a restart would kill: no restart, even for a new
    # package-lock.json. A stamp that differs from package-lock.json
    # restarts the unit, which installs it.
    as_service(
        "mv ${scripts}/node_modules/.lighting-port-lock.sha256 /var/lib/lighting-port/stamp.kept"
    )
    target = push(
        "sed -i 's/\"x-pushed\": 1/\"x-pushed\": 2/' lighting-scripts/package-lock.json",
        "lock 2",
    )
    follow_restarts(False)
    assert head() == target
    as_service(
        "mv /var/lib/lighting-port/stamp.kept ${scripts}/node_modules/.lighting-port-lock.sha256"
    )
    before = installs()
    follow_restarts(True)
    follow_logged("lighting-port-follow: package-lock.json differs from what is installed")
    lock_installed()
    assert installs() == before + 1

    # A run cut off between its update and its restart leaves its request
    # behind, newer than the unit's start: the next run restarts the unit.
    as_service("touch /var/lib/lighting-port/.follow-restart")
    follow_restarts(True)

    # An unreachable origin is logged and tried again next minute, never a
    # failure, and leaves the checkout as it is.
    machine.succeed("mv ${origin} ${origin}.away")
    follow()
    follow_logged("lighting-port-follow: fetching ${branch} from origin failed")
    assert head() == target
    machine.succeed("mv ${origin}.away ${origin}")

    # Nor is a stop in the middle of a fetch (here one that takes 20 s).
    as_service(
        "printf '%s\\n' '[protocol \"ext\"]' 'allow = always' "
        "'[url \"ext::${slowUploadPack} %S ${origin}\"]' 'insteadOf = file://${origin}' "
        "> /var/lib/lighting-port/.gitconfig"
    )
    machine.succeed("systemctl start --no-block lighting-port-follow.service")
    machine.wait_until_succeeds("pgrep -u lighting-port -f slow-upload-pack", timeout=30)
    machine.succeed("systemctl stop lighting-port-follow.service", timeout=60)
    assert follow_show("Result") == "success", follow_show("Result")
    assert follow_show("ActiveState") == "inactive", follow_show("ActiveState")

    # A run that outlasts its bound (150 s; 5 s in a copy of the script,
    # against that 20 s fetch) is stopped by the script itself and exits 0,
    # before systemd's start timeout would leave the unit failed.
    follow_exec = machine.succeed(
        "systemctl cat lighting-port-follow.service | sed -n 's/^ExecStart=//p'"
    ).strip()
    machine.succeed(
        "mkdir -p /var/lib/lighting-port-widened && "
        f"sed 's/^run_seconds=.*/run_seconds=5/' {follow_exec} > /var/lib/lighting-port-widened/follow && "
        "chmod 555 /var/lib/lighting-port-widened/follow && "
        "grep -qx 'run_seconds=5' /var/lib/lighting-port-widened/follow && "
        "mkdir -p /run/systemd/system/lighting-port-follow.service.d && "
        "printf '[Service]\\nExecStart=\\nExecStart=/var/lib/lighting-port-widened/follow\\n' "
        "> /run/systemd/system/lighting-port-follow.service.d/bounded.conf && "
        "systemctl daemon-reload"
    )
    follow()
    follow_logged("lighting-port-follow: the run took longer than 5s; stopped it, trying again next minute")
    machine.succeed(
        ": > /run/systemd/system/lighting-port-follow.service.d/bounded.conf && systemctl daemon-reload"
    )
    as_service(": > /var/lib/lighting-port/.gitconfig")
    follow()
    assert head() == target

    # A git lock left by a run killed outright (a power cut) is moved aside
    # once it is older than any run, instead of failing every later run for
    # good. A fresh one may be a git still running, and is left alone.
    target_before = target
    target = push("printf 'export const locked = 1;\\n' > lighting-scripts/src/port.ts", "locked")
    as_service("touch ${src}/.git/index.lock")
    follow()
    assert head() == target_before
    machine.succeed("test -e ${src}/.git/index.lock")
    as_service("touch -d '-10 min' ${src}/.git/index.lock")
    follow()
    assert head() == target
    machine.succeed("test ! -e ${src}/.git/index.lock")
    follow_logged("lighting-port-follow: moved a stale git lock aside: .git/index.lock")
    machine.succeed("ls /var/lib/lighting-port/.stale-git-locks/*index.lock")

    # A restart request dated in the future (a clock stepped back) is never
    # newer than a start, so it would restart the unit every minute: it is
    # ignored, and set back.
    as_service("touch -d '2099-01-01' /var/lib/lighting-port/.follow-restart")
    follow_restarts(False)
    follow_logged("lighting-port-follow: the restart request was dated in the future; setting it back")
    follow_restarts(False)

    # A followed branch gone from origin (merged and deleted) says so, and
    # leaves the checkout as it is until the option names another branch.
    as_service("git -C ${origin} branch -m ${branch} gone")
    follow()
    follow_logged("lighting-port-follow: branch ${branch} no longer exists on origin")
    assert head() == target
    as_service("git -C ${origin} branch -m gone ${branch}")
    follow()

    # A checkout that keeps failing (here a directory under lighting-scripts
    # outside src/ that it cannot write; a git lock not yet stale or a full
    # disk do the same) never restarts the unit: a restart would land it on
    # a half-updated tree, every minute. Once the checkout gets through, the
    # unit restarts once.
    target_before = target
    target = push("printf 'export const two = 2;\\n' > lighting-scripts/scripts/helper.mjs", "helper 2")
    mode = machine.succeed("stat -c %a ${scripts}/scripts").strip()
    machine.succeed("chmod a-w ${scripts}/scripts")
    stuck = [follow_restarted()[0] for _ in range(3)]
    assert stuck == [False, False, False], f"restarts while the checkout fails: {stuck}"
    # The failed checkout still moves the branch; the file is what is stale.
    machine.succeed("test \"$(cat ${scripts}/scripts/helper.mjs)\" = 'export {};'")
    machine.succeed(f"chmod {mode} ${scripts}/scripts")
    follow_restarts(True)
    assert head() == target
    machine.succeed("test \"$(cat ${scripts}/scripts/helper.mjs)\" = 'export const two = 2;'")
    follow_restarts(False)

    # A run cut off after its checkout, before it asked for the restart it
    # owed, leaves it owed: the next run, with nothing new, asks for it.
    as_service("printf 'owed\\n' > /var/lib/lighting-port/.follow-restart-owed")
    follow_restarts(True)
    follow_restarts(False)

    # Git's own upkeep after a fetch (packing loose objects once there are
    # more than gc.auto, 6700) gets done: started in the background, it
    # would be killed with the rest of the run the moment the oneshot ends,
    # leave the objects loose, and start over on every run. One push brings
    # 20000 loose objects here (as many small fetches do over time); trace2
    # records how each git process ended.
    as_service(
        "mkdir -p /var/lib/lighting-port/trace2 && "
        "printf '%s\\n' '[trace2]' 'eventTarget = /var/lib/lighting-port/trace2' "
        "> /var/lib/lighting-port/.gitconfig && "
        "git -C ${src} config fetch.unpackLimit 1000000"
    )
    push("mkdir bulk && head -c 8000000 /dev/urandom | split -b 400 -a 5 - bulk/", "bulk")
    target = push("mv bulk /tmp/bulk.aside", "bulk gone")

    # The git processes of one run that did not end on their own. trace2
    # writes one file per process, one JSON event per line; a process that
    # ends normally writes `atexit`, one stopped by a signal does not.
    def git_cut_off(run):
        as_service(
            f"mv /var/lib/lighting-port/trace2 /var/lib/lighting-port/trace2.{run} && "
            "mkdir /var/lib/lighting-port/trace2"
        )
        events = [
            json.loads(line)
            for line in machine.succeed(
                f"find /var/lib/lighting-port/trace2.{run} -type f -exec cat {{}} +"
            ).splitlines()
            if line.strip()
        ]
        started = {e["sid"]: e["argv"] for e in events if e["event"] == "start"}
        ended = {e["sid"] for e in events if e["event"] == "atexit"}
        return [" ".join(argv) for sid, argv in started.items() if sid not in ended]

    def loose_objects():
        counts = as_service("git -C ${src} count-objects -v")
        fields = dict(line.split(": ", 1) for line in counts.splitlines())
        return int(fields["count"])

    git_cut_off("pushes")
    for run in range(2):
        follow()
        cut_off = git_cut_off(run)
        loose = loose_objects()
        leftovers = machine.succeed(
            "find ${src}/.git/objects/pack -name 'tmp_*' -o -name '.tmp-*'"
        ).split()
        print(f"git cut off: {cut_off}; loose objects: {loose}; temporary packs: {leftovers}")
    assert head() == target
    assert cut_off == [], f"git processes cut off by the end of the run: {cut_off}"
    assert loose < 6700, f"{loose} loose objects left after two runs"
    assert leftovers == [], leftovers
    as_service(": > /var/lib/lighting-port/.gitconfig && git -C ${src} config --unset fetch.unpackLimit")

    # node_modules the service cannot rewrite (npm run as the operator with
    # umask 022) is the operator's to fix, and says so, instead of an npm ci
    # that fails with EACCES on every retry.
    as_operator("umask 022; mkdir ${scripts}/node_modules/foreign")
    as_operator(
        "sed -i 's/\"requires\": true/\"requires\": true, \"x-edited\": 1/' ${scripts}/package-lock.json"
    )
    restart()
    refused("${scripts}/node_modules/foreign is not writable by lighting-port")

    # Given back, the changed package-lock.json is installed on the next start.
    machine.succeed("chown -R lighting-port:lighting-port ${scripts}/node_modules")
    before = installs()
    restart()
    machine.wait_until_succeeds(
        "test \"$(cat ${scripts}/node_modules/.lighting-port-lock.sha256)\" = "
        "\"$(sha256sum ${scripts}/package-lock.json | cut -d' ' -f1)\"",
        timeout=120,
    )
    assert installs() == before + 1
    running()

    # A failing npm ci is retried with backoff, never counted.
    machine.succeed(
        "cp ${scripts}/package-lock.json /tmp/lock.good && "
        "printf 'not json\\n' > ${scripts}/package-lock.json"
    )
    restart()
    stays_uncounted(5)
    logged("lighting-port: npm ci failed; retrying in 10s (setup failure 1 in a row)")
    machine.succeed("cp /tmp/lock.good ${scripts}/package-lock.json")
    restart_watcher()

    # An unforeseen setup failure (here an unreadable package-lock.json) is
    # retried like any other, not left to errexit and a non-zero status.
    mode = machine.succeed("stat -c %a ${scripts}/package-lock.json").strip()
    machine.succeed("chmod 000 ${scripts}/package-lock.json")
    restart()
    stays_uncounted(5)
    logged("lighting-port: setup failed unexpectedly (status 1); retrying in 10s (setup failure 1 in a row)")
    machine.succeed(f"chmod {mode} ${scripts}/package-lock.json")
    restart_watcher()

    # A step that fails after the install (here .runtime replaced by a file)
    # still counts: the install that got through does not reset the count, so
    # the failure backs off instead of retrying every 10 s for good.
    machine.succeed("systemctl stop lighting-port.service")
    as_service("mv ${scripts}/.runtime ${scripts}/.runtime.kept && touch ${scripts}/.runtime")
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    machine.succeed("systemctl start lighting-port.service")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F 'lighting-port: setup failed unexpectedly (status 1); retrying in 20s (setup failure 2 in a row)'",
        timeout=60,
    )
    machine.succeed("systemctl stop lighting-port.service")
    as_service("mv ${scripts}/.runtime ${scripts}/.runtime.file && mv ${scripts}/.runtime.kept ${scripts}/.runtime")
    restart_watcher()

    # The port's real watcher, running a host whose shutdown takes a moment:
    # a stop reaches the host once, through the watcher, and the host
    # finishes its shutdown instead of dying halfway with its lock left.
    machine.succeed(
        "cp ${realWatcher} ${scripts}/scripts/dev.mjs && "
        "mkdir -p ${scripts}/src ${scripts}/node_modules/typescript/bin && "
        "cp ${standInHost} ${scripts}/src/main.ts && "
        "cp ${standInCompiler} ${scripts}/node_modules/typescript/bin/tsc && "
        "chown -R lighting-port:lighting-port ${scripts}/scripts ${scripts}/src ${scripts}/node_modules/typescript && "
        "chmod -R ug+rw ${scripts}/scripts ${scripts}/src"
    )
    restart()
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/host-started", timeout=60)
    machine.succeed("test -e ${scripts}/.runtime/journal.json.lock")

    # The watcher dying alone (killed for memory, an fs.watch error) does not
    # leave its host running unsupervised through the backoff, to be killed
    # outright when the backoff ends: the host is stopped, and finishes its
    # shutdown, before the unit backs off.
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    machine.succeed("pkill -KILL -u lighting-port -f scripts/dev.mjs")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F 'lighting-port: watcher exited with status 137 after '",
        timeout=60,
    )
    machine.succeed("grep -Fx clean ${scripts}/.runtime/clean")
    machine.succeed("test ! -e ${scripts}/.runtime/journal.json.lock")
    machine.fail("pgrep -u lighting-port -f src/main.ts")
    never_counted_as_failed()
    as_service(": > ${scripts}/.runtime/clean && : > ${scripts}/.runtime/host-started")
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/host-started", timeout=90)

    stops_promptly()
    machine.succeed("grep -Fx clean ${scripts}/.runtime/clean")
    machine.succeed("test ! -e ${scripts}/.runtime/journal.json.lock")

    # Starting over from a fresh clone, step by step as the docs say: the
    # catalog and the journal live in the checkout's .runtime and are carried
    # into the new one, still the service's, instead of a clone that refuses
    # for a missing catalog and a port that starts without its journal.
    as_service("printf 'kept\\n' > ${scripts}/.runtime/journal.json")
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    machine.succeed("systemctl stop lighting-port.service")
    as_operator("mv /var/lib/lighting-port/src /var/lib/lighting-port/src.old")
    machine.succeed("systemctl start lighting-port.service")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F "
        "'lighting-port: refusing to start: ${scripts}/.runtime/catalog.json does not exist'",
        timeout=120,
    )
    as_operator(
        "mv /var/lib/lighting-port/src.old/lighting-scripts/.runtime/* ${scripts}/.runtime/"
    )
    restart_watcher()
    machine.succeed("grep -Fx kept ${scripts}/.runtime/journal.json")
    machine.succeed(
        "test \"$(stat -c '%U:%G' ${scripts}/.runtime/journal.json)\" = 'lighting-port:lighting-port'"
    )
    machine.succeed("systemctl stop lighting-port.service")

    # A checkout the operator moves back while a clone runs (here a clone
    # that takes 20 s) is theirs: the finished clone never lands inside it,
    # and the next start runs it.
    as_service(": > ${scripts}/.runtime/record.json")
    machine.succeed("mv ${src} /var/lib/lighting-port/src.kept")
    as_service(
        "printf '%s\\n' '[protocol \"ext\"]' 'allow = always' "
        "'[url \"ext::${slowUploadPack} %S ${origin}\"]' 'insteadOf = file://${origin}' "
        "> /var/lib/lighting-port/.gitconfig"
    )
    machine.succeed("systemctl start lighting-port.service")
    machine.wait_until_succeeds("test -d /var/lib/lighting-port/.src.partial", timeout=30)
    as_operator("mv /var/lib/lighting-port/src.kept ${src}")
    machine.wait_until_succeeds("test -s ${scripts}/.runtime/record.json", timeout=120)
    machine.succeed("test ! -e ${src}/.src.partial")
    machine.succeed("test -d /var/lib/lighting-port/.src.partial/lighting-scripts")
    machine.succeed("systemctl stop lighting-port.service")
    machine.succeed("mv ${src} /var/lib/lighting-port/src.kept")

    # An origin that stalls mid-clone: a stop meanwhile is prompt, and the
    # clone gives up and is retried instead of holding the unit forever. The
    # service's git is pointed at it through its own ~/.gitconfig.
    machine.succeed("systemd-run --unit=stalling-origin ${stallingOrigin}")
    machine.wait_for_open_port(8443)
    machine.succeed(
        "printf '%s\\n' "
        "'[url \"https://127.0.0.1:8443/smarthome.git\"]' 'insteadOf = file://${origin}' "
        "'[http \"https://127.0.0.1:8443/\"]' 'sslVerify = false' "
        "> /var/lib/lighting-port/.gitconfig"
    )
    machine.succeed("systemctl start lighting-port.service")
    machine.wait_until_succeeds("pgrep -u lighting-port -f git-remote-https", timeout=30)
    stops_promptly()
    marker = machine.succeed("date +%s").strip()
    machine.sleep(1)
    machine.succeed("systemctl start lighting-port.service")
    # Still stalled well after it connected: nothing else ends this clone.
    machine.wait_until_succeeds("pgrep -u lighting-port -f git-remote-https", timeout=30)
    machine.sleep(15)
    machine.succeed("pgrep -u lighting-port -f git-remote-https")
    machine.fail(journal_since(marker) + " | grep -F 'lighting-port: clone failed'")
    machine.wait_until_succeeds(
        journal_since(marker) + " | grep -F 'lighting-port: clone failed; retrying in'",
        timeout=150,
    )

    never_counted_as_failed()
    machine.fail("systemctl --failed --no-legend --plain | grep -F lighting-port")
  '';
}
