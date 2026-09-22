{ self, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./deployment-identity.nix
    ./zigbee-coordinator.nix
    ../../profiles/home-server-base.nix
    ../../modules/home-server-services.nix
  ];

  system.configurationRevision = if self ? rev then self.rev else "standalone-home-server";

  services.app-auto-deploy.enable = true;
}
