{ config, lib, self, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./deployment-identity.nix
    ./zigbee-coordinator.nix
    ../../profiles/home-server-base.nix
    ../../modules/home-server-services.nix
    ../../modules/home-assistant.nix
    ../../modules/lighting-port.nix
    ../../modules/system-auto-deploy.nix
  ];

  system.configurationRevision = if self ? rev then self.rev else "standalone-home-server";

  # The Wyse 5070's only wired NIC. Household phones reach Home Assistant here
  # over plain HTTP, so the house stays usable when Tailscale is not.
  homeServer.homeAssistantLanInterface = "enp1s0";

  # The lighting port runs here from its own mutable checkout; see
  # docs/home-server/lighting-port.md. Not a health unit below, by design.
  services.lighting-port = {
    enable = true;
    haTokenFile = config.age.secrets.lighting-port-ha-token.path;
    operators = [ "jonathan" ];
  };

  age.secrets.lighting-port-ha-token = {
    file = ../../secrets/lighting-port-ha-token.age;
    owner = "lighting-port";
    group = "lighting-port";
    mode = "0400";
  };

  services.system-auto-deploy = {
    enable = true;
    healthUnits = lib.mkAfter (
      lib.optional (config.homeServer.zigbeeSerialPort != null) "zigbee2mqtt.service"
      ++ [ "home-assistant.service" ]
    );
  };
}
