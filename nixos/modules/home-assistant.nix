{ config, lib, pkgs, ... }:

let
  stateDir = "/var/lib/hass";

  # Household phones reach Home Assistant over the wired LAN on plain HTTP
  # when this names an interface, so an unreachable tailnet no longer means an
  # unreachable house. Tailscale Serve keeps carrying TLS from outside.
  lanInterface = config.homeServer.homeAssistantLanInterface;
  lanEnabled = lanInterface != null;

  # Wraps a group of cards in one framed card; the lighting-schedule
  # dashboard uses it to box each room. Not in nixpkgs; the release is a
  # single plain JS file, so there is nothing to build.
  vertical-stack-in-card = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "vertical-stack-in-card";
    version = "1.1.4";
    src = pkgs.fetchFromGitHub {
      owner = "ofekashery";
      repo = "vertical-stack-in-card";
      rev = "v${version}";
      hash = "sha256-aLekmPUo6dxt1+abMsvn/m8hE7+epconkQ4z8x+Ayjk=";
    };
    installPhase = ''
      install -Dm644 vertical-stack-in-card.js $out/vertical-stack-in-card.js
    '';
  };

  # HACS, so custom integrations are installed at runtime from the HA UI
  # instead of being packaged here. Not in nixpkgs; the release zip is the
  # integration directory itself. HACS cannot update itself (store path);
  # bump the version here.
  hacs = pkgs.buildHomeAssistantComponent rec {
    owner = "hacs";
    domain = "hacs";
    version = "2.0.5";
    src = pkgs.fetchzip {
      url = "https://github.com/hacs/integration/releases/download/${version}/hacs.zip";
      stripRoot = false;
      hash = "sha256-iMomioxH7Iydy+bzJDbZxt6BX31UkCvqhXrxYFQV8Gw=";
    };
    dependencies = [ pkgs.home-assistant.python3Packages.aiogithubapi ];
  };
