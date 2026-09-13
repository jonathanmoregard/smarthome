{
  description = "Reproducible house automation service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      package = pkgs.callPackage ./nix/package.nix { };
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

      checks.${system}.package = package;
    };
}
