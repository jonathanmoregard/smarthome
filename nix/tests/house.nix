{
  pkgs,
  module,
  package,
  house,
}:

let
  sshKeys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  fakeZigbee2mqtt = pkgs.writers.writePython3Bin "fake-zigbee2mqtt" {
    libraries = [ pkgs.python3Packages.paho-mqtt ];
  } (builtins.readFile ./fake-zigbee2mqtt.py);
  production = builtins.fromTOML (builtins.readFile ../../nixos/hosts/home-server/house.toml);
in
pkgs.testers.runNixOSTest {
  name = "house";

  nodes.server =
    { lib, ... }:
    {
      imports = [ module ];

      services.openssh.enable = true;
      users.users.jonathan = {
        isNormalUser = true;
        openssh.authorizedKeys.keys = [ sshKeys.snakeOilEd25519PublicKey ];
      };

      services.mosquitto = {
        enable = true;
        listeners = [
          {
            address = "127.0.0.1";
            port = 1883;
            omitPasswordAuth = true;
            acl = [
              "topic readwrite zigbee2mqtt/#"
              "topic readwrite house/v1/#"
            ];
            settings.allow_anonymous = true;
          }
        ];
      };

      systemd.services.fake-zigbee2mqtt = {
        wantedBy = [ "multi-user.target" ];
        requires = [ "mosquitto.service" ];
        after = [ "mosquitto.service" ];
        environment.FAKE_Z2M_SEED = "${../../house-automationd/tests/fixtures/bridge-devices.json}";
        serviceConfig = {
          ExecStart = pkgs.lib.getExe fakeZigbee2mqtt;
          StateDirectory = "fake-zigbee2mqtt";
          RuntimeDirectory = "fake-zigbee2mqtt";
        };
      };

      # The shipped production topology, with a fast refresh so a stopped
      # command stream is visible within seconds.
      services.houseAutomation = {
        enable = true;
        inherit package;
        settings = lib.recursiveUpdate production {
          circadian = {
            tick_seconds = 0.5;
            maximum_refresh_seconds = 2.0;
          };
        };
      };
      systemd.services.house-automationd = {
        requires = [ "mosquitto.service" ];
        after = [ "mosquitto.service" ];
      };

      environment.systemPackages = [
        pkgs.coreutils
        pkgs.curl
        pkgs.jq
        pkgs.mosquitto
      ];
    };

  nodes.client =
    { ... }:
    {
      environment.systemPackages = [ house ];
      programs.ssh.extraConfig = ''
        Host server
          User jonathan
          IdentityFile /root/.ssh/id_ed25519
          StrictHostKeyChecking accept-new
      '';
    };

  testScript = ''
    import time

    OLD = "0x7cc6b6fffe3cef1c"
    LAMP = "upper-floor/upper-hallway/lamp"
    BULB = "upper-floor/upper-hallway/bulb"
    STATE = "/var/lib/fake-zigbee2mqtt"


    def sets(name):
        out = server.succeed(
            f"grep -c -F 'zigbee2mqtt/{name}/set {{' /tmp/mqtt.log || true"
        )
        return int(out.strip() or "0")


    def wait_for_sets(name, timeout=60):
        deadline = time.monotonic() + timeout
        while sets(name) == 0:
            assert time.monotonic() < deadline, f"no command reached {name}"
            time.sleep(0.5)


    def house(args):
        return client.succeed(f"house --host server {args} 2>&1")


    start_all()
    server.wait_for_unit("sshd.service")
    server.wait_for_unit("fake-zigbee2mqtt.service")
    server.wait_for_unit("house-automationd.service")
    server.succeed(
        "systemd-run --unit=mqtt-recorder "
        "--property=StandardOutput=append:/tmp/mqtt.log "
        "${pkgs.coreutils}/bin/stdbuf -oL ${pkgs.mosquitto}/bin/mosquitto_sub -h 127.0.0.1 -v -t 'zigbee2mqtt/#'"
    )
    client.wait_for_unit("multi-user.target")
    client.succeed(
        "install -d -m 700 /root/.ssh && "
        "install -m 600 ${sshKeys.snakeOilEd25519PrivateKey} /root/.ssh/id_ed25519"
    )
    client.wait_until_succeeds("ssh -o ConnectTimeout=3 server true", timeout=60)

    with subtest("an unnamed light follows the curve as soon as it is discovered"):
        wait_for_sets(OLD)
        server.succeed(
            "curl -sS http://127.0.0.1:9876/healthz | jq -e '.discovery == \"synced\"'"
        )

    with subtest("list shows every device, its model and whether it is controlled"):
        out = house("list")
        for expected in [
            OLD,
            "IKEA LED2111G6",
            "controlled (house)",
            "IKEA E1524/E1810",
            "not controlled: not a light",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"

    with subtest("rename moves the lamp into its room and off its old name"):
        out = house(f"rename {OLD} {LAMP}")
        assert f"Renamed {OLD} to {LAMP}." in out, out
        assert "owner: room upper-hallway" in out, out
        wait_for_sets(LAMP, timeout=30)
        before_old, before_new = sets(OLD), sets(LAMP)
        time.sleep(6)
        assert sets(OLD) == before_old, "commanded under its old name"
        assert sets(LAMP) > before_new, "the renamed lamp stopped following"
        out = house(f"show {LAMP}")
        for expected in [
            "Room:          upper-hallway on upper-floor",
            "Controlled:    yes, follows room upper-hallway",
            "Circadian:     on",
            "Availability:  online",
            "Live state:    OFF",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"

    with subtest("identify flashes a lamp through its identify expose"):
        out = house(f"identify {LAMP}")
        assert f"{LAMP} is flashing for 10 s." in out, out
        server.succeed(
            f"jq -e -s 'any(.id == \"{LAMP}\" and .options.identify_timeout == 10)' "
            f"{STATE}/options.jsonl"
        )
        server.succeed(
            f"jq -e -s 'any(.device == \"{LAMP}\" and .identify == \"identify\")' "
            f"{STATE}/identify.jsonl"
        )

    with subtest("remove stops every command to the lamp"):
        out = house(f"remove {LAMP}")
        assert f"Removed {LAMP}." in out, out
        server.wait_until_succeeds(
            f"curl -fsS http://127.0.0.1:9876/devices | "
            f"jq -e 'all(.friendly_name != \"{LAMP}\")'"
        )
        before = sets(LAMP)
        time.sleep(6)
        assert sets(LAMP) == before, "a removed lamp was still commanded"
        assert LAMP not in house("list")

    with subtest("add pairs a new lamp, names it, and it follows the curve"):
        out = house(f"add {BULB} --time 20")
        for expected in [
            "Paired: IKEA LED2201G8",
            f"Renamed 0x000b57fffe123456 to {BULB}.",
            "owner: room upper-hallway",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"
        wait_for_sets(BULB, timeout=30)

    with subtest("identify falls back to a breathe effect"):
        out = house(f"identify {BULB} --seconds 1")
        assert f"{BULB} is breathing for 1 s." in out, out
        server.succeed(
            f"jq -e -s '[.[] | select(.device == \"{BULB}\") | .effect] "
            f"== [\"breathe\", \"stop_effect\"]' {STATE}/identify.jsonl"
        )

    with subtest("a refused removal points at --force"):
        server.succeed("touch /run/fake-zigbee2mqtt/refuse-remove")
        status, out = client.execute(f"house --host server remove {BULB} 2>&1")
        assert status == 1, f"exit {status}\n{out}"
        assert f"house remove {BULB} --force" in out, out
        out = house(f"remove {BULB} --force")
        assert f"Removed {BULB}." in out, out
        server.succeed("rm /run/fake-zigbee2mqtt/refuse-remove")

    with subtest("bad input is refused before anything connects"):
        for args in [
            "",
            "bogus",
            "add kitchen",
            "add a/b/c --time 0",
            "rename x Upper/hall/lamp",
            "rename x a/b/set",
            "identify x --seconds 31",
            "show",
            "remove",
            "--host -oProxyCommand=touch list",
        ]:
            status, out = client.execute(f"house {args} 2>&1")
            assert status == 64, f"{args!r}: exit {status}\n{out}"
        status, out = client.execute("house --host server show nosuch 2>&1")
        assert status == 1 and "no device named nosuch" in out, out
  '';
}
