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
  releaseAppPath = lib.removeSuffix "\n" (builtins.readFile (releaseDir + "/app-path"));

  fakeApp = version: healthy:
    pkgs.writeShellApplication {
      name = "house-automationd";
      runtimeInputs = [ pkgs.coreutils pkgs.python3 ];
      text = ''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --config|--state)
              [ "$#" -ge 2 ] || exit 64
              shift 2
              ;;
            *)
              echo "unexpected argument: $1" >&2
              exit 64
              ;;
          esac
        done

        ${if healthy then ''
          exec python3 -u - <<'PY'
          from http.server import BaseHTTPRequestHandler, HTTPServer

          class ReusableHTTPServer(HTTPServer):
              allow_reuse_address = True

          class Handler(BaseHTTPRequestHandler):
              def do_GET(self):
                  if self.path != "/healthz":
                      self.send_error(404)
                      return
                  body = b'{"ready":true,"version":"${version}"}\n'
                  self.send_response(200)
                  self.send_header("Content-Type", "application/json")
                  self.send_header("Content-Length", str(len(body)))
                  self.end_headers()
                  self.wfile.write(body)

              def log_message(self, format, *args):
                  pass

          ReusableHTTPServer(("127.0.0.1", 9876), Handler).serve_forever()
          PY
        '' else ''
          # Restart succeeds, but the deliberately broken candidate never
          # serves health. This reaches activate-app's deterministic health
          # rollback instead of failing in systemctl restart.
          exec sleep infinity
        ''}
      '';
    };

  fakeAppV1 = fakeApp "v1" true;
  fakeAppV2 = fakeApp "v2" true;
  fakeAppBroken = fakeApp "broken" false;
  selectedApp =
    if releaseAppPath == "@APP_V1@" || releaseAppPath == toString fakeAppV1 then
      fakeAppV1
    else if releaseAppPath == toString fakeAppV2 then
      fakeAppV2
    else if releaseAppPath == toString fakeAppBroken then
      fakeAppBroken
    else
      throw "home-server CD app-path does not name a fixture application";

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
        --trusted-key 'jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8='
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
    appPackage = mkOption {
      type = types.package;
      readOnly = true;
      internal = true;
      description = "Application selected by the tracked CD app-path fixture.";
    };
  };

  config = lib.mkMerge [
    {
      homeServerCd.appPackage = selectedApp;

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
      homeServer = {
        zigbeeSerialPort = mkForce null;
        houseSettings = {
          schema_version = 1;
          mqtt = {
            host = "127.0.0.1";
            port = 1883;
            client_id = "home-server-cd";
          };
          health.bind = "127.0.0.1:9876";
        };
      };
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

      services.app-auto-deploy = {
        testRepository = "file:///var/lib/home-server-cd-origin.git";
        packageAttr =
          "nixosConfigurations.home-server-cd.config.homeServerCd.appPackage";
        hydratorPackage = hydratorSeam;
      };
      services.system-auto-deploy = {
        testRepository = "file:///var/lib/home-server-cd-origin.git";
        hostAttr = "home-server-cd";
        hydratorPackage = hydratorSeam;
      };
      systemd.services.app-deploy.serviceConfig.ReadWritePaths = [
        "/var/lib/home-server-cd"
      ];

      # Prevent wall-clock races; the test invokes both real services itself.
      systemd.timers.app-deploy.timerConfig = {
        OnBootSec = mkForce "1d";
        OnUnitActiveSec = mkForce "1d";
        Persistent = mkForce false;
      };
      systemd.timers.system-deploy.timerConfig = {
        OnBootSec = mkForce "1d";
        OnUnitActiveSec = mkForce "1d";
        Persistent = mkForce false;
      };

      # Seed generation 1 of the stable app profile exactly once. The unit is
      # deliberately invariant across system releases, so later app switches
      # are not overwritten during a NixOS activation.
      systemd.services.home-server-cd-app-profile = {
        description = "Seed the stable app profile for the CD fixture";
        wantedBy = [ "multi-user.target" ];
        before = [ "house-automationd.service" ];
        restartIfChanged = false;
        stopIfChanged = false;
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          if [ ! -e /nix/var/nix/profiles/smarthome ]; then
            ${config.nix.package}/bin/nix-env \
              --profile /nix/var/nix/profiles/smarthome \
              --set ${fakeAppV1}
          fi
        '';
      };
      systemd.services.house-automationd = {
        requires = [ "home-server-cd-app-profile.service" ];
        after = [ "home-server-cd-app-profile.service" ];
      };

      # App packages are both runtime fixtures and evaluator outputs. These
      # references keep all three paths present while guest builders are off.
      environment.etc = {
        "home-server-cd/app-v1-path".text = "${fakeAppV1}\n";
        "home-server-cd/app-v2-path".text = "${fakeAppV2}\n";
        "home-server-cd/app-broken-path".text = "${fakeAppBroken}\n";
        "home-server-cd/system-state".text = "${releaseState}\n";
      };
      system.extraDependencies = [
        fakeAppV1
        fakeAppV2
        fakeAppBroken
        testAgenix
      ];
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
      # Model the pre-cutover active topology: only the two historical timer
      # names are enabled. Keep the standalone unit files defined but inactive
      # to model installed units that systemd has never loaded. Recovery accepts
      # either historical or standalone name per track.
      systemd.timers.app-deploy.wantedBy = mkForce [ ];
      systemd.timers.system-deploy.wantedBy = mkForce [ ];
      systemd.timers.smarthome-deploy = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1d";
          OnUnitActiveSec = "1d";
          Persistent = false;
          Unit = "app-deploy.service";
        };
      };
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
      # Keep both standalone units present, but condition-skip one required
      # timer. switch-to-configuration succeeds; strict candidate health then
      # fails deterministically and exercises exact legacy rollback.
      systemd.timers.system-deploy.unitConfig.ConditionPathExists =
        "/run/home-server-cd-never";
    })
  ];
}
