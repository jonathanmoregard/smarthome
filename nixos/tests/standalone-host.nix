{
  pkgsSystem,
  host,
}:
assert host.config.nix.settings.max-jobs == 0;
assert host.config.nix.settings.fallback == false;
assert host.config.nix.settings.builders == "";
assert host.config.nix.settings.keep-derivations == false;
assert host.config.nix.settings.keep-outputs == false;
assert host.config.services.tailscale.extraSetFlags == [ "--ssh=false" ];
pkgsSystem.runCommand "standalone-host-contract" { } "touch $out"
