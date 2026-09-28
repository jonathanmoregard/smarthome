{ lib, root ? ../. }:

lib.fileset.toSource {
  inherit root;
  fileset = lib.fileset.unions [
    (root + "/Cargo.toml")
    (root + "/Cargo.lock")
    (root + "/rust-toolchain.toml")
    (root + "/examples")
    (root + "/house-automation-core")
    (root + "/house-automationd")
  ];
}
