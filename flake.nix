{
  description = "Reproducible house automation service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      package = pkgs.callPackage ./nix/package.nix { };
      source = pkgs.lib.cleanSource ./.;
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
      packages.${system}.default = package;

      nixosModules.default = import ./nix/module.nix;

      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ package ];
        packages = with pkgs; [
          cargo
          clippy
          rustc
          rustfmt
        ];
      };

      checks.${system} = {
        package = package;
        fmt = pkgs.runCommand "house-automation-formatting" {
          inherit source;
          nativeBuildInputs = [
            pkgs.cargo
            pkgs.rustfmt
          ];
        } ''
          cp -R "$source" source
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
      };
    };
}
