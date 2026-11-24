# lighting-port-host: the production wiring of the lighting port, evaluated.
#
# checks.lighting-port runs the unit against a stand-in; this pins how the
# home-server composes it: who it runs as, where the rooms and the token come
# from, that it can reach Home Assistant on loopback, and that the deployer
# does not wait on it. Evaluation only, so it never reads the token's
# ciphertext.
#
#   nix build --no-link -L .#checks.x86_64-linux.lighting-port-host
{
  pkgsSystem,
  host,
}:

let
  inherit (host) config;
  unit = config.systemd.services.lighting-port;
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
# The operator edits the checkout and the env file without sudo.
assert builtins.elem "jonathan" config.users.groups.lighting-port.members;
# Loopback reaches Home Assistant at the port the URL names.
assert unit.environment.HA_URL == "http://127.0.0.1:${toString http.server_port}";
assert builtins.any (address: address == "127.0.0.1" || address == "0.0.0.0") http.server_host;
# Mutable code is not part of a deploy: the deployer never waits on it.
assert !(builtins.any (name: pkgsSystem.lib.hasPrefix "lighting-port" name)
  config.services.system-auto-deploy.healthUnits);
pkgsSystem.runCommand "lighting-port-host-contract" { } "touch $out"
