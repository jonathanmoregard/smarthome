{
  lib,
  pkgs,
  ...
}:

{
  boot.loader.systemd-boot = {
    enable = true;
    configurationLimit = 8;
  };
  boot.loader.efi.canTouchEfiVariables = true;

  networking = {
    hostName = "home-server";
    networkmanager.enable = false;
    useDHCP = false;
    useNetworkd = true;
    firewall = {
      enable = true;
      interfaces.tailscale0.allowedTCPPorts = [ 22 ];
    };
  };

  systemd.network = {
    enable = true;
    wait-online.anyInterface = true;
    networks."10-wired-dhcp" = {
      matchConfig.Name = [
        "en*"
        "eth*"
      ];
      networkConfig.DHCP = "yes";
      linkConfig.RequiredForOnline = "routable";
    };
  };

  services.resolved.enable = true;
  # NixOS VM tests disable host time sync; real hardware keeps this default.
  services.timesyncd.enable = lib.mkDefault true;

  time.timeZone = "Europe/Stockholm";
  i18n.defaultLocale = "en_US.UTF-8";
  console.keyMap = "sv-latin1";

  services.openssh = {
    enable = true;
    openFirewall = false;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };
  services.tailscale = {
    enable = true;
    # Keep authentication repo-owned by OpenSSH; do not let tailscaled
    # intercept port 22 and shift access policy into external SSH ACL state.
    extraSetFlags = [ "--ssh=false" ];
  };

  users.users.jonathan = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPf3ZLrzmf0pNSTJS603CaNb6in/ctXc0hZSJ9BflOVl jonathan@nixos-vm"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINT9HeHhu82OoNsAHe/QAh116pSEANuZUr1h5m8R8kpp jonathan@dellan"
    ];
  };
  security.sudo.wheelNeedsPassword = true;
  programs.zsh.enable = true;

  services.journald.extraConfig = ''
    Storage=persistent
    SystemMaxUse=512M
    RuntimeMaxUse=64M
    MaxRetentionSec=14day
  '';

  services.smartd = {
    enable = true;
    autodetect = true;
  };

  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    max-jobs = lib.mkForce 0;
    builders = lib.mkForce "";
    fallback = lib.mkForce false;
    min-free = lib.mkForce (1024 * 1024 * 1024);
    max-free = lib.mkForce (5 * 1024 * 1024 * 1024);
    keep-derivations = false;
    keep-outputs = false;
    substituters = lib.mkForce [
      "https://jonathanmoregard.cachix.org"
      "https://cache.nixos.org"
    ];
    trusted-public-keys = lib.mkForce [
      "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8="
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
    ];
  };

  nix.gc = {
    automatic = true;
    dates = "daily";
    options = "--delete-older-than 14d";
  };
  nix.optimise = {
    automatic = true;
    dates = "weekly";
  };

  system.stateVersion = "26.05";
}
