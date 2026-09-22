{ self, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./deployment-identity.nix
    ../../profiles/home-server-base.nix
  ];

  system.configurationRevision = if self ? rev then self.rev else "standalone-home-server";
}
