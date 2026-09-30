{ pkgs, ... }:

let
  stateDir = "/var/lib/hass";
  sleepSwitch = "switch.adaptive_lighting_sleep_mode_house";
in
{
  services.home-assistant = {
    enable = true;
    configDir = stateDir;
    extraComponents = [
      "default_config"
      "met"
      "mqtt"
      "mobile_app"
      "backup"
    ];
    customComponents = [
      pkgs.home-assistant-custom-components.adaptive_lighting
    ];
    config = {
      default_config = { };
      homeassistant = {
        name = "Home";
        # Approximate coordinates are enough for sun-based automations.
        latitude = 59.3;
        longitude = 18.1;
        time_zone = "Europe/Stockholm";
        unit_system = "metric";
      };
      http.server_port = 8123;
      # UI-managed files next to the declarative configuration.
      "automation ui" = "!include automations.yaml";
      "scene ui" = "!include scenes.yaml";
      "script ui" = "!include scripts.yaml";
      # The Adaptive Lighting switch is created in the UI
      # (docs/home-server/home-assistant.md); these do nothing until it exists.
      "automation nix" = [
        {
          id = "house_sleep_mode_on";
          alias = "House sleep mode on";
          triggers = [ { trigger = "time"; at = "23:00:00"; } ];
          actions = [ { action = "switch.turn_on"; target.entity_id = sleepSwitch; } ];
        }
        {
          id = "house_sleep_mode_off";
          alias = "House sleep mode off";
          triggers = [ { trigger = "time"; at = "06:40:00"; } ];
          actions = [ { action = "switch.turn_off"; target.entity_id = sleepSwitch; } ];
        }
      ];
    };
  };

  # Create the UI-owned include files once; tmpfiles `f` never truncates.
  systemd.tmpfiles.rules =
    map (file: "f ${stateDir}/${file} 0644 hass hass - []")
      [
        "automations.yaml"
        "scenes.yaml"
        "scripts.yaml"
      ];

  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 8123 ];
}
