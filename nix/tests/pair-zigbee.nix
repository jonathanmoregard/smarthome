{
  pkgs,
  pairZigbee,
}:

let
  sshKeys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  fakeZigbee2mqtt = pkgs.writers.writePython3Bin "fake-zigbee2mqtt" {
    libraries = [ pkgs.python3Packages.paho-mqtt ];
  } (builtins.readFile ./fake-zigbee2mqtt.py);
in
pkgs.testers.runNixOSTest {
  name = "pair-zigbee";

  nodes.server =
    { ... }:
    {
      services.openssh.enable = true;
      users.users.jonathan = {
        isNormalUser = true;
        openssh.authorizedKeys.keys = [ sshKeys.snakeOilEd25519PublicKey ];
      };

      # Same shape as the production loopback listener: anonymous, reachable
      # only on 127.0.0.1, restricted to the Zigbee2MQTT and house trees.
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
        serviceConfig = {
          ExecStart = pkgs.lib.getExe fakeZigbee2mqtt;
          StateDirectory = "fake-zigbee2mqtt";
          RuntimeDirectory = "fake-zigbee2mqtt";
        };
      };

      environment.systemPackages = [ pkgs.mosquitto ];
    };

  nodes.client =
    { ... }:
    {
      environment.systemPackages = [ pairZigbee ];
      programs.ssh.extraConfig = ''
        Host server
          User jonathan
          IdentityFile /root/.ssh/id_ed25519
          StrictHostKeyChecking accept-new
      '';
    };

  testScript = ''
    import json
    import time

    REQUESTS = "/var/lib/fake-zigbee2mqtt/requests.jsonl"


    def request_times():
        out = server.succeed(f"cat {REQUESTS} 2>/dev/null || true")
        return [json.loads(line)["time"] for line in out.splitlines() if line]


    def reset_requests():
        server.succeed(f"rm -f {REQUESTS}")


    def wait_for_request_times(expected, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            actual = request_times()
            if actual == expected or time.monotonic() > deadline:
                assert actual == expected, f"requests {actual}, expected {expected}"
                return
            time.sleep(0.5)


    def run(args):
        return client.execute(f"pair-zigbee {args} 2>&1")


    def run_unit(unit, args):
        client.succeed(
            f"systemd-run --unit={unit} "
            f"--property=StandardOutput=append:/tmp/{unit}.out "
            f"--property=StandardError=append:/tmp/{unit}.out "
            f"pair-zigbee {args}"
        )


    def wait_for_failed_unit(unit):
        client.wait_until_succeeds(
            f"systemctl show -p ActiveState --value {unit}.service | grep -qx failed",
            timeout=60,
        )
        status = client.succeed(
            f"systemctl show -p ExecMainStatus --value {unit}.service"
        ).strip()
        return status, client.succeed(f"cat /tmp/{unit}.out")


    def assert_no_leftovers():
        client.fail("pgrep -x ssh")
        client.fail("pgrep -x mosquitto_sub")
        client.fail("ls -d /tmp/tmp.*")


    start_all()
    server.wait_for_unit("sshd.service")
    server.wait_for_unit("fake-zigbee2mqtt.service")
    server.wait_until_succeeds(
        "mosquitto_sub -h 127.0.0.1 -t zigbee2mqtt/bridge/state -C 1 -W 2 | grep -q online"
    )
    client.wait_for_unit("multi-user.target")
    client.succeed(
        "install -d -m 700 /root/.ssh && "
        "install -m 600 ${sshKeys.snakeOilEd25519PrivateKey} /root/.ssh/id_ed25519"
    )
    client.wait_until_succeeds("ssh -o ConnectTimeout=3 server true", timeout=60)

    with subtest("arguments are validated before anything connects"):
        for args in [
            "--time 0",
            "--time 255",
            "--time abc",
            "--time",
            "--host -oProxyCommand=touch",
            "--bogus",
        ]:
            status, out = run(args)
            assert status == 64, f"{args!r}: exit {status}\n{out}"
        assert request_times() == []
        status, out = run("--help")
        assert status == 0 and "Usage: pair-zigbee" in out, out

    with subtest("an unreachable host is reported as a connection problem"):
        status, out = run("--host nosuchhost.invalid --time 5")
        assert status == 69, f"exit {status}\n{out}"
        assert "could not connect to nosuchhost.invalid over SSH" in out, out
        assert_no_leftovers()

    with subtest("pairing opens, reports the bulb, and closes again"):
        reset_requests()
        status, out = run("--host server --time 5")
        assert status == 0, f"exit {status}\n{out}"
        for expected in [
            "Pairing is open for 5 seconds",
            "New device joined: 0x000b57fffe123456",
            "Paired: IKEA LED2201G8 - TRADFRI bulb E27",
            "Pairing closed.",
            "1 device paired:",
            "IKEA LED2201G8 (0x000b57fffe123456)",
        ]:
            assert expected in out, f"missing {expected!r}\n{out}"
        wait_for_request_times([5, 0])
        transaction = json.loads(server.succeed(f"head -n1 {REQUESTS}"))["transaction"]
        assert transaction.startswith("pair-zigbee-"), transaction
        assert_no_leftovers()

    with subtest("Ctrl-C closes pairing before the tunnel goes away"):
        reset_requests()
        run_unit("pair-interrupted", "--host server --time 200")
        client.wait_until_succeeds(
            "grep -q 'Paired: IKEA' /tmp/pair-interrupted.out", timeout=60
        )
        # A terminal delivers Ctrl-C to the whole foreground process group.
        client.succeed("systemctl kill --signal=SIGINT pair-interrupted.service")
        status, out = wait_for_failed_unit("pair-interrupted")
        assert status == "130", f"exit {status}\n{out}"
        assert "Pairing closed." in out, out
        wait_for_request_times([200, 0])

    with subtest("termination closes pairing and SMARTHOME_HOST picks the server"):
        reset_requests()
        client.succeed(
            "systemd-run --unit=pair-terminated --setenv=SMARTHOME_HOST=server "
            "--property=StandardOutput=append:/tmp/pair-terminated.out "
            "--property=StandardError=append:/tmp/pair-terminated.out "
            "pair-zigbee --time 200"
        )
        client.wait_until_succeeds(
            "grep -q 'Pairing is open' /tmp/pair-terminated.out", timeout=60
        )
        # Like `kill <pid>`: only the command itself is signalled.
        client.succeed(
            "systemctl kill --kill-whom=main --signal=SIGTERM pair-terminated.service"
        )
        status, out = wait_for_failed_unit("pair-terminated")
        assert status == "143", f"exit {status}\n{out}"
        assert "Connecting to server..." in out, out
        assert "Pairing closed." in out, out
        wait_for_request_times([200, 0])

    with subtest("a refused request is reported and nothing is left open"):
        reset_requests()
        server.succeed("touch /run/fake-zigbee2mqtt/reject")
        status, out = run("--host server --time 30")
        server.succeed("rm /run/fake-zigbee2mqtt/reject")
        assert status == 1, f"exit {status}\n{out}"
        assert "Zigbee2MQTT refused to open pairing: simulated adapter failure" in out, out
        assert "Pairing is open" not in out, out
        wait_for_request_times([30])
        assert_no_leftovers()

    with subtest("losing the tunnel mid-window is reported"):
        reset_requests()
        run_unit("pair-dropped", "--host server --time 200")
        client.wait_until_succeeds(
            "grep -q 'Pairing is open' /tmp/pair-dropped.out", timeout=60
        )
        server.succeed("pkill -KILL -u jonathan")
        status, out = wait_for_failed_unit("pair-dropped")
        assert status == "1", f"exit {status}\n{out}"
        assert "lost the connection to server" in out, out
        assert "closes by itself" in out, out

    with subtest("a stopped or never-started bridge is refused without a request"):
        server.succeed(
            "systemd-run --unit=request-watch "
            "--property=StandardOutput=append:/tmp/requests-seen "
            "mosquitto_sub -h 127.0.0.1 -v -t 'zigbee2mqtt/bridge/request/#'"
        )
        server.succeed("systemctl stop fake-zigbee2mqtt.service")
        server.wait_until_succeeds(
            "mosquitto_sub -h 127.0.0.1 -t zigbee2mqtt/bridge/state -C 1 -W 2 | grep -q offline"
        )
        status, out = run("--host server --time 30")
        assert status == 69, f"exit {status}\n{out}"
        assert "Zigbee2MQTT is not running on server (bridge state: offline)" in out, out

        server.succeed("mosquitto_pub -h 127.0.0.1 -r -n -t zigbee2mqtt/bridge/state")
        status, out = run("--host server --time 30")
        assert status == 69, f"exit {status}\n{out}"
        assert "Zigbee2MQTT is not running on server (bridge state: never reported)" in out, out

        server.succeed("systemctl stop request-watch.service")
        assert server.succeed("cat /tmp/requests-seen") == "", "a request was published"
        assert_no_leftovers()
  '';
}
