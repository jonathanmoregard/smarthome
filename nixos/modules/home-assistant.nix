{ config, lib, pkgs, ... }:

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
    # `hass --script check_config` needs colorlog; without it HA tries a
    # runtime pip install, which NixOS cannot do.
    extraPackages = ps: [ ps.colorlog ];
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
      # Loopback only: the sole way in is Tailscale Serve below, which
      # terminates TLS. Plain HTTP is never reachable from the tailnet.
      http = {
        server_host = [ "127.0.0.1" "::1" ];
        server_port = 8123;
        use_x_forwarded_for = true;
        trusted_proxies = [ "127.0.0.1" "::1" ];
      };
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

  # HTTPS for the web UI over the tailnet, with a certificate Tailscale issues
  # for `<node>.<tailnet>.ts.net`. Serve listens on tailscale0:443 only; the
  # host firewall opens 443 there and nothing else is added for HA. Needs
  # "HTTPS Certificates" enabled once in the Tailscale admin console.
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 443 ];

  systemd.services.tailscale-serve-home-assistant = lib.mkIf config.services.tailscale.enable {
    description = "Serve Home Assistant over HTTPS on the tailnet";
    wantedBy = [ "multi-user.target" ];
    after = [ "tailscaled.service" "home-assistant.service" ];
    wants = [ "tailscaled.service" ];
    path = [ config.services.tailscale.package ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      # Not yet enrolled, or HTTPS certificates disabled: fail visibly and
      # retry instead of hanging on Tailscale's interactive enable prompt.
      TimeoutStartSec = 90;
      Restart = "on-failure";
      RestartSec = 30;
    };
    script = ''
      for _ in $(seq 1 30); do
        tailscale status --json | grep -q '"BackendState": "Running"' && break
        sleep 2
      done
      tailscale serve --bg --yes --https=443 http://127.0.0.1:8123
    '';
  };
}
