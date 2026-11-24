# lighting-port: the unit's runtime contract, against a stand-in checkout.
#
# The sandbox has no network, so the origin is a local bare repository and the
# checkout is a stand-in: a lighting-scripts/ with a package-lock.json whose
# only dependency is a local link (so `npm ci` runs offline), and a
# scripts/dev.mjs that records what the unit handed it instead of talking to
# Home Assistant.
#
# What is pinned, and why each matters:
#   - a clone that cannot happen yet (origin unreachable) leaves the unit
#     restarting with a zero exit status, never `failed` and never
#     auto-restarting on a non-zero status, because switch-to-configuration
#     counts exactly those two as a failed deploy and the deployer rolls back;
#   - a refusal (env file or LIVE_ROOMS missing, token unreadable, catalog
#     missing) stops the unit cleanly with status 78 and runs nothing;
#   - the watcher gets the agreed command line and environment;
#   - a crashing watcher is restarted, again with a zero main status;
#   - an existing checkout is never pulled or reset, and `npm ci` reruns only
#     when package-lock.json changes;
#   - the operator, as a member of the group, edits the env file and the
#     checkout without sudo, and git works for them in the checkout.
#
#   nix build --no-link -L .#checks.x86_64-linux.lighting-port
{
  pkgsSystem,
  agenix,
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
  # standing in for a host that crashes.
  standInWatcher = pkgsSystem.writeText "dev.mjs" ''
    import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const crashing = () => {
      try { return readFileSync('.runtime/crash', 'utf8').trim() === 'yes'; } catch { return false; }
    };
    if (crashing()) process.exit(3);
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

  standInCheckout = pkgsSystem.runCommand "lighting-port-stand-in-checkout" { } ''
    mkdir -p "$out/lighting-scripts/scripts" "$out/lighting-scripts/stand-in-dep"
    cp ${standInWatcher} "$out/lighting-scripts/scripts/dev.mjs"
    printf '%s\n' 'node_modules/' '.runtime/' > "$out/lighting-scripts/.gitignore"
    cat > "$out/lighting-scripts/stand-in-dep/package.json" <<'JSON'
    {"name": "stand-in-dep", "version": "0.0.0"}
    JSON
    cat > "$out/lighting-scripts/package.json" <<'JSON'
    {"name": "stand-in", "version": "0.0.0", "private": true,
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
        ../modules/lighting-port.nix
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

      system.extraDependencies = [ standInCheckout ];
    };

  testScript = ''
    import json
    import shlex

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

    machine.wait_for_unit("multi-user.target")
    machine.succeed("test \"$(stat -c '%U:%G %a' /var/lib/lighting-port)\" = 'lighting-port:lighting-port 2770'")
    machine.succeed("test \"$(stat -c '%U:%G %a' /run/agenix/lighting-port-ha-token)\" = 'lighting-port:lighting-port 400'")

    # The origin does not exist yet: the clone fails and is retried, and the
    # unit stays out of the states a switch would count against a deploy.
    machine.wait_until_succeeds(
        "journalctl -u lighting-port.service -o cat --no-pager | "
        "grep -F 'lighting-port: clone failed'",
        timeout=120,
    )
    machine.wait_until_succeeds(
        "test \"$(systemctl show lighting-port.service -P NRestarts)\" -ge 1", timeout=60
    )
    never_counted_as_failed()
    machine.succeed("test ! -e ${src}")

    machine.succeed(
        "cp -r ${standInCheckout} /tmp/work && chmod -R u+w /tmp/work && "
        "git -C /tmp/work init -q -b ${branch} && "
        "git -C /tmp/work -c user.name=t -c user.email=t@example.invalid add -A && "
        "git -C /tmp/work -c user.name=t -c user.email=t@example.invalid commit -q -m stand-in && "
        "git clone -q --bare /tmp/work ${origin} && "
        "chown -R lighting-port:lighting-port ${origin}"
    )

    # Cloned on a later attempt, dependencies installed, then refused: there
    # is no env file, so nothing may run.
    refused("/var/lib/lighting-port/env does not exist")
    machine.succeed("test -d ${src}/.git")
    machine.succeed("test -L ${scripts}/node_modules/stand-in-dep")
    machine.succeed(
        "test \"$(cat ${scripts}/node_modules/.lighting-port-lock.sha256)\" = "
        "\"$(sha256sum ${scripts}/package-lock.json | cut -d' ' -f1)\""
    )
    machine.succeed("test ! -e ${scripts}/.runtime/record.json")

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
    restarts = int(show("NRestarts"))
    as_operator("printf 'yes\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds(
        "journalctl -u lighting-port.service -o cat --no-pager | "
        "grep -F 'lighting-port: watcher exited with status 3'",
        timeout=60,
    )
    machine.wait_until_succeeds(
        f"test \"$(systemctl show lighting-port.service -P NRestarts)\" -gt {restarts}",
        timeout=60,
    )
    for _ in range(10):
        never_counted_as_failed()
        machine.sleep(1)
    as_operator("printf 'no\\n' > ${scripts}/.runtime/crash")
    machine.wait_until_succeeds(
        "test \"$(systemctl show lighting-port.service -P SubState)\" = running", timeout=60
    )

    # The checkout is the operator's working copy: a local edit and a newer
    # origin commit both survive a restart untouched, and git works for the
    # operator in a checkout another user owns.
    head = machine.succeed("git -C ${src} rev-parse HEAD").strip()
    as_operator("printf 'local edit\\n' >> ${scripts}/scripts/dev.mjs.note")
    as_operator("git -C ${src} status --porcelain")
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
    installs = machine.succeed(
        "journalctl -u lighting-port.service -o cat --no-pager | grep -cF 'lighting-port: running npm ci'"
    ).strip()
    restart()
    machine.wait_until_succeeds(
        "test \"$(systemctl show lighting-port.service -P SubState)\" = running", timeout=60
    )
    assert machine.succeed("git -C ${src} rev-parse HEAD").strip() == head
    machine.succeed("grep -Fx 'local edit' ${scripts}/scripts/dev.mjs.note")
    machine.succeed("test ! -e ${src}/upstream")
    assert machine.succeed(
        "journalctl -u lighting-port.service -o cat --no-pager | grep -cF 'lighting-port: running npm ci'"
    ).strip() == installs, "npm ci ran again with an unchanged package-lock.json"

    # A changed package-lock.json is installed again on the next start.
    as_operator(
        "sed -i 's/\"requires\": true/\"requires\": true, \"x-edited\": 1/' ${scripts}/package-lock.json"
    )
    restart()
    machine.wait_until_succeeds(
        "test \"$(cat ${scripts}/node_modules/.lighting-port-lock.sha256)\" = "
        "\"$(sha256sum ${scripts}/package-lock.json | cut -d' ' -f1)\"",
        timeout=120,
    )
    assert int(machine.succeed(
        "journalctl -u lighting-port.service -o cat --no-pager | grep -cF 'lighting-port: running npm ci'"
    ).strip()) == int(installs) + 1

    never_counted_as_failed()
    machine.fail("systemctl --failed --no-legend --plain | grep -F lighting-port")
  '';
}
