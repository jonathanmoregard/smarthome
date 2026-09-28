{
  appSource,
  cargoLockFile ? ../Cargo.lock,
  lib,
  rustPlatform,
}:

rustPlatform.buildRustPackage {
  pname = "house-automationd";
  version = "0.1.0";

  src = appSource;

  cargoLock.lockFile = cargoLockFile;

  cargoBuildFlags = [ "--workspace" ];
  cargoTestFlags = [ "--workspace" ];
  cargoInstallFlags = [
    "--package"
    "house-automationd"
  ];

  strictDeps = true;

  passthru = {
    inherit cargoLockFile;
  };

  meta = {
    description = "House automation daemon";
    license = lib.licenses.mit;
    mainProgram = "house-automationd";
    platforms = lib.platforms.linux;
  };
}
