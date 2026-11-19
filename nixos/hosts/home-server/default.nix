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

  # The Wyse 5070's only wired NIC. Household phones reach Home Assistant here
  # over plain HTTP, so the house stays usable when Tailscale is not.
  homeServer.homeAssistantLanInterface = "enp1s0";

  services.system-auto-deploy = {
    enable = true;
    healthUnits = lib.mkAfter (
      lib.optional (config.homeServer.zigbeeSerialPort != null) "zigbee2mqtt.service"
      ++ [ "home-assistant.service" ]
    );
  };
}
