{
  agenix,
  nixosSystem,
  pkgsSystem,
  host,
}:

let
  physicalCoordinator =
    "/dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0";
  zigbeeTestAgenix = pkgsSystem.runCommand "home-server-zigbee-test-agenix"
    {
      nativeBuildInputs = [
        pkgsSystem.age
        pkgsSystem.openssh
      ];
    }
    ''
      mkdir -p "$out"
      ssh-keygen -q -t ed25519 -N "" -C "home-server Zigbee test identity" \
        -f "$out/id_ed25519"
      recipient="$(cat "$out/id_ed25519.pub")"
      printf '%s' '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]' \
        | age -r "$recipient" -o "$out/zigbee2mqtt-network-key.age"
    '';
  mqttUsernameAssertion = username:
    let
      evaluated = nixosSystem {
        system = "x86_64-linux";
        modules = [
          ../modules/home-server-services.nix
          {
            boot.isContainer = true;
            homeServer = {
              mqttNetworkPasswordFile = "/run/home-server-services-test-mqtt-password";
              mqttNetworkUsername = username;
            };
            system.stateVersion = "26.05";
          }
        ];
      };
      assertion = pkgsSystem.lib.findFirst
        (assertion:
          assertion.message == "homeServer.mqttNetworkUsername must be non-empty and contain neither ':' nor newlines"
        )
        (throw "homeServer.mqttNetworkUsername assertion is missing")
        evaluated.config.assertions;
    in assertion.assertion;
  registryFilesGuard = devicesFile:
    let
      evaluated = host.extendModules {
        modules = [
          { services.zigbee2mqtt.settings.devices = pkgsSystem.lib.mkForce devicesFile; }
        ];
      };
      assertion = pkgsSystem.lib.findFirst
        (assertion:
          assertion.message == "zigbee2mqtt must keep devices.yaml and groups.yaml as its device and group files so runtime renames survive restarts"
        )
        (throw "zigbee2mqtt registry file assertion is missing")
        evaluated.config.assertions;
    in assertion.assertion;
in
assert builtins.elem "home-assistant.service" host.config.services.system-auto-deploy.healthUnits;
# The declarative configuration.yaml copy must still run as a pre-start step.
# `toList` because upstream defines ExecStartPre as a bare string and this
# module no longer contributes a list definition to merge it into one.
assert pkgsSystem.lib.any
  (entry: pkgsSystem.lib.hasInfix "configuration.yaml" entry)
  (pkgsSystem.lib.toList host.config.systemd.services.zigbee2mqtt.serviceConfig.ExecStartPre);
