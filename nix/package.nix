{
  lib,
  rustPlatform,
}:

rustPlatform.buildRustPackage {
  pname = "house-automationd";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  cargoLock.lockFile = ../Cargo.lock;

  cargoBuildFlags = [ "--workspace" ];
  cargoTestFlags = [ "--workspace" ];
  cargoInstallFlags = [
    "--package"
    "house-automationd"
  ];

  strictDeps = true;

  meta = {
    description = "House automation daemon";
    license = lib.licenses.mit;
    mainProgram = "house-automationd";
    platforms = lib.platforms.linux;
  };
}
