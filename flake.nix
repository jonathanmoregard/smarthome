{
  description = "Reproducible home-server configuration";

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
      pairZigbee = pkgs.callPackage ./nix/pair-zigbee.nix { };
    in
    {
      packages.${system} = {
        pair-zigbee = pairZigbee;
      };

      apps.${system} = {
        pair-zigbee = {
          type = "app";
          program = pkgs.lib.getExe pairZigbee;
          meta.description = pairZigbee.meta.description;
        };
      };

      nixosModules.system-deploy = import ./nixos/modules/system-auto-deploy.nix;

      nixosConfigurations.home-server = nixpkgs-system.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit self; };
        modules = [
          agenix.nixosModules.default
          ./nixos/hosts/home-server
        ];
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          age
        ];
      };

      checks.${system} = {
        pair-zigbee = import ./nix/tests/pair-zigbee.nix { inherit pkgs pairZigbee; };
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