# The deployer's real schedule and wiring, asserted against the production
# configuration because the VM node below pushes the timer outside this run's
# window. Without these, that override could quietly mask a regression here.
assert host.config.systemd.timers.system-deploy.timerConfig.OnBootSec == "3min";
assert host.config.systemd.timers.system-deploy.timerConfig.OnUnitActiveSec == "15min";
assert host.config.systemd.timers.system-deploy.wantedBy == [ "timers.target" ];
assert registryFilesGuard "devices.yaml";
assert !(registryFilesGuard "configuration.yaml");
assert host.config.homeServer.zigbeeSerialPort == physicalCoordinator;
assert host.config.homeServer.zigbeeChannel == 25;
assert host.config.homeServer.zigbeePanId == 50324;
assert host.config.homeServer.zigbeeExtendedPanId == [ 52 207 50 36 195 122 154 61 ];
assert !(builtins.hasAttr "deployKeyFile" host.options.homeServer);
assert !(builtins.hasAttr "smarthomeDeployKeyFile" host.options.homeServer);
assert !(builtins.hasAttr "rekey" host.options.age);
assert !(builtins.hasAttr "deploy-ssh-key" host.config.age.secrets);
assert !(builtins.hasAttr "smarthome-deploy-ssh-key" host.config.age.secrets);
assert mqttUsernameAssertion "home-server-tailnet";
assert !(mqttUsernameAssertion "bad:username");
assert !(mqttUsernameAssertion "bad\rusername");
assert !(mqttUsernameAssertion "bad\nusername");
pkgsSystem.testers.runNixOSTest {
  name = "home-server-services";
  skipTypeCheck = true;

  nodes.home-server =
    {
      config,
      lib,
      options,
      ...
    }:
    {
      _module.args.self = { rev = "home-server-services-test"; };

      # The standalone host is the production base; the VM overrides only
      # physical-hardware and production-secret edges below.
      imports = [
        agenix.nixosModules.default
        ../hosts/home-server
      ];

      disabledModules = [ ../hosts/home-server/hardware-configuration.nix ];
      fileSystems."/" = {
        device = "none";
        fsType = "tmpfs";
      };
      boot.loader.systemd-boot.enable = lib.mkForce false;
      boot.loader.efi.canTouchEfiVariables = lib.mkForce false;
      services.smartd.enable = lib.mkForce false;
      services.tailscale.enable = lib.mkForce false;

      # QEMU's USB serial device supplies a real tty.  The rule deliberately
      # gives it the physical coordinator's by-id name, exercising the exact
      # dependency path without requiring the radio in the VM.
      virtualisation.qemu.options = [
        "-device qemu-xhci,id=zigbee-xhci"
        "-chardev null,id=zigbee-radio"
        "-device usb-serial,bus=zigbee-xhci.0,chardev=zigbee-radio,always-plugged=on"
      ];
      services.udev.extraRules = ''
        SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", SYMLINK+="serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0"
      '';

      homeServer = {
        # These defaults are intentional boundaries for this task.
        mqttNetworkPasswordFile = null;
        matrixServerName = null;
        matrixSecretFile = null;
        tellstickAddress = null;
        tellstickTokenFile = null;
        tellstickAdapterPackage = null;
      };
      age.identityPaths = lib.mkForce [ "${zigbeeTestAgenix}/id_ed25519" ];
      age.secrets.zigbee2mqtt-network-key.file =
        lib.mkForce "${zigbeeTestAgenix}/zigbee2mqtt-network-key.age";

      # Keep the real timer loaded and active, but out of this run's window.
      # Production fires at OnBootSec=3min, inside the ~9 minutes this VM takes,
      # and the sandbox has no network for the fetch, so system-deploy exits 1
      # and the no-failed-units assertion below trips on a timing accident.
      # Same override, and the same reason, as nixos/tests/home-server.nix.
      # Transaction behaviour has its own VM in home-server-cd.nix.
      systemd.timers.system-deploy.timerConfig = {
        OnBootSec = lib.mkForce "1h";
        OnUnitActiveSec = lib.mkForce "1h";
      };

      # Same treatment, same reason: this run stops and starts Zigbee2MQTT
      # repeatedly, and a watchdog tick landing in the middle of that would make
      # the cases below depend on timing. Its behaviour is pinned far more
      # thoroughly by checks.zigbee2mqtt-watchdog, which can stub the broker and
      # systemd instead of needing a radio the VM does not have.
      systemd.timers.zigbee2mqtt-watchdog.timerConfig = {
        OnBootSec = lib.mkForce "1h";
        OnUnitActiveSec = lib.mkForce "1h";
      };

      assertions = [
        {
          assertion = !(builtins.hasAttr "buildCoordination" options.services);
          message = "legacy build-coordination option must be removed";
        }
        {
          assertion = !(builtins.hasAttr "nixos-auto-deploy" options.services);
          message = "legacy nixos-auto-deploy option must be removed";
        }
        {
          assertion = !(builtins.hasAttr "smarthome-auto-deploy" options.services);
          message = "legacy smarthome-auto-deploy option must be removed";
        }
        {
          assertion = config.services.zigbee2mqtt.settings.advanced == {
            channel = 25;
            pan_id = 50324;
            ext_pan_id = [ 52 207 50 36 195 122 154 61 ];
          };
          message = "Zigbee coordinator identity must remain pinned exactly";
        }
        {
          assertion = config.services.zigbee2mqtt.settings.serial.adapter == "ember";
          message = "Zigbee coordinator must use the Ember adapter";
        }
        {
          assertion = !config.services.zigbee2mqtt.settings.permit_join;
          message = "Zigbee pairing must remain disabled";
        }
      ];

      environment.systemPackages = [
        pkgsSystem.curl
        pkgsSystem.gnugrep
        pkgsSystem.mosquitto
      ];
      virtualisation = {
        memorySize = 3072;
        diskSize = 4096;
      };
    };

  testScript = ''
    start_all()
    home_server.wait_for_unit("mosquitto.service")
    # HA and Zigbee2MQTT exchange discovery and birth messages on
    # homeassistant/# through the anonymous loopback listener.
    home_server.succeed(
        "(timeout 10 mosquitto_sub -h 127.0.0.1 -t homeassistant/status -C 1 "
        "> /tmp/ha-status &) ; sleep 1; "
        "mosquitto_pub -h 127.0.0.1 -t homeassistant/status -m online"
    )
    home_server.wait_until_succeeds("grep -Fx online /tmp/ha-status", timeout=15)
    home_server.succeed("systemctl show agenix.service -P Result | grep -Fx success")
    home_server.succeed("test -f /run/agenix/zigbee2mqtt-network-key")
    home_server.succeed("test \"$(stat -c '%U:%G %a' /run/agenix/zigbee2mqtt-network-key)\" = 'root:root 400'")
    home_server.succeed(
        "test \"$(cat /run/agenix/zigbee2mqtt-network-key)\" "
        "= '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]'"
    )
    home_server.wait_until_succeeds("test -L '${physicalCoordinator}'", timeout=30)
    home_server.succeed("test -c '${physicalCoordinator}'")

    home_server.succeed("systemctl show zigbee2mqtt.service -P LoadState | grep -Fx loaded")
    # Three different dependency strengths, each load-bearing:
    #   - the broker is a Wants=, because a failed Requires= cancels this
    #     unit's start and leaves it inactive in a state indistinguishable
    #     from a deliberate stop (Result=success either way), which the
    #     watchdog then stands down from;
    #   - the coordinator is a BindsTo=, because only BindsTo= propagates an
    #     *unexpected* inactive transition, which is what an unplug is;
    #   - both are After=, for ordering.
    # Asserting the device under Requires= -- as this did until the unplug half
    # of the replug test below was actually exercised -- pins the wiring that
    # leaves Zigbee2MQTT running against a serial port that no longer exists.
    home_server.succeed(
        "systemctl cat zigbee2mqtt.service | grep '^Wants=' | grep -F mosquitto.service"
    )
    home_server.succeed(
        "systemctl cat zigbee2mqtt.service | grep '^BindsTo=' | "
        "grep -F dev-serial-by | grep -F Itead"
    )
    home_server.succeed(
        "systemctl cat zigbee2mqtt.service | grep '^After=' | "
        "grep -F mosquitto.service | grep -F dev-serial-by | grep -F Itead"
    )
    home_server.wait_until_succeeds(
        "journalctl -u zigbee2mqtt.service --no-pager -o cat | grep -E 'Starting|Started'"
    )
    home_server.wait_until_succeeds(
        "grep -F network_key /var/lib/zigbee2mqtt/configuration.yaml && "
        "grep -F 'channel: 25' /var/lib/zigbee2mqtt/configuration.yaml"
    )
    import re
    configuration = home_server.succeed("cat /var/lib/zigbee2mqtt/configuration.yaml")
    network_key = re.search(
        r"(?m)^\s*network_key:\s*(\[[^]]*\]|(?:\n(?:\s*-\s*\d+\s*)+))",
        configuration,
    )
    assert network_key is not None, configuration
    assert [int(value) for value in re.findall(r"\d+", network_key.group(1))] == [
        7, 1, 255, 0, 42, 9, 100, 3, 200, 17, 66, 5, 250, 13, 77, 1,
    ], network_key.group(0)
    home_server.succeed("systemctl stop zigbee2mqtt.service")
    # The null QEMU radio can make Zigbee2MQTT's SIGTERM path throw "write
    # after end".  This is an expected fixture-only teardown failure, not a
    # production boot failure; clear it before the next independent case.
    home_server.succeed("systemctl reset-failed zigbee2mqtt.service")
    home_server.succeed("systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx inactive")

    home_server.wait_for_unit("postgresql.service")
    store_config = home_server.succeed(
        "systemctl show zigbee2mqtt.service -P ExecStartPre | "
        "grep -o '/nix/store/[^ ;]*\\.yaml' | head -1"
    ).strip()
    assert store_config.startswith("/nix/store/"), store_config
    rendered = home_server.succeed("cat " + store_config)
    assert "channel: 25" in rendered, rendered
    assert "pan_id: 50324" in rendered, rendered
    assert "ext_pan_id:" in rendered, rendered
    assert "- 52" in rendered and "- 61" in rendered, rendered
    assert "adapter: ember" in rendered, rendered
    assert "permit_join: false" in rendered, rendered
    assert "network_key" not in rendered, rendered

    # The wrapper must reject a malformed runtime credential before
    # Zigbee2MQTT can manufacture a replacement network identity.
    home_server.succeed(
        "rm -f /var/lib/zigbee2mqtt/configuration.yaml; "
        "printf '%s\\n' '[1,2,3]' > /run/agenix/zigbee2mqtt-network-key; "
        "systemctl reset-failed zigbee2mqtt.service; "
        "systemctl start zigbee2mqtt.service || true"
    )
    home_server.wait_until_succeeds(
        "journalctl -u zigbee2mqtt.service --no-pager -o cat | "
        "grep -F 'refusing to start: network key'"
    )
    # ExecStartPre copies the declarative YAML before the credential wrapper
    # runs.  Its presence therefore is not a generated network identity.
    home_server.succeed("test -e /var/lib/zigbee2mqtt/configuration.yaml")
    home_server.fail("grep -F network_key /var/lib/zigbee2mqtt/configuration.yaml")
    home_server.fail("grep -F GENERATE /var/lib/zigbee2mqtt/configuration.yaml")
    home_server.succeed("systemctl stop zigbee2mqtt.service")
    home_server.succeed("systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx inactive")

    # With onboarding disabled, invalid persisted configuration must exit and
    # retry instead of parking an interactive recovery page on port 8080.
    home_server.succeed(
        "printf '%s\\n' '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]' "
        "> /run/agenix/zigbee2mqtt-network-key && "
        "printf '{:' > /var/lib/zigbee2mqtt/devices.yaml && "
        "systemctl reset-failed zigbee2mqtt.service; "
        "systemctl start zigbee2mqtt.service"
    )
    home_server.wait_until_succeeds(
        "test \"$(journalctl -u zigbee2mqtt.service --no-pager -o cat | "
        "grep -c 'Refusing to start because configuration is not valid')\" -ge 2"
    )
    home_server.fail("ss -lnt | grep -F ':8080'")
    home_server.succeed("systemctl stop zigbee2mqtt.service; rm /var/lib/zigbee2mqtt/devices.yaml")

    # A broker failure must not be able to cancel this unit's start. Masking
    # mosquitto is how the VM gets a dependency that cannot be satisfied: under
    # Requires= the start job is cancelled and Zigbee2MQTT lands inactive with
    # Result=success, indistinguishable from a deliberate stop, which the
    # watchdog stands down from -- so one mosquitto failure at boot left the
    # radio dead for good. Under Wants= it starts regardless. This fails if the
    # broker is ever moved back to Requires=.
    # A broker that fails, rather than a masked one, which is both closer to
    # the real scenario and the only thing that works here. Masking cannot be
    # used: NixOS puts a store symlink in /etc/systemd/system for every unit,
    # `systemctl mask` refuses to replace it, and a /run/systemd/system
    # symlink to /dev/null is ignored because systemd.unit(5)'s search path
    # ranks /etc/systemd/system *above* /run/systemd/system. Drop-ins behave
    # differently: they merge from every load path rather than the highest one
    # winning, so a /run drop-in does apply.
    home_server.succeed("systemctl stop mosquitto.service")
    home_server.succeed(
        "mkdir -p /run/systemd/system/mosquitto.service.d && "
        "printf '%s\\n' '[Service]' 'ExecStart=' "
        "'ExecStart=/run/current-system/sw/bin/false' 'Restart=no' "
        "> /run/systemd/system/mosquitto.service.d/fail.conf && "
        "systemctl daemon-reload"
    )
    # Preconditions, asserted rather than assumed: the broker has to really be
    # unstartable. If it still came up, Zigbee2MQTT would go active for the
    # wrong reason and this test would pass while proving nothing.
    home_server.fail("systemctl start mosquitto.service")
    home_server.succeed("systemctl show mosquitto.service -P ActiveState | grep -Fx failed")
    home_server.succeed(
        "systemctl reset-failed zigbee2mqtt.service; systemctl start zigbee2mqtt.service"
    )
    home_server.wait_until_succeeds(
        "systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx active", timeout=60
    )
    home_server.succeed(
        "systemctl stop zigbee2mqtt.service; systemctl reset-failed zigbee2mqtt.service"
    )
    home_server.succeed(
        "rm -f /run/systemd/system/mosquitto.service.d/fail.conf && "
        "rmdir /run/systemd/system/mosquitto.service.d && "
        "systemctl daemon-reload && "
        "systemctl reset-failed mosquitto.service"
    )
    home_server.succeed("systemctl start mosquitto.service")
    home_server.wait_for_unit("mosquitto.service")

    # Replugging the coordinator must bring the radio back with no human in the
    # loop, and that is two independent propagations: the unplug has to stop
    # the service, and the re-add has to start it. Both need proving
    # separately. An earlier version of this test asserted "inactive" right
    # after a hand `systemctl stop` further up, so the unplug half was
    # satisfied by that manual stop and was never exercised at all -- the
    # second way this test has managed to pass while proving less than it
    # claimed.
    device_unit = home_server.succeed(
        "systemd-escape -p --suffix=device '${physicalCoordinator}'"
    ).strip()
    home_server.succeed(
        f"test -L '/etc/systemd/system/{device_unit}.wants/zigbee2mqtt.service'"
    )
    tty = home_server.succeed("readlink -f '${physicalCoordinator}'").strip()

    # The unplug half. The VM's coordinator is a null character device, so the
    # real Zigbee2MQTT cannot stay up long enough to watch a dependency-driven
    # stop land. A drop-in replaces ExecStart and nothing else, leaving the
    # unit's own bindsTo/after/wantedBy wiring -- the thing actually under test
    # -- intact, against a process that stays put.
    home_server.succeed(
        "mkdir -p /run/systemd/system/zigbee2mqtt.service.d && "
        "printf '%s\\n' '[Service]' 'ExecStart=' "
        "'ExecStart=/run/current-system/sw/bin/sleep infinity' "
        "> /run/systemd/system/zigbee2mqtt.service.d/stub.conf && "
        "systemctl daemon-reload && "
        "systemctl reset-failed zigbee2mqtt.service && "
        "systemctl start zigbee2mqtt.service"
    )
    home_server.wait_until_succeeds(
        "systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx active",
        timeout=60,
    )

    # "Whatever the cause" includes a *clean* death. Under upstream's
    # Restart=on-failure, systemd.service(5) counts exit code 0 and
    # SIGHUP/SIGINT/SIGTERM/SIGPIPE as clean and does not restart, so a
    # Zigbee2MQTT that exited 0 or took a SIGPIPE sat in "inactive" -- which
    # the watchdog skips as somebody's decision, leaving the radio dead with
    # nothing acting on it. `systemctl kill` signals the process without
    # enqueueing a stop job, so Restart= applies and the unit has to come back
    # on its own. This fails under on-failure.
    home_server.succeed("systemctl kill -s TERM zigbee2mqtt.service")
    home_server.wait_until_succeeds(
        "systemctl show zigbee2mqtt.service -P NRestarts | grep -vFx 0", timeout=90
    )
    home_server.wait_until_succeeds(
        "systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx active",
        timeout=90,
    )

    # Nothing stops the service here except the unplug itself. With Requires=
    # in place of BindsTo= this assertion fails: systemd.unit(5) propagates
    # only an *explicit* stop through Requires=, while BindsTo= "also does so
    # when a listed unit stops unexpectedly", naming an unplugged backing
    # device as exactly that case.
    home_server.succeed(f"udevadm trigger --action=remove {tty}; udevadm settle")
    home_server.wait_until_succeeds(
        f"systemctl show '{device_unit}' -P ActiveState | grep -Fx inactive", timeout=60
    )
    home_server.wait_until_succeeds(
        "systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx inactive",
        timeout=60,
    )
    home_server.succeed(
        "rm -f /run/systemd/system/zigbee2mqtt.service.d/stub.conf && "
        "rmdir /run/systemd/system/zigbee2mqtt.service.d && "
        "systemctl daemon-reload"
    )

    # The re-add half, with the real binary back in place. `wants` are pulled
    # in when a unit *starts*, so re-announcing a device that never left
    # produces no transition and therefore no recovery -- an add-only trigger
    # passes while proving nothing, which is how this test first lied.
    starts_before = int(home_server.succeed(
        "journalctl -u zigbee2mqtt.service --no-pager -o cat | "
        "grep -c 'Starting Zigbee2MQTT version' || true"
    ).strip())
    home_server.succeed(f"udevadm trigger --action=add {tty}; udevadm settle")
    home_server.wait_until_succeeds(
        f"systemctl show '{device_unit}' -P ActiveState | grep -Fx active", timeout=60
    )
    home_server.wait_until_succeeds(
        "test \"$(journalctl -u zigbee2mqtt.service --no-pager -o cat | "
        f"grep -c 'Starting Zigbee2MQTT version')\" -gt {starts_before}",
        timeout=120,
    )
    # Leave it stopped for the composition checks below, as the cases above do.
    home_server.succeed(
        "systemctl stop zigbee2mqtt.service; systemctl reset-failed zigbee2mqtt.service"
    )

    # The watchdog stands down during a deploy by reading ActiveState rather
    # than calling `systemctl is-active`, and that is only correct because of
    # what systemd reports for a running Type=oneshot. Both halves are pinned
    # here against real systemd: that the deploy unit has that shape, and that
    # a unit of that shape reports "activating" -- with is-active failing --
    # for the whole time its ExecStart runs. The hermetic watchdog test has to
    # stub this, and stubbed it as is-active=active until this assertion
    # existed, which let a stand-down that could never fire look tested.
    home_server.succeed("systemctl show system-deploy.service -P Type | grep -Fx oneshot")
    home_server.succeed(
        "systemctl show system-deploy.service -P RemainAfterExit | grep -Fx no"
    )
    # --no-block, because the start job of a oneshot is not done until its
    # process exits: systemd-run would otherwise block for the full sleep and
    # only ever show the settled state.
    # --collect, because stopping a oneshot mid-run leaves Result=exit-code and
    # the unit parked in `failed`, which would trip the no-failed-units
    # assertion that closes this composition.
    home_server.succeed(
        "systemd-run --unit=oneshot-contract --service-type=oneshot --no-block --collect "
        "/run/current-system/sw/bin/sleep 30"
    )
    home_server.wait_until_succeeds(
        "systemctl show oneshot-contract.service -P ActiveState | grep -Fx activating",
        timeout=30,
    )
    home_server.fail("systemctl is-active --quiet oneshot-contract.service")
    home_server.succeed(
        "systemctl stop oneshot-contract.service || true; "
        "systemctl reset-failed oneshot-contract.service || true"
    )
    home_server.fail("systemctl --failed --no-legend --plain | grep -F oneshot-contract")

    # The deploy's baseline excuses a unit that is already down, and the thing
    # that stops that from stranding Zigbee2MQTT is this reverse dependency: a
    # switch starts every active target, so being wanted by multi-user.target is
    # what gets an excused unit a start job. The module above adds the device
    # unit to `wantedBy` for replug recovery, and a device unit is not a target
    # -- if that list ever became only the device unit, the deploy would quietly
    # stop reviving it and the watchdog would skip the result as a deliberate
    # stop. home-server-cd pins the behaviour; this pins the wiring it needs.
    home_server.succeed(
        "systemctl show zigbee2mqtt.service -P WantedBy | grep -F multi-user.target"
    )

    home_server.wait_for_unit("home-assistant.service")
    home_server.wait_until_succeeds(
        "curl -fsS http://127.0.0.1:8123/api/onboarding", timeout=300
    )
    # HA itself must accept the generated configuration, custom component
    # included, or a deploy would ship a config it rejects.
    hass = home_server.succeed(
        "systemctl show home-assistant.service -P ExecStart "
        "| grep -o '/nix/store/[^ ;]*/bin/hass' | head -1"
    ).strip()
    # The unit's Environment carries PYTHONPATH with every component and
    # extra package; outside it hass cannot import them.
    home_server.succeed(
        "cd /var/lib/hass && runuser -u hass -- env "
        "$(systemctl show home-assistant.service -P Environment) "
        f"{hass} --script check_config -c /var/lib/hass"
    )
    home_server.succeed("test -e /var/lib/hass/custom_components/hacs/manifest.json")
    # Every Lovelace resource HA advertises must actually be served, or
    # dashboards using those cards render "custom element doesn't exist".
    resources = home_server.succeed(
        "sed -n '/^  resources:/,/^[^ ]/p' /var/lib/hass/configuration.yaml "
        "| grep -o '/local/[^ ]*'"
    ).split()
    assert resources, "no lovelace resources declared"
    for url in resources:
        home_server.succeed(f"curl -fsS -o /dev/null 'http://127.0.0.1:8123{url}'")

    home_server.fail("systemctl list-unit-files --no-legend | grep -E 'build-coordination|nixos-auto-deploy|smarthome-auto-deploy'")
    home_server.fail("find /etc/ssh -maxdepth 1 -type f -name '*deploy*' -print -quit | grep -q .")
    home_server.succeed("test ! -e /run/agenix/deploy-ssh-key")
    home_server.succeed("test ! -e /run/agenix/smarthome-deploy-ssh-key")
    home_server.fail("find -L /run/agenix -maxdepth 1 -type f -name '*deploy*' -print -quit | grep -q .")
    failed_units = home_server.succeed("systemctl --failed --no-legend")
    assert failed_units.strip() == "", (
        "units failed in this composition; the system-deploy timer is pushed to 1h "
        "above, so this is a real failure and not the deploy timer firing mid-run:\n"
        + failed_units
    )
  '';
}
