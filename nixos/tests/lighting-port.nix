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
#   - a stop is prompt in every phase (a backoff, a stalled clone), and a
#     clone from an origin that stalls gives up and is retried;
#   - repeated setup failures back off, so a dead origin is not hammered, and
#     so does a watcher that exits again right after each start (the port
#     refusing its rooms, catalog or token); that count starts over once the
#     watcher has run a while;
#   - a refusal (env file or LIVE_ROOMS missing, token unreadable, catalog
#     missing, node_modules not writable by the service) stops the unit
#     cleanly with status 78 and runs nothing; .runtime exists, writable by
#     the port, from the first refusal on, so the operator can drop the
#     catalog in;
#   - the watcher gets the agreed command line and environment;
#   - with the port's real watcher (fixtures/lighting-port-dev.mjs), a stop
#     reaches the host once, and the host finishes its own shutdown;
#   - an existing checkout is never pulled or reset; `npm ci` reruns only
#     when package-lock.json changes, and never runs lifecycle scripts;
#   - the operator, as a member of the group, edits the env file and the
#     checkout without sudo; git trusts the checkout only as lighting-port,
#     which can write its .git/config; a file git rewrites when run as the
#     docs say (sudo -u lighting-port) stays editable by the operator.
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
  # fe27322b). It forwards its SIGTERM to the host it runs, so it decides how
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

    def installs():
        return int(machine.succeed(
            "journalctl -u lighting-port.service -o cat --no-pager | "
            "grep -cF 'lighting-port: running npm ci' || true"
        ).strip())

    machine.wait_for_unit("multi-user.target")
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
    # a checkout. A restart in the middle of a backoff stops cleanly.
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
    restart()

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
    # whatever the operator's umask; the operator drops the catalog in.
    as_operator("printf '{}\\n' > ${scripts}/.runtime/catalog.json")

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
    machine.succeed(
        ": > /run/systemd/system/lighting-port.service.d/widened.conf && systemctl daemon-reload"
    )
    restart_watcher()

    # The checkout is the operator's working copy: a local edit and a newer
    # origin commit both survive a restart untouched. Git trusts it only as
    # lighting-port: anyone who can write .git/config could otherwise run
    # commands as whoever runs git there.
    head = as_service("git -C ${src} rev-parse HEAD").strip()
    as_operator("printf 'local edit\\n' >> ${scripts}/scripts/dev.mjs.note")
    machine.fail("git config --system --get-all safe.directory")
    machine.fail("runuser -u jonathan -- git -C ${src} status --porcelain")
    as_service("git -C ${src} status --porcelain")
    machine.succeed(
        "printf 'upstream\\n' > /tmp/work/upstream && "
        "git -C /tmp/work -c user.name=t -c user.email=t@example.invalid add -A && "
        "git -C /tmp/work -c user.name=t -c user.email=t@example.invalid commit -q -m upstream && "
        # The origin belongs to lighting-port, and git will not push into a
        # repository another user owns, so root takes it back for the push.
        "chown -R root:root ${origin} && "
        "git -C /tmp/work push -q ${origin} ${branch} && "
        "chown -R lighting-port:lighting-port ${origin}"
    )
    before = installs()
    restart_watcher()
    assert as_service("git -C ${src} rev-parse HEAD").strip() == head
    machine.succeed("grep -Fx 'local edit' ${scripts}/scripts/dev.mjs.note")
    machine.succeed("test ! -e ${src}/upstream")
    assert installs() == before, "npm ci ran again with an unchanged package-lock.json"

    # Git run in the checkout as the docs say (sudo -u lighting-port) leaves
    # a file it rewrites editable by the operator, as the unit's own writes
    # are.
    as_operator("printf 'drift\\n' >> ${scripts}/.gitignore")
    machine.succeed("sudo -u lighting-port git -C ${src} checkout -- lighting-scripts/.gitignore")
    machine.succeed("test \"$(stat -c '%U:%G %a' ${scripts}/.gitignore)\" = 'lighting-port:lighting-port 660'")
    as_operator("printf '# edited in place\\n' >> ${scripts}/.gitignore")

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
    stops_promptly()
    machine.succeed("grep -Fx clean ${scripts}/.runtime/clean")
    machine.succeed("test ! -e ${scripts}/.runtime/journal.json.lock")

    # An origin that stalls mid-clone: a stop meanwhile is prompt, and the
    # clone gives up and is retried instead of holding the unit forever. The
    # service's git is pointed at it through its own ~/.gitconfig.
    machine.succeed("mv ${src} /var/lib/lighting-port/src.kept")
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
