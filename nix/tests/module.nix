{
  pkgs,
  module,
  package,
}:

let
  moduleConfigFor = service:
    let
      evaluated = module {
        config.services.houseAutomation = {
          enable = true;
          inherit package;
          settings = { };
          environmentFile = null;
        }
        // service;
        inherit pkgs;
        lib = pkgs.lib;
      };
    in
    evaluated.config.content;
  moduleAssertionsFor = service: (moduleConfigFor service).assertions;
  hasAssertion =
    expected: message: service:
    pkgs.lib.any (
      item: item.message == message && item.assertion == expected
    ) (moduleAssertionsFor service);
  directCredentialPathMessage =
    "services.houseAutomation.settings.mqtt.credentials.environment_file is not allowed; use services.houseAutomation.environmentFile";
  credentialKeysMessage =
    "services.houseAutomation.settings.mqtt.credentials may only set username_variable and password_variable";
  absolutePathMessage =
    "services.houseAutomation.environmentFile must be an absolute runtime path";
  storePathMessage =
    "services.houseAutomation.environmentFile must not point into the Nix store";
  customCredentialVariables = {
    environmentFile = "/run/agenix/house-automation-mqtt";
    settings.mqtt.credentials = {
      username_variable = "HOUSE_MQTT_USERNAME";
      password_variable = "HOUSE_MQTT_PASSWORD";
    };
  };
