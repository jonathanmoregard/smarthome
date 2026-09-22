# vm-home-server: complete standalone host, trust, and service-stack contract.
#
# Run after flake wiring:
#   nix build --no-link .#checks.x86_64-linux.vm-home-server -L
{
  pkgsSystem,
  agenix,
}:

let
  physicalCoordinator =
    "/dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0";
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  fakeAutomation = pkgsSystem.writeShellApplication {
    name = "house-automationd";
    runtimeInputs = [ pkgsSystem.python3 ];
    text = ''
      if [ "$#" -ne 4 ] \
        || [ "$1" != --config ] \
        || [ ! -r "$2" ] \
        || [ "$3" != --state ] \
        || [ "$4" != /var/lib/house-automation/state.sqlite3 ]; then
        printf 'unexpected arguments:' >&2
        printf ' %q' "$@" >&2
        printf '\n' >&2
        exit 64
      fi

      exec python3 -u - <<'PY'
      from http.server import BaseHTTPRequestHandler, HTTPServer

      class Handler(BaseHTTPRequestHandler):
          def do_GET(self):
              if self.path != "/healthz":
                  self.send_error(404)
                  return
              body = b'{"ready":true,"fixture":"standalone-home-server"}\n'
              self.send_response(200)
              self.send_header("Content-Type", "application/json")
              self.send_header("Content-Length", str(len(body)))
              self.end_headers()
              self.wfile.write(body)

          def log_message(self, format, *args):
              pass

      HTTPServer(("127.0.0.1", 9876), Handler).serve_forever()
      PY
    '';
  };
  zigbeeTestAgenix = pkgsSystem.runCommand "home-server-vm-zigbee-agenix"
    {
      nativeBuildInputs = [
        pkgsSystem.age
        pkgsSystem.openssh
      ];
    }
    ''
      mkdir -p "$out"
      ssh-keygen -q -t ed25519 -N "" -C "standalone home-server VM identity" \
        -f "$out/id_ed25519"
      recipient="$(cat "$out/id_ed25519.pub")"
      printf '%s' '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]' \
        | age -r "$recipient" -o "$out/zigbee2mqtt-network-key.age"
    '';
  productionHardware = import ../hosts/home-server/hardware-configuration.nix {
    config = { };
    lib = pkgsSystem.lib;
    modulesPath = "${pkgsSystem.path}/nixos/modules";
  };
  productionRoot = productionHardware.fileSystems."/";
  productionHost = import "${pkgsSystem.path}/nixos/lib/eval-config.nix" {
    system = "x86_64-linux";
    specialArgs.self = { rev = "home-server-vm-production-contract"; };
    modules = [
      agenix.nixosModules.default
      ../hosts/home-server
    ];
  };
