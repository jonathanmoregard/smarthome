{
  pkgsSystem,
  host,
}:
assert host.config.networking.hostName == "home-server";
assert host.config.nix.settings.max-jobs == 0;
assert host.config.nix.settings.fallback == false;
assert host.config.nix.settings.builders == "";
assert host.config.nix.settings.keep-derivations == false;
assert host.config.nix.settings.keep-outputs == false;
assert host.config.services.openssh.enable;
assert host.config.services.tailscale.enable;
assert host.config.system.stateVersion == "26.05";
pkgsSystem.runCommand "standalone-host-contract" { } "touch $out"
