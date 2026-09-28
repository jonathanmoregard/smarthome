{ config, lib, self, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./deployment-identity.nix
    ./zigbee-coordinator.nix
    ../../profiles/home-server-base.nix
    ../../modules/home-server-services.nix
    ../../modules/system-auto-deploy.nix
  ];

  system.configurationRevision = if self ? rev then self.rev else "standalone-home-server";

  # Policy only: devices are discovered at runtime from Zigbee2MQTT.
  homeServer.houseSettings = builtins.fromTOML (builtins.readFile ./house.toml);

  services.app-auto-deploy.enable = true;
  services.system-auto-deploy = {
    enable = true;
    healthUnits = lib.mkAfter (
      lib.optional (config.homeServer.zigbeeSerialPort != null) "zigbee2mqtt.service"
      ++ lib.optional (config.homeServer.houseSettings != null) "house-automationd.service"
    );
  };
}
