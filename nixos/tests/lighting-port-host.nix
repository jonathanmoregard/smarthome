# lighting-port-host: the production wiring of the lighting port, evaluated.
#
# checks.lighting-port runs the unit against a stand-in; this pins how the
# home-server composes it: who it runs as, where the rooms and the token come
# from, that it can reach Home Assistant on loopback, and that the deployer
# does not wait on it or on the follower that keeps its checkout at its
# branch. Evaluation only, so it never reads the token's ciphertext.
#
#   nix build --no-link -L .#checks.x86_64-linux.lighting-port-host
{
  pkgsSystem,
  host,
}:

let
  inherit (host) config;
  unit = config.systemd.services.lighting-port;
  follow = config.systemd.services.lighting-port-follow;
  followTimer = config.systemd.timers.lighting-port-follow;
  secret = config.age.secrets.lighting-port-ha-token;
  http = config.services.home-assistant.config.http;
in
assert config.services.lighting-port.enable;
assert unit.serviceConfig.User == "lighting-port";
assert unit.serviceConfig.Group == "lighting-port";
assert unit.serviceConfig.EnvironmentFile == "-/var/lib/lighting-port/env";
assert builtins.elem "multi-user.target" unit.wantedBy;
# The token reaches the port from agenix, owned by the port alone.
assert unit.environment.HA_TOKEN_FILE == secret.path;
assert secret.path == "/run/agenix/lighting-port-ha-token";
assert baseNameOf (toString secret.file) == "lighting-port-ha-token.age";
assert secret.owner == "lighting-port";
assert secret.mode == "0400";
# The operator writes the env file and the catalog without sudo.
assert builtins.elem "jonathan" config.users.groups.lighting-port.members;
# Loopback reaches Home Assistant at the port the URL names.
assert unit.environment.HA_URL == "http://127.0.0.1:${toString http.server_port}";
assert builtins.any (address: address == "127.0.0.1" || address == "0.0.0.0") http.server_host;
# Mutable code is not part of a deploy: the deployer never waits on it.
assert !(builtins.any (name: pkgsSystem.lib.hasPrefix "lighting-port" name)
  config.services.system-auto-deploy.healthUnits);
# The follower runs from its timer alone: nothing a switch starts wants it,
# and a switch that changes it never restarts it, so a switch never waits on
# a fetch.
assert follow.wantedBy == [ ];
assert !follow.restartIfChanged;
assert builtins.elem "timers.target" followTimer.wantedBy;
assert follow.serviceConfig.Type == "oneshot";
# Git in the checkout runs as the user that owns it, never as root.
assert follow.serviceConfig.User == "lighting-port";
pkgsSystem.runCommand "lighting-port-host-contract" { } "touch $out"