in
pkgsSystem.testers.runNixOSTest {
  name = "vm-home-server";
  skipTypeCheck = true;

  nodes.home-server =
    {
      config,
      lib,
      options,
      ...
    }:
    {
      _module.args.self = { rev = "home-server-vm-test"; };

      imports = [
        agenix.nixosModules.default
        ../hosts/home-server
      ];

      disabledModules = [ ../hosts/home-server/hardware-configuration.nix ];
      fileSystems."/" = {
        device = "none";
        fsType = "tmpfs";
      };
      boot.loader.systemd-boot.enable = lib.mkForce false;
      boot.loader.efi.canTouchEfiVariables = lib.mkForce false;

      # QEMU has no appliance SMART device. The Zigbee unit remains loaded and
      # fully rendered, but a null serial device is not a useful radio, so its
      # runtime is covered by the focused service VM rather than started here.
      systemd.services.smartd.wantedBy = lib.mkForce [ ];
      systemd.services.zigbee2mqtt.wantedBy = lib.mkForce [ ];

      # Supply the production by-id path with a real character device. This
      # checks that no /dev/ttyUSB* shortcut slips into the host configuration.
      virtualisation.qemu.options = [
        "-device qemu-xhci,id=zigbee-xhci"
        "-chardev null,id=zigbee-radio"
        "-device usb-serial,bus=zigbee-xhci.0,chardev=zigbee-radio,always-plugged=on"
      ];
      services.udev.extraRules = ''
        SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", SYMLINK+="serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0"
      '';

      age.identityPaths = lib.mkForce [ "${zigbeeTestAgenix}/id_ed25519" ];
      age.secrets.zigbee2mqtt-network-key.file =
        lib.mkForce "${zigbeeTestAgenix}/zigbee2mqtt-network-key.age";

      homeServer.houseSettings = {
        schema_version = 1;
        mqtt = {
          host = "127.0.0.1";
          port = 1883;
          client_id = "home-server-vm";
          application_namespace = "house/v1";
          zigbee2mqtt_base_topic = "zigbee2mqtt";
        };
        circadian = {
          daily_reset_time = "04:00";
          unfreeze_convergence_seconds = 30;
        };
        acknowledgement = {
          overlay_id = "circadian-ack";
          amplitude = 0.10;
          duration_ms = 180;
          priority = 100;
        };
        health.bind = "127.0.0.1:9876";
        floors = [ { id = "test-floor"; } ];
        rooms = [
          {
            id = "test-room";
            floor = "test-floor";
          }
        ];
        curves = [
          {
            id = "test-day";
            anchors = [
              {
                time = "04:00";
                brightness = 0.10;
                color_temperature_kelvin = 2200;
              }
              {
                time = "16:00";
                brightness = 0.80;
                color_temperature_kelvin = 4000;
              }
            ];
          }
        ];
        scopes = [
          {
            id = "test-room-lights";
            kind = "room";
            room = "test-room";
            curve = "test-day";
          }
        ];
        devices = [
          {
            id = "test-lamp";
            friendly_name = "test/room/lamp";
            room = "test-room";
            capabilities.on_off = true;
          }
        ];
        controls = [
          {
            id = "test-control";
            friendly_name = "test/room/control";
            selected_scope = "test-room-lights";
            mappings = [
              {
                gesture = "center_single";
                target = "selected";
                action.kind = "toggle_power";
              }
            ];
          }
        ];
      };

      systemd.services.home-server-test-app-profile = {
        description = "Install the VM application fixture into the stable profile";
        before = [ "house-automationd.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          ${config.nix.package}/bin/nix-env \
            --profile /nix/var/nix/profiles/smarthome \
            --set ${fakeAutomation}
        '';
      };
      systemd.services.house-automationd = {
        requires = [ "home-server-test-app-profile.service" ];
        after = [ "home-server-test-app-profile.service" ];
      };

      # Keep both real timers loaded and active while ensuring this composition
      # smoke never reaches external GitHub. Transaction behavior has its own VM.
      systemd.timers.app-deploy.timerConfig = {
        OnBootSec = lib.mkForce "1h";
        OnUnitActiveSec = lib.mkForce "1h";
      };
      systemd.timers.system-deploy.timerConfig = {
        OnBootSec = lib.mkForce "1h";
        OnUnitActiveSec = lib.mkForce "1h";
      };
      services.app-auto-deploy.testRepository =
        "file:///var/empty/home-server-vm-app-origin.git";
      services.system-auto-deploy.testRepository =
        "file:///var/empty/home-server-vm-system-origin.git";

      assertions = [
        {
          assertion = !(builtins.hasAttr "buildCoordination" options.services);
          message = "legacy build coordination must not enter the standalone host";
        }
        {
          assertion = !(builtins.hasAttr "nixos-auto-deploy" options.services);
          message = "legacy nixos-auto-deploy must not enter the standalone host";
        }
        {
          assertion = !(builtins.hasAttr "smarthome-auto-deploy" options.services);
          message = "legacy smarthome-auto-deploy must not enter the standalone host";
        }
      ];

      environment.systemPackages = with pkgsSystem; [
        curl
        gnugrep
        jq
        mosquitto
      ];

      environment.etc."home-server-contract.json".text = builtins.toJSON {
        hostName = config.networking.hostName;
        rootDevice = productionRoot.device;
        rootFsType = productionRoot.fsType;
        sshPasswordAuthentication = config.services.openssh.settings.PasswordAuthentication;
        sshKeyboardInteractiveAuthentication =
          config.services.openssh.settings.KbdInteractiveAuthentication;
        sshRootLogin = config.services.openssh.settings.PermitRootLogin;
        sshAuthorizedKeys = config.users.users.jonathan.openssh.authorizedKeys.keys;
        nixMaxJobs = config.nix.settings.max-jobs;
        nixBuilders = config.nix.settings.builders;
        nixFallback = config.nix.settings.fallback;
        nixKeepDerivations = config.nix.settings.keep-derivations;
        nixKeepOutputs = config.nix.settings.keep-outputs;
        nixExperimentalFeatures = config.nix.settings.experimental-features;
        nixSubstituters = config.nix.settings.substituters;
        nixTrustedPublicKeys = config.nix.settings.trusted-public-keys;
        journalConfig = config.services.journald.extraConfig;
        smartdEnabled = config.services.smartd.enable;
        appRepository = config.services.app-auto-deploy.repository;
        systemRepository = config.services.system-auto-deploy.repository;
        hostRepository = config.homeServer.repository;
        appTestRepository = config.services.app-auto-deploy.testRepository;
        systemTestRepository = config.services.system-auto-deploy.testRepository;
        appDeployProgram = config.systemd.services.app-deploy.serviceConfig.ExecStart;
        systemDeployProgram = config.systemd.services.system-deploy.serviceConfig.ExecStart;
        appRuntimeDirectory = config.systemd.services.app-deploy.serviceConfig.RuntimeDirectory;
        systemRuntimeDirectory = config.systemd.services.system-deploy.serviceConfig.RuntimeDirectory;
        systemRestartIfChanged = config.systemd.services.system-deploy.restartIfChanged;
        appTimerUnit = config.systemd.timers.app-deploy.timerConfig.Unit;
        systemTimerUnit = config.systemd.timers.system-deploy.timerConfig.Unit;
        appTimerPersistent = config.systemd.timers.app-deploy.timerConfig.Persistent;
        systemTimerPersistent = config.systemd.timers.system-deploy.timerConfig.Persistent;
        appTimerOnBoot = config.systemd.timers.app-deploy.timerConfig.OnBootSec;
        systemTimerOnBoot = config.systemd.timers.system-deploy.timerConfig.OnBootSec;
        productionAppTimerOnBoot =
          productionHost.config.systemd.timers.app-deploy.timerConfig.OnBootSec;
        productionSystemTimerOnBoot =
          productionHost.config.systemd.timers.system-deploy.timerConfig.OnBootSec;
        productionAppTimerInterval =
          productionHost.config.systemd.timers.app-deploy.timerConfig.OnUnitActiveSec;
        productionSystemTimerInterval =
          productionHost.config.systemd.timers.system-deploy.timerConfig.OnUnitActiveSec;
        automationExecutable = config.services.houseAutomation.executable;
        automationCondition =
          config.systemd.services.house-automationd.unitConfig.ConditionFileIsExecutable;
        zigbeeEnabled = config.services.zigbee2mqtt.enable;
        zigbeeSerialPort = config.services.zigbee2mqtt.settings.serial.port;
        zigbeeAdapter = config.services.zigbee2mqtt.settings.serial.adapter;
        zigbeeHomeAssistant = config.services.zigbee2mqtt.settings.homeassistant.enabled;
        zigbeePermitJoin = config.services.zigbee2mqtt.settings.permit_join;
        zigbeeSecretFile = config.age.secrets.zigbee2mqtt-network-key.path;
        deploySecretDeclared = builtins.hasAttr "deploy-ssh-key" config.age.secrets;
        appDeploySecretDeclared =
          builtins.hasAttr "smarthome-deploy-ssh-key" config.age.secrets;
      };

      virtualisation = {
        memorySize = 3072;
        cores = 2;
        diskSize = 6144;
      };
    };

  testScript = ''
    import json
    import shlex

    start_all()
    home_server.wait_for_unit("multi-user.target")

    contract = home_server.succeed("cat /etc/home-server-contract.json")
    print("[diag] standalone home-server contract:\n" + contract)
    values = json.loads(contract)

    assert values["hostName"] == "home-server", values
    assert values["rootDevice"] == "/dev/disk/by-label/nixos", values
    assert values["rootFsType"] == "ext4", values
    assert values["sshPasswordAuthentication"] is False, values
    assert values["sshKeyboardInteractiveAuthentication"] is False, values
    assert values["sshRootLogin"] == "no", values
    assert values["sshAuthorizedKeys"] == [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPf3ZLrzmf0pNSTJS603CaNb6in/ctXc0hZSJ9BflOVl jonathan@nixos-vm",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINT9HeHhu82OoNsAHe/QAh116pSEANuZUr1h5m8R8kpp jonathan@dellan",
    ], values

    assert values["nixMaxJobs"] == 0, values
    assert values["nixBuilders"] == "", values
    assert values["nixFallback"] is False, values
    assert values["nixKeepDerivations"] is False, values
    assert values["nixKeepOutputs"] is False, values
    assert values["nixExperimentalFeatures"] == ["nix-command", "flakes"], values
    assert values["nixSubstituters"] == [
        "${projectCache}",
        "${nixosCache}",
    ], values
    assert values["nixTrustedPublicKeys"] == [
        "${projectKey}",
        "${nixosKey}",
    ], values

    assert "Storage=persistent" in values["journalConfig"], values
    assert "SystemMaxUse=512M" in values["journalConfig"], values
    assert "RuntimeMaxUse=64M" in values["journalConfig"], values
    assert "MaxRetentionSec=14day" in values["journalConfig"], values
    assert values["smartdEnabled"] is True, values

    public_repository = "https://github.com/jonathanmoregard/smarthome.git"
    assert values["hostRepository"] == public_repository, values
    assert values["appRepository"] == public_repository, values
    assert values["systemRepository"] == public_repository, values
    assert values["appTestRepository"].startswith("file://"), values
    assert values["systemTestRepository"].startswith("file://"), values
    assert values["appRuntimeDirectory"] == "smarthome-deploy", values
    assert values["systemRuntimeDirectory"] == "smarthome-deploy", values
    assert values["systemRestartIfChanged"] is False, values
    assert values["appTimerUnit"] == "app-deploy.service", values
    assert values["systemTimerUnit"] == "system-deploy.service", values
    assert values["appTimerPersistent"] is True, values
    assert values["systemTimerPersistent"] is True, values
    assert values["appTimerOnBoot"] == "1h", values
    assert values["systemTimerOnBoot"] == "1h", values
    assert values["productionAppTimerOnBoot"] == "2min", values
    assert values["productionSystemTimerOnBoot"] == "3min", values
    assert values["productionAppTimerInterval"] == "15min", values
    assert values["productionSystemTimerInterval"] == "15min", values

    shared_lock = "/run/smarthome-deploy/deploy.lock"
    lock_ready = "/run/smarthome-deploy/lock-holder-ready"
    home_server.succeed("install -d -m 0700 /run/smarthome-deploy")
    home_server.succeed(
        "systemd-run --quiet --collect --unit=home-server-lock-holder.service "
        "--property=Type=exec ${pkgsSystem.util-linux}/bin/flock --exclusive "
        + shlex.quote(shared_lock)
        + " /bin/sh -c "
        + shlex.quote(
            "${pkgsSystem.coreutils}/bin/touch "
            + lock_ready
            + "; exec ${pkgsSystem.coreutils}/bin/sleep 60"
        )
    )
    home_server.wait_until_succeeds("test -e " + shlex.quote(lock_ready))

    for label, program in (
        ("app", values["appDeployProgram"]),
        ("system", values["systemDeployProgram"]),
    ):
        probe_log = "/tmp/" + label + "-deploy-lock-probe.log"
        status = home_server.succeed(
            "set +e; "
            "STATE_DIRECTORY=/tmp/" + label + "-deploy-lock-state "
            "RUNTIME_DIRECTORY=/run/smarthome-deploy "
            "timeout --signal=TERM --kill-after=1s 2s "
            + shlex.quote(program)
            + " >"
            + shlex.quote(probe_log)
            + " 2>&1; printf '%s' \"$?\""
        ).strip()
        assert status == "124", (label, status, home_server.succeed("cat " + probe_log))

    home_server.succeed("test ! -e /var/lib/smarthome-deploy/source/.git")
    home_server.succeed("test ! -e /var/lib/smarthome-system-deploy/source/.git")
    home_server.succeed("systemctl stop home-server-lock-holder.service")

    must_not_build_drv = home_server.succeed(
        "nix-instantiate --expr "
        + shlex.quote(
            'derivation { name = "home-server-must-not-build"; '
            'system = builtins.currentSystem; builder = "/bin/sh"; '
            'args = [ "-c" "mkdir -p $out; '
            'printf local-builder-ran > $out/sentinel" ]; }'
        )
    ).strip()
    must_not_build_output = home_server.succeed(
        "nix-store --query --outputs " + shlex.quote(must_not_build_drv)
    ).strip()
    no_build_log = "/tmp/home-server-must-not-build.log"
    home_server.succeed("test -e " + shlex.quote(must_not_build_drv))
    home_server.succeed("test ! -e " + shlex.quote(must_not_build_output))
    no_build_status = home_server.succeed(
        "set +e; timeout --signal=TERM --kill-after=1s 5s "
        "nix-store --option substituters \"\" --realise "
        + shlex.quote(must_not_build_drv)
        + " >"
        + shlex.quote(no_build_log)
        + " 2>&1; printf '%s' \"$?\""
    ).strip()
    assert no_build_status == "100", (
        no_build_status,
        home_server.succeed("cat " + shlex.quote(no_build_log)),
    )
    home_server.succeed("test ! -e " + shlex.quote(must_not_build_output))
    home_server.succeed(
        "grep -F 'local builds are disabled (max-jobs = 0)' "
        + shlex.quote(no_build_log)
    )

    stable_executable = "/nix/var/nix/profiles/smarthome/bin/house-automationd"
    assert values["automationExecutable"] == stable_executable, values
    assert values["automationCondition"] == stable_executable, values
    assert values["zigbeeEnabled"] is True, values
    assert values["zigbeeSerialPort"] == "${physicalCoordinator}", values
    assert values["zigbeeAdapter"] == "ember", values
    assert values["zigbeeHomeAssistant"] is False, values
    assert values["zigbeePermitJoin"] is False, values
    assert values["zigbeeSecretFile"] == "/run/agenix/zigbee2mqtt-network-key", values
    assert values["deploySecretDeclared"] is False, values
    assert values["appDeploySecretDeclared"] is False, values

    home_server.wait_for_unit("sshd.service")
    home_server.wait_for_unit("tailscaled.service")
    home_server.wait_for_unit("mosquitto.service")
    home_server.wait_for_unit("postgresql.service")
    home_server.wait_for_unit("app-deploy.timer")
    home_server.wait_for_unit("system-deploy.timer")
    home_server.wait_for_unit("house-automationd.service")

    home_server.wait_until_succeeds(
        "curl --fail --silent http://127.0.0.1:9876/healthz "
        "| jq -e '.ready == true and .fixture == \"standalone-home-server\"'",
        timeout=60,
    )
    invalid_argv_status = home_server.succeed(
        "set +e; "
        + shlex.quote(stable_executable)
        + " >/tmp/house-automation-invalid-argv.log 2>&1; "
        "printf '%s' \"$?\""
    ).strip()
    assert invalid_argv_status == "64", (
        invalid_argv_status,
        home_server.succeed("cat /tmp/house-automation-invalid-argv.log"),
    )
    home_server.succeed(
        "test $(readlink -f /nix/var/nix/profiles/smarthome) = ${fakeAutomation}"
    )
    home_server.succeed(
        "systemctl cat house-automationd.service | "
        "grep -F 'ConditionFileIsExecutable=/nix/var/nix/profiles/smarthome/bin/house-automationd'"
    )
    home_server.succeed(
        "systemctl show house-automationd.service -P ExecStart | "
        "grep -F /nix/var/nix/profiles/smarthome/bin/house-automationd"
    )

    home_server.succeed("systemctl show agenix.service -P Result | grep -Fx success")
    home_server.succeed("test -L '${physicalCoordinator}'")
    home_server.succeed("test -c '${physicalCoordinator}'")
    home_server.succeed(
        "test \"$(stat -c '%U:%G %a' /run/agenix/zigbee2mqtt-network-key)\" "
        "= 'root:root 400'"
    )
    home_server.succeed(
        "test \"$(cat /run/agenix/zigbee2mqtt-network-key)\" "
        "= '[7,1,255,0,42,9,100,3,200,17,66,5,250,13,77,1]'"
    )
    home_server.succeed("systemctl show zigbee2mqtt.service -P LoadState | grep -Fx loaded")
    home_server.succeed("systemctl show zigbee2mqtt.service -P ActiveState | grep -Fx inactive")

    store_config = home_server.succeed(
        "systemctl show zigbee2mqtt.service -P ExecStartPre | "
        "grep -o '/nix/store/[^ ;]*[.]yaml' | head -1"
    ).strip()
    rendered = home_server.succeed("cat " + shlex.quote(store_config))
    print("[diag] rendered Zigbee2MQTT configuration:\n" + rendered)
    assert "adapter: ember" in rendered, rendered
    assert "enabled: false" in rendered, rendered
    assert "permit_join: false" in rendered, rendered
    assert "network_key" not in rendered, rendered

    for unit in (
        "nixos-deploy.service",
        "nixos-deploy.timer",
        "smarthome-deploy.service",
        "smarthome-deploy.timer",
    ):
        home_server.fail("systemctl cat " + shlex.quote(unit))
    home_server.succeed("test ! -e /run/agenix/deploy-ssh-key")
    home_server.succeed("test ! -e /run/agenix/smarthome-deploy-ssh-key")
    home_server.fail(
        "find -L /run/agenix -maxdepth 1 -type f -name '*deploy*' -print -quit | grep -q ."
    )

    failed_units = home_server.succeed("systemctl --failed --no-legend")
    print("[diag] failed units:\n" + failed_units)
    assert failed_units.strip() == "", failed_units
  '';
}
