{
  config,
  lib,
  modulesPath,
  pkgs,
  ...
}:

let
  inherit (lib) mkForce mkIf mkOption types;
  releaseDir = ./home-server-cd-release;
  releaseState = config.homeServerCd.releaseState;

  testAgenix = pkgs.runCommand "home-server-cd-agenix" {
    nativeBuildInputs = [ pkgs.age pkgs.openssh ];
  } ''
    mkdir -p "$out"
    ssh-keygen -q -t ed25519 -N "" -C "home-server CD test identity" \
      -f "$out/id_ed25519"
    recipient=$(cat "$out/id_ed25519.pub")
    printf '%s\n' 'home-server-cd-secret' \
      | age -r "$recipient" -o "$out/home-server-cd-secret.age"
    printf '%s' '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]' \
      | age -r "$recipient" -o "$out/zigbee2mqtt-network-key.age"
  '';

  hydratorSeam = pkgs.writeShellApplication {
    name = "home-server-cd-hydrator";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      expected=(
        --from https://jonathanmoregard.cachix.org
        --trusted-key 'jonathanmoregard.cachix.org-1:dx2ddtW26xQClPgpJYu0ba6B3n/2FGGLw96vpREEw7w='
        --from https://cache.nixos.org
        --trusted-key 'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY='
        --timeout-seconds 300
        --interval 5
        --attempts 3
      )
      arguments=("$@")
      [ "$#" -eq $((''${#expected[@]} + 1)) ] || {
        echo "home-server-cd-hydrator: unexpected argument count" >&2
        exit 64
      }
      index=0
      for expected_argument in "''${expected[@]}"; do
        index=$((index + 1))
        [ "$1" = "$expected_argument" ] || {
          echo "home-server-cd-hydrator: unexpected argument $index" >&2
          exit 64
        }
        shift
      done
      [ "$#" -eq 1 ] || exit 64
      path=$1
      [[ "$path" =~ ^/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || {
        echo "home-server-cd-hydrator: invalid store path" >&2
        exit 64
      }
      [ -e "$path" ] || {
        echo "home-server-cd-hydrator: path is absent from the guest store" >&2
        exit 1
      }
      install -d -m 0700 /var/lib/home-server-cd
      {
        printf 'path=%s' "$path"
        printf '\t%s' "''${arguments[@]}"
        printf '\n'
      } >> /var/lib/home-server-cd/hydrator.log
    '';
  };
in
{
  imports = [
    (modulesPath + "/testing/test-instrumentation.nix")
    (modulesPath + "/virtualisation/qemu-vm.nix")
  ];

  # Module filtering happens before option evaluation, so this must remain a
  # module-level attribute rather than live inside the merged config below.
  disabledModules = [ ../../hosts/home-server/hardware-configuration.nix ];

  options.homeServerCd = {
    releaseState = mkOption {
      type = types.enum [ "legacy" "bad" "v2" ];
      default = lib.removeSuffix "\n" (builtins.readFile (releaseDir + "/system-state"));
      description = "Tracked system release state for the complete CD VM fixture.";
    };
  };

  config = lib.mkMerge [
    {
      # Every promoted generation must retain the VM serial backdoor and use
      # the test disk rather than the physical server's SSD/EFI layout.
      boot.loader.systemd-boot.enable = mkForce false;
      boot.loader.grub.enable = mkForce false;
      boot.loader.efi.canTouchEfiVariables = mkForce false;
      fileSystems."/" = mkForce {
        device = "/dev/disk/by-label/nixos";
        fsType = "ext4";
      };
      services.smartd.enable = mkForce false;

      # QEMU has no coordinator. The agenix declaration stays present so a
      # real activation must preserve its ramfs mount in the host namespace.
      homeServer.zigbeeSerialPort = mkForce null;
      age.identityPaths = mkForce [ "${testAgenix}/id_ed25519" ];
      age.secrets.zigbee2mqtt-network-key.file =
        mkForce "${testAgenix}/zigbee2mqtt-network-key.age";
      age.secrets.home-server-cd-secret = {
        file = "${testAgenix}/home-server-cd-secret.age";
        owner = "root";
        group = "root";
        mode = "0400";
      };

      # Remove source-revision churn from the candidate closure. The tracked
      # release files and timer topology are the only intended system deltas.
      system.configurationRevision = mkForce "home-server-cd";

      services.system-auto-deploy = {
        testRepository = "file:///var/lib/home-server-cd-origin.git";
        hostAttr = "home-server-cd";
        hydratorPackage = hydratorSeam;
      };

      # Prevent wall-clock races; the test invokes the real service itself.
      systemd.timers.system-deploy.timerConfig = {
        OnBootSec = mkForce "1d";
        OnUnitActiveSec = mkForce "1d";
        Persistent = mkForce false;
      };

      environment.etc."home-server-cd/system-state".text = "${releaseState}\n";
      system.extraDependencies = [ testAgenix ];
      environment.systemPackages = with pkgs; [
        curl
        git
        gnugrep
        jq
        util-linux
      ];
      systemd.tmpfiles.rules = [ "d /var/lib/home-server-cd 0700 root root -" ];

      # Append rather than replace: rollback activation must not erase proof
      # that the bad candidate reached the real switch path.
      system.activationScripts.home-server-cd-sentinel.text = ''
        printf '%s\n' ${lib.escapeShellArg releaseState} \
          >> /run/home-server-cd-activation
      '';
    }

    (mkIf (releaseState == "legacy") {
      # Model the pre-cutover active topology: only the historical system
      # timer name is enabled. Keep the standalone unit file defined but
      # inactive to model an installed unit that systemd has never loaded.
      # Recovery accepts either the historical or the standalone name.
      systemd.timers.system-deploy.wantedBy = mkForce [ ];
      systemd.timers.nixos-deploy = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1d";
          OnUnitActiveSec = "1d";
          Persistent = false;
          Unit = "system-deploy.service";
        };
      };
    })

    (mkIf (releaseState == "bad") {
      # Keep the standalone timer unit present, but condition-skip it.
      # switch-to-configuration succeeds; strict candidate health then fails
      # deterministically and exercises exact legacy rollback.
      systemd.timers.system-deploy.unitConfig.ConditionPathExists =
        "/run/home-server-cd-never";
    })
  ];
}