in
{
  # Declared beside its only consumer, below. The option lives in the shared
  # `homeServer` namespace, but nothing outside this file reads it, and a
  # module that declared it elsewhere would leave this one failing on an
  # option that does not exist whenever it is imported on its own.
  options.homeServer.homeAssistantLanInterface = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    example = "enp1s0";
    description = ''
      Wired LAN interface on which Home Assistant's plain-HTTP port is
      reachable, so household phones keep working when Tailscale does not.
      Null keeps Home Assistant loopback-only, reachable solely through
      Tailscale Serve. Never name `tailscale0` here: the tailnet is served
      over TLS by Tailscale Serve, and opening plain HTTP there would undo
      that.
    '';
  };

  config = {
    services.home-assistant = {
      enable = true;
      configDir = stateDir;
      extraComponents = [
        "default_config"
        "met"
        "mqtt"
        "mobile_app"
        "backup"
        # Onboarding creates config entries for these; without their Python
        # deps they fail with ModuleNotFoundError (gtts, radios).
        "analytics"
        "google_translate"
        "radio_browser"
        "shopping_list"
        "isal"
      ];
      # `hass --script check_config` needs colorlog; without it HA tries a
      # runtime pip install, which NixOS cannot do. The same holds for
      # integrations installed through HACS: their Python requirements must
      # be listed here.
      extraPackages = ps: [
        ps.colorlog
        # Variables+History (variable): runtime store for lighting overrides.
        ps.iso4217
      ];
      customComponents = [
        hacs
      ];
      # Also switches lovelace.resource_mode to "yaml": resources come from
      # here, not the UI. Dashboards themselves stay UI-managed.
      customLovelaceModules = [
        vertical-stack-in-card
        pkgs.home-assistant-custom-lovelace-modules.mushroom
        # Builds the per-room dashboard rows from the rooms that exist, so a
        # new room needs no dashboard edit.
        pkgs.home-assistant-custom-lovelace-modules.auto-entities
        # Pop-ups (the per-lamp lists on /lighting-schedule).
        pkgs.home-assistant-custom-lovelace-modules.bubble-card
      ];
      config = {
        default_config = { };
        # Name, location, time zone and units stay out of YAML: set there, HA
        # locks them in the UI. Onboarding stores them in HA's own state. The
        # NixOS module defaults time_zone to time.timeZone; null drops it.
        homeassistant.time_zone = null;

        # Without a LAN interface this is loopback only, and the sole way in is
        # Tailscale Serve below, which terminates TLS.
        #
        # With one, only the IPv4 wildcard widens; IPv6 stays on loopback. A
        # per-interface firewall rule does not restrict the source address, and
        # IPv6 has no NAT to fall back on, so a router that ever delegates a
        # routable prefix would otherwise put plain 8123 on the Internet and
        # leave "not exposed" resting on that router's inbound filter. Not
        # binding a routable IPv6 address keeps that true by construction.
        # IPv4 reaches the LAN alone via the firewall rule below, behind NAT.
        # Binding the wildcard rather than the lease keeps a DHCP renewal from
        # breaking startup. `trusted_proxies` stays loopback-only: LAN clients
        # connect directly, so no LAN address may forge an X-Forwarded-For.
        http = {
          server_host =
            if lanEnabled then [ "0.0.0.0" "::1" ] else [ "127.0.0.1" "::1" ];
          server_port = 8123;
          use_x_forwarded_for = true;
          trusted_proxies = [ "127.0.0.1" "::1" ];
        };
        # UI-managed files next to the declarative configuration.
        "automation ui" = "!include automations.yaml";
        "scene ui" = "!include scenes.yaml";
        "script ui" = "!include scripts.yaml";
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
    # for `<node>.<tailnet>.ts.net`. Serve listens on tailscale0:443 only. Port
    # 8123 is opened on the wired LAN alone, so plain HTTP never reaches the
    # tailnet. Needs "HTTPS Certificates" enabled once in the Tailscale admin
    # console.
    networking.firewall.interfaces = lib.mkMerge [
      { tailscale0.allowedTCPPorts = [ 443 ]; }
      (lib.mkIf lanEnabled { ${lanInterface}.allowedTCPPorts = [ 8123 ]; })
    ];

    assertions = [
      {
        assertion = !lanEnabled || lanInterface != "tailscale0";
        message =
          "homeServer.homeAssistantLanInterface must name a wired LAN interface;"
          + " tailscale0 is served over TLS by Tailscale Serve.";
      }
      {
        # A trusted interface takes a blanket accept ahead of any per-port rule,
        # so trusting tailscale0 would publish plain 8123 on the tailnet now
        # that Home Assistant binds the IPv4 wildcard. The common NixOS snippet
        # that adds it is exactly how this would happen by accident.
        assertion =
          !lanEnabled
          || !(builtins.elem "tailscale0" config.networking.firewall.trustedInterfaces);
        message =
          "networking.firewall.trustedInterfaces must not contain tailscale0 while"
          + " homeServer.homeAssistantLanInterface is set: a blanket accept there"
          + " would expose Home Assistant's plain-HTTP port on the tailnet, which"
          + " Tailscale Serve already carries over TLS on 443.";
      }
    ];

    systemd.services.tailscale-serve-home-assistant = lib.mkIf config.services.tailscale.enable {
      description = "Serve Home Assistant over HTTPS on the tailnet";
      wantedBy = [ "multi-user.target" ];
      after = [ "tailscaled.service" "home-assistant.service" ];
      wants = [ "tailscaled.service" ];
      path = [ config.services.tailscale.package ];
      # Type=simple retrying in the script, never Restart=on-failure: a node
      # that is not enrolled yet, or has HTTPS certificates disabled, must not
      # leave a failed or restarting unit behind, because switch-to-configuration
      # would count that as a failed deploy and roll back.
      serviceConfig = {
        Type = "simple";
        RemainAfterExit = true;
      };
      script = ''
        until tailscale status --json | grep -q '"BackendState": "Running"' \
          && timeout 30 tailscale serve --bg --yes --https=443 http://127.0.0.1:8123; do
          echo "tailscale serve not ready (node not enrolled or HTTPS certificates disabled?); retrying in 30s" >&2
          sleep 30
        done
      '';
    };
  };
}