in
assert hasAssertion false directCredentialPathMessage {
  settings.mqtt.credentials.environment_file = "/run/credentials/house-automation";
};
assert hasAssertion false credentialKeysMessage {
  settings.mqtt.credentials.password = "must-not-enter-the-store";
};
assert hasAssertion false absolutePathMessage {
  environmentFile = "relative/house-automation.env";
};
assert hasAssertion false storePathMessage {
  environmentFile = "${builtins.storeDir}/house-automation.env";
};
assert hasAssertion true directCredentialPathMessage customCredentialVariables;
assert hasAssertion true credentialKeysMessage customCredentialVariables;
assert pkgs.lib.elem package ((moduleConfigFor { }).environment.systemPackages or [ ]);
pkgs.testers.runNixOSTest {
  name = "house-automation-module";

  nodes.server =
    { ... }:
    {
      imports = [ module ];

      services.mosquitto = {
        enable = true;
        listeners = [
          {
            address = "127.0.0.1";
            port = 1883;
            omitPasswordAuth = true;
            settings.allow_anonymous = true;
          }
        ];
      };

      services.houseAutomation = {
        enable = true;
        inherit package;
        environmentFile = "/run/agenix/house-automation-mqtt";
        settings = {
          schema_version = 1;
          mqtt = {
            host = "127.0.0.1";
            port = 1883;
            client_id = "house-automation-module-test";
          };
          health.bind = "127.0.0.1:9876";
          floors = [ { id = "ground-floor"; } ];
          rooms = [
            {
              id = "test-room";
              floor = "ground-floor";
            }
          ];
          curves = [
            {
              id = "test-day";
              anchors = [
                {
                  time = "04:00";
                  brightness = 0.1;
                  color_temperature_kelvin = 2200;
                }
                {
                  time = "16:00";
                  brightness = 0.8;
                  color_temperature_kelvin = 4000;
                }
              ];
            }
          ];
          scopes = [
            {
              id = "test-room-lights";
              kind = "room";
              room = "test-room";
              curve = "test-day";
            }
          ];
          devices = [
            {
              id = "test-lamp";
              friendly_name = "test/lamp";
              room = "test-room";
              capabilities.on_off = true;
            }
          ];
          controls = [
            {
              id = "test-remote";
              friendly_name = "test/remote";
              selected_scope = "test-room-lights";
              mappings = [
                {
                  gesture = "center_single";
                  target = "selected";
                  action.kind = "toggle_power";
                }
              ];
            }
          ];
        };
      };

      systemd.services.house-automation-test-credentials = {
        description = "Create runtime-only MQTT credentials for the module test";
        before = [ "house-automationd.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          install -d -m 0755 /run/agenix
          install -o house-automation -g house-automation -m 0400 /dev/null /run/agenix/house-automation-mqtt
          printf '%s\n' 'MQTT_USERNAME=module-test' 'MQTT_PASSWORD=module-test-password' > /run/agenix/house-automation-mqtt
        '';
      };
      systemd.services.house-automationd = {
        requires = [ "house-automation-test-credentials.service" ];
        after = [ "house-automation-test-credentials.service" ];
      };

      environment.systemPackages = [ pkgs.curl ];
    };

  testScript = ''
    start_all()
    server.wait_for_unit("mosquitto.service")
    server.wait_for_unit("house-automationd.service")
    server.succeed("command -v house-automationd")

    server.succeed("grep -F 'client_id = \"house-automation-module-test\"' /etc/house-automation/config.toml")
    server.succeed("grep -F 'bind = \"127.0.0.1:9876\"' /etc/house-automation/config.toml")
    server.succeed("grep -F 'environment_file = \"/run/agenix/house-automation-mqtt\"' /etc/house-automation/config.toml")
    server.fail("grep -F 'module-test-password' /etc/house-automation/config.toml")
    server.fail("grep -E '(password|secret)[[:space:]]*=' /etc/house-automation/config.toml")
    server.succeed("systemctl cat house-automationd.service | grep -F 'EnvironmentFile=/run/agenix/house-automation-mqtt'")

    server.succeed("test \"$(systemctl show house-automationd.service -P User)\" = house-automation")
    server.succeed("getent passwd house-automation")
    server.succeed("test \"$(systemctl show house-automationd.service -P DynamicUser)\" = no")
    server.succeed("test \"$(systemctl show house-automationd.service -P StateDirectory)\" = house-automation")
    server.succeed("test \"$(systemctl show house-automationd.service -P Restart)\" = on-failure")
    server.succeed("systemctl show house-automationd.service -P After | grep -Fw network-online.target")
    server.succeed("test \"$(systemctl show house-automationd.service -P StartLimitBurst)\" = 5")
    server.succeed("test \"$(systemctl show house-automationd.service -P TimeoutStartUSec)\" = 30s")
    server.succeed("test \"$(systemctl show house-automationd.service -P TimeoutStopUSec)\" = 20s")
    server.succeed("test \"$(systemctl show house-automationd.service -P NoNewPrivileges)\" = yes")
    server.succeed("test \"$(systemctl show house-automationd.service -P ProtectSystem)\" = strict")
    server.succeed("test \"$(systemctl show house-automationd.service -P PrivateTmp)\" = yes")
    server.succeed("test \"$(systemctl show house-automationd.service -P ProtectHome)\" = yes")
    server.succeed("test \"$(systemctl show house-automationd.service -P PrivateDevices)\" = yes")
    server.succeed("systemctl show house-automationd.service -P RestrictAddressFamilies | grep -Fw AF_UNIX")
    server.succeed("systemctl show house-automationd.service -P RestrictAddressFamilies | grep -Fw AF_INET")
    server.succeed("systemctl show house-automationd.service -P RestrictAddressFamilies | grep -Fw AF_INET6")
    server.succeed("test -z \"$(systemctl show house-automationd.service -P CapabilityBoundingSet)\"")
    server.succeed("test -z \"$(systemctl show house-automationd.service -P AmbientCapabilities)\"")
    server.succeed("systemctl show house-automationd.service -P ReadWritePaths | grep -Fx /var/lib/house-automation")
    server.succeed("test -d /var/lib/house-automation")
    server.succeed("test \"$(stat -c %a /var/lib/house-automation)\" = 700")

    server.wait_until_succeeds("curl -sS -o /tmp/health.json -w '%{http_code}' http://127.0.0.1:9876/healthz | grep -Fx 503")
    server.succeed("grep -F '\"database_migrated\":true' /tmp/health.json")
    server.succeed("grep -F '\"mqtt_connected\":true' /tmp/health.json")
    server.succeed("grep -F '\"zigbee2mqtt_bridge_online\":false' /tmp/health.json")
  '';
}
