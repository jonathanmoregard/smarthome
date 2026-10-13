{ config, lib, self, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./deployment-identity.nix
    ./zigbee-coordinator.nix
    ../../profiles/home-server-base.nix
    ../../modules/home-server-services.nix
    ../../modules/home-assistant.nix
    ../../modules/system-auto-deploy.nix
  ];

  system.configurationRevision = if self ? rev then self.rev else "standalone-home-server";

  # Adaptive Lighting in Home Assistant is the production lighting controller.
  # Keep house.toml only as a checked reference for the former daemon policy.
  homeServer.houseSettings = null;

  services.app-auto-deploy.enable = true;
  services.system-auto-deploy = {
    enable = true;
    # house-automationd is deliberately absent because Adaptive Lighting owns
    # the production schedule.
    healthUnits = lib.mkAfter (
      lib.optional (config.homeServer.zigbeeSerialPort != null) "zigbee2mqtt.service"
      ++ [ "home-assistant.service" ]
    );
  };
}
