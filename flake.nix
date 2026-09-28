{
  description = "Reproducible house automation service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.nixpkgs-system.url =
    "github:NixOS/nixpkgs/b7c2ada94fe99c15b0dbcf4d11fd7850b957a436";
  inputs.agenix.url = "github:ryantm/agenix";
  inputs.agenix.inputs.nixpkgs.follows = "nixpkgs-system";

  outputs =
    flakeInputs@{
      self,
      nixpkgs,
      nixpkgs-system,
      agenix,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      pkgsSystem = import nixpkgs-system { inherit system; };
      appSource = import ./nix/source.nix { inherit (pkgs) lib; };
      cargoLockFile = ./Cargo.lock;
      package = pkgs.callPackage ./nix/package.nix { inherit appSource cargoLockFile; };
      collectInputSources = input:
        let
          inputSource = if builtins.isAttrs input && input ? outPath then input.outPath else input;
          children =
            if builtins.isAttrs input && input ? inputs then
              builtins.attrValues input.inputs
            else
              [ ];
        in
        [ inputSource ] ++ pkgsSystem.lib.concatMap collectInputSources children;
      homeServerCdInputSources = pkgsSystem.lib.unique (
        pkgsSystem.lib.concatMap collectInputSources (
          builtins.attrValues (builtins.removeAttrs flakeInputs [ "self" ])
        )
      );
      pairZigbee = pkgs.callPackage ./nix/pair-zigbee.nix { };
      house = pkgs.callPackage ./nix/house.nix { inherit pairZigbee; };
      mkCargoCheck =
        {
          name,
          command,
          extraNativeBuildInputs ? [ ],
        }:
        package.overrideAttrs (old: {
          pname = name;
          nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ extraNativeBuildInputs;
          doCheck = false;
          buildPhase = ''
            runHook preBuild
            ${command}
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            touch "$out/passed"
            runHook postInstall
          '';
        });
    in
    {
      packages.${system} = {
        default = package;
        pair-zigbee = pairZigbee;
        house = house;
      };

      apps.${system}.pair-zigbee = {
        type = "app";
        program = pkgs.lib.getExe pairZigbee;
        meta.description = pairZigbee.meta.description;
      };

      apps.${system}.house = {
        type = "app";
        program = pkgs.lib.getExe house;
        meta.description = house.meta.description;
      };

      nixosModules.default = import ./nix/module.nix;
      nixosModules.system-deploy = import ./nixos/modules/system-auto-deploy.nix;

      nixosConfigurations.home-server = nixpkgs-system.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit self; };
        modules = [
          agenix.nixosModules.default
          ./nixos/hosts/home-server
        ];
      };

      nixosConfigurations.home-server-cd =
        self.nixosConfigurations.home-server.extendModules {
          modules = [
            ./nixos/tests/fixtures/home-server-cd-module.nix
            { system.extraDependencies = homeServerCdInputSources; }
          ];
        };

      nixosConfigurations.home-server-cd-bad =
        self.nixosConfigurations.home-server-cd.extendModules {
          modules = [
            { homeServerCd.releaseState = pkgsSystem.lib.mkForce "bad"; }
          ];
        };

      nixosConfigurations.home-server-cd-v2 =
        self.nixosConfigurations.home-server-cd.extendModules {
          modules = [
            { homeServerCd.releaseState = pkgsSystem.lib.mkForce "v2"; }
          ];
        };

      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ package ];
        packages = with pkgs; [
          cargo
          clippy
          age
          rustc
          rustfmt
        ];
      };

      checks.${system} = {
        app-source = import ./nix/tests/app-source.nix {
          inherit appSource cargoLockFile package pkgs;
        };
        release-scripts = import ./nix/tests/release-scripts.nix { inherit pkgs; };
        publish-workflow = import ./nix/tests/publish-workflow.nix { inherit pkgs; };
        package = package;
        fmt = pkgs.runCommand "house-automation-formatting" {
          inherit appSource;
          nativeBuildInputs = [
            pkgs.cargo
            pkgs.rustfmt
          ];
        } ''
          cp -R "$appSource" source
          chmod -R u+w source
          cd source
          cargo fmt --all -- --check
          touch "$out"
        '';
        clippy = mkCargoCheck {
          name = "house-automation-clippy";
          command = "cargo clippy --offline --workspace --all-targets -- -D warnings";
          extraNativeBuildInputs = [ pkgs.clippy ];
        };
        tests = mkCargoCheck {
          name = "house-automation-tests";
          command = "cargo test --offline --workspace";
        };
        module-vm = import ./nix/tests/module.nix {
          inherit pkgs package;
          module = self.nixosModules.default;
        };
        simulated-house = import ./nix/tests/simulated-house.nix {
          inherit pkgs package;
          module = self.nixosModules.default;
        };
        pair-zigbee = import ./nix/tests/pair-zigbee.nix { inherit pkgs pairZigbee; };
        house = import ./nix/tests/house.nix {
          inherit pkgs package house;
          module = self.nixosModules.default;
        };
        # The shipped daemon must accept the shipped home-server topology.
        house-config = pkgs.runCommand "house-config" { } ''
          ${package}/bin/house-automationd check-config ${./nixos/hosts/home-server/house.toml}
          touch $out
        '';
        standalone-host = import ./nixos/tests/standalone-host.nix {
          inherit pkgsSystem;
          host = self.nixosConfigurations.home-server;
        };
        home-server-ssh = import ./nix/tests/home-server-ssh.nix {
          inherit pkgs;
          knownHosts = ./nixos/hosts/home-server/known_hosts;
          script = ./scripts/home-server-ssh;
        };
        home-server-services = import ./nixos/tests/home-server-services.nix {
          inherit agenix pkgsSystem;
          nixosSystem = nixpkgs-system.lib.nixosSystem;
          host = self.nixosConfigurations.home-server;
        };
        vm-home-server = import ./nixos/tests/home-server.nix {
          inherit agenix pkgsSystem;
        };
        vm-home-server-cd = import ./nixos/tests/home-server-cd.nix {
          inherit agenix pkgsSystem;
          inputSources = homeServerCdInputSources;
          homeServerCdSystem = self.nixosConfigurations.home-server-cd.config.system.build.toplevel;
          homeServerCdBadSystem =
            self.nixosConfigurations.home-server-cd-bad.config.system.build.toplevel;
          homeServerCdV2System =
            self.nixosConfigurations.home-server-cd-v2.config.system.build.toplevel;
        };
        app-deploy = import ./nixos/tests/app-deploy.nix {
          inherit pkgs;
          nixosSystem = nixpkgs.lib.nixosSystem;
        };
        app-activator = import ./nixos/tests/app-activator.nix {
          inherit pkgs;
          script = ./nixos/modules/activate-app.sh;
        };
        system-deploy = import ./nixos/tests/system-deploy.nix {
          inherit pkgs;
          nixosSystem = nixpkgs.lib.nixosSystem;
        };
        system-activator = import ./nixos/tests/system-activator.nix {
          inherit pkgs;
          script = ./nixos/modules/activate-system.sh;
        };
        hydrator = import ./nixos/tests/hydrator.nix {
          inherit pkgs;
          script = ./nixos/modules/hydrate-release-paths.sh;
        };
      };
    };
}
