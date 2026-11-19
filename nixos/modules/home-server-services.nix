{
  config,
  lib,
  pkgs,
  utils,
  ...
}:

let
  inherit (lib) hasPrefix mkIf mkMerge mkOption optional types;
  cfg = config.homeServer;
  zigbeeEnabled = cfg.zigbeeSerialPort != null;
  mqttNetworkEnabled = cfg.mqttNetworkPasswordFile != null;
  matrixEnabled = cfg.matrixServerName != null && cfg.matrixSecretFile != null;
  tellstickConfigured =
    cfg.tellstickAddress != null
    && cfg.tellstickTokenFile != null
    && cfg.tellstickAdapterPackage != null;
  isRuntimePath = value:
    value == null
    || (
      hasPrefix "/" value
      && value != builtins.storeDir
      && !hasPrefix "${builtins.storeDir}/" value
    );
  zigbeeDeviceUnit =
    if zigbeeEnabled then "${utils.escapeSystemdPath cfg.zigbeeSerialPort}.device" else null;
  # systemd can only see that the process exists; the bridge's own availability
  # topic is the only thing that knows whether the radio actually works. See the
  # script's header for why it acts as rarely as it does.
  zigbee2mqttWatchdog = pkgs.writeShellApplication {
    name = "zigbee2mqtt-watchdog";
    runtimeInputs = [ pkgs.bash pkgs.coreutils pkgs.mosquitto pkgs.systemd ];
    text = ''
      exec bash ${./zigbee2mqtt-watchdog.sh} "$@"
    '';
  };
  zigbee2mqttWithNetworkKey = pkgs.writeShellApplication {
    name = "zigbee2mqtt-with-network-key";
    text = ''
      key=$(< "$CREDENTIALS_DIRECTORY/network-key")
      byte='(0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])'
      if [[ ! "$key" =~ ^\[$byte(,$byte){15}\]$ ]]; then
        echo "zigbee2mqtt: refusing to start: network key must be a compact JSON array of 16 bytes" >&2
        exit 1
      fi
      export ZIGBEE2MQTT_CONFIG_ADVANCED_NETWORK_KEY="$key"
      exec ${lib.getExe' config.services.zigbee2mqtt.package "zigbee2mqtt"}
    '';
  };
in
{
  imports = [ ];

  options.homeServer = {
    zigbeeSerialPort = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Stable /dev/serial/by-id path for the Zigbee coordinator.";
    };
    zigbeeChannel = mkOption {
      type = types.ints.between 11 26;
      default = 11;
      description = "Pinned Zigbee radio channel.";
    };
    zigbeePanId = mkOption {
      type = types.nullOr (types.ints.between 1 65534);
      default = null;
      description = "Pinned Zigbee PAN ID.";
    };
    zigbeeExtendedPanId = mkOption {
      type = types.nullOr (types.listOf types.ints.u8);
      default = null;
      description = "Pinned eight-byte Zigbee extended PAN ID.";
    };
    zigbeeNetworkKeyFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Absolute runtime path to the compact Zigbee network-key array.";
    };
    zigbeeFrontendTailnet = mkOption {
      type = types.bool;
      default = false;
      description = "Expose the Zigbee2MQTT frontend on Tailscale.";
    };
    mqttNetworkUsername = mkOption {
      type = types.str;
      default = "home-server-tailnet";
      description = "Username for the optional authenticated Tailscale MQTT listener.";
    };
    mqttNetworkPasswordFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Runtime password file enabling the optional network MQTT listener.";
    };
    mqttNetworkAcl = mkOption {
      type = types.listOf types.str;
      default = [ "readwrite house/v1/#" ];
      description = "ACL for the optional network MQTT user.";
    };
    mqttNetworkPort = mkOption {
      type = types.port;
      default = 1884;
      description = "Optional network MQTT port.";
    };
    tellstickAddress = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Verified local TellStick bridge URL.";
    };
    tellstickTokenFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Runtime path to the TellStick token.";
    };
    tellstickAdapterPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "Package providing bin/tellstick-mqtt-bridge.";
    };
    matrixServerName = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Permanent Synapse server name; null keeps Matrix disabled.";
    };
    matrixSecretFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Runtime Synapse YAML secret fragment; null keeps Matrix disabled.";
    };
    matrixTailnet = mkOption {
      type = types.bool;
      default = false;
      description = "Expose the Synapse client listener on Tailscale.";
    };
    adminHashedPasswordFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Optional runtime path containing Jonathan's hashed password.";
    };
    cloudApiEnvironmentFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Reserved runtime EnvironmentFile slot for a future cloud API consumer.";
    };
  };

  config = mkMerge [
    {
      assertions = [
        {
          assertion = cfg.zigbeeSerialPort == null || hasPrefix "/dev/serial/by-id/" cfg.zigbeeSerialPort;
          message = "homeServer.zigbeeSerialPort must use a stable /dev/serial/by-id/ path";
        }
        {
          assertion = !cfg.zigbeeFrontendTailnet || zigbeeEnabled;
          message = "homeServer.zigbeeFrontendTailnet requires homeServer.zigbeeSerialPort";
        }
        {
          assertion = !zigbeeEnabled || (cfg.zigbeePanId != null && cfg.zigbeeExtendedPanId != null && cfg.zigbeeNetworkKeyFile != null);
          message = "homeServer.zigbeeSerialPort requires a pinned PAN, extended PAN, and runtime network key";
        }
        {
          assertion = cfg.zigbeeExtendedPanId == null || builtins.length cfg.zigbeeExtendedPanId == 8;
          message = "homeServer.zigbeeExtendedPanId must contain exactly 8 bytes";
        }
        {
          assertion = isRuntimePath cfg.zigbeeNetworkKeyFile;
          message = "homeServer.zigbeeNetworkKeyFile must be an absolute runtime path outside the Nix store";
        }
        {
          assertion = isRuntimePath cfg.mqttNetworkPasswordFile;
          message = "homeServer.mqttNetworkPasswordFile must be an absolute runtime path outside the Nix store";
        }
        {
          assertion = !mqttNetworkEnabled || builtins.match "[^:\r\n]+" cfg.mqttNetworkUsername != null;
          message = "homeServer.mqttNetworkUsername must be non-empty and contain neither ':' nor newlines";
        }
        {
          assertion = !mqttNetworkEnabled || cfg.mqttNetworkAcl != [ ];
          message = "homeServer.mqttNetworkAcl must not be empty when defining the network listener";
        }
        {
          assertion = (cfg.tellstickAddress == null && cfg.tellstickTokenFile == null && cfg.tellstickAdapterPackage == null) || tellstickConfigured;
          message = "homeServer TellStick address, token file, and adapter package must be supplied together";
        }
        {
          assertion = isRuntimePath cfg.tellstickTokenFile;
          message = "homeServer.tellstickTokenFile must be an absolute runtime path outside the Nix store";
        }
        {
          assertion = tellstickConfigured -> (hasPrefix "http://" cfg.tellstickAddress || hasPrefix "https://" cfg.tellstickAddress);
          message = "homeServer.tellstickAddress must be an explicit http:// or https:// local bridge URL";
        }
        {
          assertion = (cfg.matrixServerName == null) == (cfg.matrixSecretFile == null);
          message = "homeServer.matrixServerName and homeServer.matrixSecretFile must be supplied together";
        }
        {
          assertion = isRuntimePath cfg.matrixSecretFile;
          message = "homeServer.matrixSecretFile must be an absolute runtime path outside the Nix store";
        }
        {
          assertion = !cfg.matrixTailnet || matrixEnabled;
          message = "homeServer.matrixTailnet requires Matrix server name and secret file";
        }
        {
          assertion = isRuntimePath cfg.adminHashedPasswordFile;
          message = "homeServer.adminHashedPasswordFile must be an absolute runtime path outside the Nix store";
        }
        {
          assertion = isRuntimePath cfg.cloudApiEnvironmentFile;
          message = "homeServer.cloudApiEnvironmentFile must be an absolute runtime path outside the Nix store";
        }
      ];

      services.mosquitto = {
        enable = true;
        persistence = true;
        dataDir = "/var/lib/mosquitto";
        listeners = [
          {
            address = "127.0.0.1";
            port = 1883;
            omitPasswordAuth = true;
            acl = [
              "topic readwrite zigbee2mqtt/#"
              "topic readwrite house/v1/#"
              # Home Assistant discovery and birth messages.
              "topic readwrite homeassistant/#"
            ];
            settings.allow_anonymous = true;
          }
        ] ++ optional mqttNetworkEnabled {
          address = "0.0.0.0";
          port = cfg.mqttNetworkPort;
          settings.allow_anonymous = false;
          users.${cfg.mqttNetworkUsername} = {
            passwordFile = cfg.mqttNetworkPasswordFile;
            acl = cfg.mqttNetworkAcl;
          };
        };
      };

      networking.firewall.interfaces.tailscale0.allowedTCPPorts =
        optional mqttNetworkEnabled cfg.mqttNetworkPort
        ++ optional (zigbeeEnabled && cfg.zigbeeFrontendTailnet) 8080
        ++ optional (matrixEnabled && cfg.matrixTailnet) 8008;

      services.postgresql = {
        enable = true;
        package = pkgs.postgresql_17;
        enableTCPIP = false;
        initdbArgs = [ "--locale=C" "--encoding=UTF8" ];
        authentication = lib.mkForce ''
          local all all peer
        '';
        settings.listen_addresses = lib.mkForce "";
        ensureDatabases = [ "matrix-synapse" ];
        ensureUsers = [ { name = "matrix-synapse"; ensureDBOwnership = true; } ];
      };
    }

    (mkIf zigbeeEnabled {
      assertions = [
        {
          assertion =
            (config.services.zigbee2mqtt.settings.devices or null) == "devices.yaml"
            && (config.services.zigbee2mqtt.settings.groups or null) == "groups.yaml";
          message = "zigbee2mqtt must keep devices.yaml and groups.yaml as its device and group files so runtime renames survive restarts";
        }
      ];

      services.zigbee2mqtt = {
        enable = true;
        dataDir = "/var/lib/zigbee2mqtt";
        settings = {
          homeassistant.enabled = true;
          permit_join = false;
          availability.enabled = true;
          serial = { port = cfg.zigbeeSerialPort; adapter = "ember"; };
          mqtt = { server = "mqtt://127.0.0.1:1883"; base_topic = "zigbee2mqtt"; };
          frontend = {
            enabled = true;
            host = if cfg.zigbeeFrontendTailnet then "0.0.0.0" else "127.0.0.1";
            port = 8080;
          };
          advanced = {
            channel = cfg.zigbeeChannel;
            pan_id = cfg.zigbeePanId;
            ext_pan_id = cfg.zigbeeExtendedPanId;
          };
        };
      };

      systemd.services.zigbee2mqtt = {
        # Wants=, not Requires=, for the broker. A Requires= whose target fails
        # cancels this unit's start job, and the unit it leaves behind is
        # indistinguishable from one somebody stopped on purpose: measured on
        # this host, a start cancelled by a failed Requires= yields
        # ActiveState=inactive, SubState=dead, Result=success -- exactly what
        # `systemctl stop` yields. The watchdog reads that as a deliberate stop
        # and stands down, so a single mosquitto failure at boot (its own
        # Restart= then revives it) left Zigbee2MQTT stopped for good with
        # nothing acting on it. Wants= keeps the ordering below without the
        # power to cancel. Zigbee2MQTT retries its own broker connection, the
        # watchdog already stands down while the broker is down, and mosquitto
        # is a deploy health unit in its own right, so a broker that stays
        # broken is still caught.
        wants = [ "mosquitto.service" ];
        # BindsTo= rather than Requires= for the coordinator. systemd.unit(5):
        # Requires= stops this service only when the listed unit is
        # *explicitly* stopped, whereas BindsTo= "also does so when a listed
        # unit stops unexpectedly", and names "the backing device of a device
        # unit might be unplugged" as precisely that case. An unplug is the
        # unexpected kind, so Requires= left Zigbee2MQTT running against a
        # serial port that no longer existed -- and because `wants` are pulled
        # in only when a unit *starts*, re-adding the device could not recover
        # an already-active service. Paired with After= below, which the man
        # page recommends combining with BindsTo=.
        bindsTo = [ zigbeeDeviceUnit ];
        after = [ "mosquitto.service" zigbeeDeviceUnit ];
        # Nothing starts this service again when the device reappears: it is
        # only wanted by multi-user.target, long since reached. So an unplug
        # left the house without Zigbee until a human noticed, which is what
        # happened on 2026-11-07 -- replugging the dongle did not recover it.
        # Being wanted by the device unit closes that: udev creates the device,
        # systemd pulls this service up with it.
        wantedBy = [ zigbeeDeviceUnit ];
        environment.Z2M_ONBOARD_NO_SERVER = "1";
        serviceConfig = {
          LoadCredential = "network-key:${cfg.zigbeeNetworkKeyFile}";
          ExecStart = lib.mkForce (lib.getExe zigbee2mqttWithNetworkKey);
          # Upstream ships Restart=on-failure. Under it systemd.service(5)
          # counts "exit code of 0" and SIGHUP/SIGINT/SIGTERM/SIGPIPE as clean
          # and does not restart, so a Zigbee2MQTT that exited 0 or died on
          # SIGPIPE parked the unit in "inactive" indefinitely -- and the
          # watchdog deliberately skips an inactive unit as "stopped rather
          # than broken", so nothing recovered the radio at all. `always`
          # closes that at the source without fighting deliberate stops,
          # because "when the death of the process is a result of systemd
          # operation (e.g. service stop or restart), the service will not be
          # restarted" -- which is also what keeps the BindsTo= stop above from
          # being undone on an unplug.
          Restart = lib.mkForce "always";
        };
      };
    })

    (mkIf zigbeeEnabled {
      # The last gap: the known causes of a dead radio now recover on their own,
      # but anything unforeseen still leaves Zigbee down for as long as it takes
      # a human to notice. This closes that without asking one to.
      systemd.services.zigbee2mqtt-watchdog = {
        description = "Restart Zigbee2MQTT when its bridge is not online";
        after = [ "mosquitto.service" ];
        environment.WATCHDOG_DEVICE_UNIT = zigbeeDeviceUnit;
        serviceConfig = {
          Type = "oneshot";
          ExecStart = lib.getExe zigbee2mqttWatchdog;
          User = "root";
          Group = "root";
          StateDirectory = "zigbee2mqtt-watchdog";
          StateDirectoryMode = "0700";
          UMask = "0077";
          ProtectHome = true;
          PrivateTmp = true;
          NoNewPrivileges = true;
          RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        };
      };
      systemd.timers.zigbee2mqtt-watchdog = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "5min";
          OnUnitActiveSec = "2min";
          Persistent = true;
          Unit = "zigbee2mqtt-watchdog.service";
        };
      };
    })

    (mkIf tellstickConfigured {
      systemd.services.tellstick-mqtt-bridge = {
        description = "Local TellStick ZNet Lite v2 to MQTT adapter";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        requires = [ "mosquitto.service" ];
        after = [ "network-online.target" "mosquitto.service" ];
        environment = {
          TELLSTICK_BASE_URL = cfg.tellstickAddress;
          TELLSTICK_TOKEN_FILE = "%d/tellstick-token";
          MQTT_URL = "mqtt://127.0.0.1:1883";
          MQTT_NAMESPACE = "house/v1/tellstick";
        };
        serviceConfig = {
          ExecStart = "${cfg.tellstickAdapterPackage}/bin/tellstick-mqtt-bridge";
          Restart = "on-failure";
          RestartSec = "5s";
          LoadCredential = "tellstick-token:${cfg.tellstickTokenFile}";
          DynamicUser = true;
          StateDirectory = "tellstick-mqtt-bridge";
          StateDirectoryMode = "0700";
          UMask = "0077";
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          PrivateDevices = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
          CapabilityBoundingSet = "";
        };
      };
    })

    (mkIf matrixEnabled {
      services.matrix-synapse = {
        enable = true;
        dataDir = "/var/lib/matrix-synapse";
        extraConfigFiles = [ cfg.matrixSecretFile ];
        log.root.level = "WARNING";
        settings = {
          server_name = cfg.matrixServerName;
          enable_registration = false;
          report_stats = false;
          federation_domain_whitelist = [ ];
          trusted_key_servers = [ ];
          url_preview_enabled = false;
          max_upload_size = "50M";
          media_store_path = "/var/lib/matrix-synapse/media_store";
          database = {
            name = "psycopg2";
            args = {
              database = "matrix-synapse";
              user = "matrix-synapse";
              host = "/run/postgresql";
              cp_min = 5;
              cp_max = 10;
            };
          };
          listeners = [
            {
              port = 8008;
              bind_addresses = [ (if cfg.matrixTailnet then "0.0.0.0" else "127.0.0.1") ];
              type = "http";
              tls = false;
              x_forwarded = false;
              resources = [ { names = [ "client" ]; compress = true; } ];
            }
          ];
        };
      };
    })

    (mkIf (cfg.adminHashedPasswordFile != null) {
      users.users.jonathan.hashedPasswordFile = cfg.adminHashedPasswordFile;
    })
  ];
}
