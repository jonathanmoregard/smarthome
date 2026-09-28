{ lib, ... }:

{
  options.homeServer = {
    ageHostPublicKey = lib.mkOption {
      type = lib.types.str;
      description = "SSH public key used to encrypt this host's secrets.";
    };
    repository = lib.mkOption {
      type = lib.types.str;
      description = "Source repository for the home-server deployment.";
    };
  };

  config = {
    homeServer = {
      ageHostPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+ root@home-server";
      repository = "https://github.com/jonathanmoregard/smarthome.git";
    };
  };
}
