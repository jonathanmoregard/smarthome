{
  agenix,
  pkgsSystem,
  host,
}:

let
  physicalCoordinator =
    "/dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0";
  fakeAutomation = pkgsSystem.writeShellApplication {
    name = "house-automationd";
    runtimeInputs = [ pkgsSystem.coreutils ];
    text = ''
      exec sleep infinity
    '';
  };
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
in
assert host.config.homeServer.houseSettings == null;
assert host.config.homeServer.zigbeeSerialPort == physicalCoordinator;
assert host.config.homeServer.zigbeeChannel == 25;
assert host.config.homeServer.zigbeePanId == 50324;
assert host.config.homeServer.zigbeeExtendedPanId == [ 52 207 50 36 195 122 154 61 ];
assert host.config.age.secrets.zigbee2mqtt-network-key.file == ../secrets/zigbee2mqtt-network-key.age;
assert host.config.age.secrets.zigbee2mqtt-network-key.owner == "root";
assert host.config.age.secrets.zigbee2mqtt-network-key.group == "root";
assert host.config.age.secrets.zigbee2mqtt-network-key.mode == "0400";
assert !(builtins.hasAttr "deployKeyFile" host.options.homeServer);
assert !(builtins.hasAttr "smarthomeDeployKeyFile" host.options.homeServer);
assert !(builtins.hasAttr "rekey" host.options.age);
assert !(builtins.hasAttr "deploy-ssh-key" host.config.age.secrets);
assert !(builtins.hasAttr "smarthome-deploy-ssh-key" host.config.age.secrets);
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
        houseSettings = {
          schema_version = 1;
          mqtt = {
            host = "127.0.0.1";
            port = 1883;
            client_id = "home-server-services-test";
          };
          floors = [ { id = "test-floor"; } ];
          rooms = [
            {
              id = "test-room";
              floor = "test-floor";
            }
          ];
        };
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
      services.houseAutomation.executable = "${fakeAutomation}/bin/house-automationd";

      systemd.services.zigbee2mqtt = {
        wantedBy = lib.mkForce [ ];
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
          assertion = !config.services.zigbee2mqtt.settings.homeassistant.enabled;
          message = "Home Assistant integration must remain disabled";
        }
        {
          assertion = !config.services.zigbee2mqtt.settings.permit_join;
          message = "Zigbee pairing must remain disabled";
        }
        {
          assertion = config.services.postgresql.enable && !config.services.matrix-synapse.enable;
          message = "PostgreSQL remains active while Matrix is disabled by default";
        }
      ];

      environment.systemPackages = [ pkgsSystem.gnugrep ];
      virtualisation = {
        memorySize = 2048;
        diskSize = 4096;
      };
    };

  testScript = ''
    start_all()
    home_server.wait_for_unit("mosquitto.service")
    home_server.wait_for_unit("postgresql.service")
    home_server.wait_for_unit("house-automationd.service")
    home_server.succeed("systemctl show agenix.service -P Result | grep -Fx success")
    home_server.succeed("test -f /run/agenix/zigbee2mqtt-network-key")
    home_server.succeed("test \"$(stat -c '%U:%G %a' /run/agenix/zigbee2mqtt-network-key)\" = 'root:root 400'")
    home_server.succeed(
        "test \"$(cat /run/agenix/zigbee2mqtt-network-key)\" "
        "= '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]'"
    )
    home_server.succeed("test -L '${physicalCoordinator}'")
    home_server.succeed("test -c '${physicalCoordinator}'")
    home_server.succeed("test -d /var/lib/house-automation")

    home_server.succeed("systemctl show zigbee2mqtt.service -P LoadState | grep -Fx loaded")
    home_server.succeed(
        "systemctl cat zigbee2mqtt.service | "
        "grep -F 'LoadCredential=network-key:/run/agenix/zigbee2mqtt-network-key'"
    )
    home_server.succeed(
        "systemctl cat zigbee2mqtt.service | grep '^Requires=' | "
        "grep -F mosquitto.service | grep -F dev-serial-by | grep -F Itead"
    )

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
    assert "enabled: false" in rendered, rendered
    assert "permit_join: false" in rendered, rendered
    assert "network_key" not in rendered, rendered

    home_server.succeed("systemctl start zigbee2mqtt.service")
    home_server.wait_until_succeeds(
        "grep -F network_key /var/lib/zigbee2mqtt/configuration.yaml"
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
    home_server.succeed("grep -F 'pan_id: 50324' /var/lib/zigbee2mqtt/configuration.yaml")
    home_server.fail("grep -F GENERATE /var/lib/zigbee2mqtt/configuration.yaml")
    home_server.succeed("systemctl stop zigbee2mqtt.service || true")

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

    home_server.fail("systemctl list-unit-files --no-legend | grep -E 'build-coordination|nixos-auto-deploy|smarthome-auto-deploy'")
    home_server.fail("find /etc/ssh -maxdepth 1 -type f -name '*deploy*' -print -quit | grep -q .")
    home_server.succeed("test ! -e /run/agenix/deploy-ssh-key")
    home_server.succeed("test ! -e /run/agenix/smarthome-deploy-ssh-key")
    home_server.fail("find /run/agenix -maxdepth 1 -type f -name '*deploy*' -print -quit | grep -q .")
    home_server.succeed("test -z \"$(systemctl --failed --no-legend)\"")
  '';
}
