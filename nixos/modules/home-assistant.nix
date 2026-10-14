{ config, lib, pkgs, ... }:

let
  stateDir = "/var/lib/hass";

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
      # Onboarding creates config entries for these; without their Python
      # deps they fail with ModuleNotFoundError (gtts, radios).
      "analytics"
      "google_translate"
      "radio_browser"
      "shopping_list"
      "isal"
    ];
    # `hass --script check_config` needs colorlog; without it HA tries a
    # runtime pip install, which NixOS cannot do.
    extraPackages = ps: [ ps.colorlog ];
    customComponents = [
      pkgs.home-assistant-custom-components.adaptive_lighting
    ];
    # Also switches lovelace.resource_mode to "yaml": resources come from
    # here, not the UI. Dashboards themselves stay UI-managed.
    customLovelaceModules = [ vertical-stack-in-card ];
    config = {
      default_config = { };
      # Name, location, time zone and units stay out of YAML: set there, HA
      # locks them in the UI. Onboarding stores them in HA's own state. The
      # NixOS module defaults time_zone to time.timeZone; null drops it.
      homeassistant.time_zone = null;

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

      # Record of lighting overrides (a block forced in an area, or a lamp
      # changed by hand), keyed "<kind>:<target>" with when/who/via metadata.
      # The UI-managed lighting engine reads it; scripts and automations add
      # and remove records by firing `ls_override` events:
      #   {op: set, records: [{kind, target, value}], via?, who?}
      #   {op: clear, keys: [...]}  |  {op: clear_all}
      # `who` defaults to the user behind the event. Trigger-based so the
      # record survives restarts; only YAML can define one.
      template = [
        {
          triggers = [
            {
              trigger = "event";
              event_type = "ls_override";
            }
          ];
          sensor = [
            {
              name = "ls overrides";
              unique_id = "ls_overrides";
              device_class = "timestamp";
              state = "{{ now().isoformat() }}";
              attributes.overrides = ''
                {%- set prev = this.attributes.get('overrides', {}) if (this is defined and this.attributes is defined) else {} -%}
                {%- set d = trigger.event.data -%}
                {%- set op = d.get('op', 'set') -%}
                {%- set ns = namespace(o=(prev if prev is mapping else {})) -%}
                {%- if op == 'clear_all' -%}
                  {%- set ns.o = {} -%}
                {%- elif op == 'clear' -%}
                  {%- set ns.o = dict(ns.o.items() | rejectattr(0, 'in', d.get('keys', [])) | list) -%}
                {%- elif op == 'set' -%}
                  {%- set who = d.get('who') or trigger.event.context.user_id -%}
                  {%- for r in d.get('records', []) -%}
                    {%- set ns.o = dict(ns.o, **{r.kind ~ ':' ~ r.target: {'kind': r.kind, 'target': r.target, 'value': r.get('value'), 'when': now().isoformat(), 'who': who, 'via': d.get('via')}}) -%}
                  {%- endfor -%}
                {%- endif -%}
                {{ ns.o }}
              '';
            }
          ];
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
}
