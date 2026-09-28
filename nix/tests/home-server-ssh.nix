{
  pkgs,
  script,
  knownHosts,
}:

pkgs.runCommand "home-server-ssh-contract"
  {
    nativeBuildInputs = [ pkgs.bash ];
  }
  ''
    mkdir -p bin
    cat > bin/ssh <<'EOF'
    #!${pkgs.bash}/bin/bash
    set -euo pipefail
    : "''${SSH_ARGUMENTS:?}"
    printf '%s\0' "$@" > "$SSH_ARGUMENTS"
    EOF
    chmod +x bin/ssh
    export PATH="$PWD/bin:${pkgs.coreutils}/bin"
    export SSH_ARGUMENTS="$PWD/ssh-arguments"
    export HOME_SERVER_KNOWN_HOSTS=${knownHosts}

    ${pkgs.bash}/bin/bash ${script} housemate
    ${pkgs.python3}/bin/python - ${knownHosts} "$SSH_ARGUMENTS" <<'PY'
    import pathlib
    import sys

    known_hosts = sys.argv[1]
    arguments = pathlib.Path(sys.argv[2]).read_bytes().split(b"\0")[:-1]
    assert arguments == [
        b"-F", b"/dev/null",
        b"-o", f"UserKnownHostsFile={known_hosts}".encode(),
        b"-o", b"GlobalKnownHostsFile=/dev/null",
        b"-o", b"StrictHostKeyChecking=yes",
        b"-o", b"CheckHostIP=yes",
        b"-o", b"HostKeyAlias=home-server",
        b"housemate@100.87.199.107",
    ], arguments
    PY

    ${pkgs.bash}/bin/bash ${script} housemate --pairing-ui
    ${pkgs.python3}/bin/python - ${knownHosts} "$SSH_ARGUMENTS" <<'PY'
    import pathlib
    import sys

    known_hosts = sys.argv[1]
    arguments = pathlib.Path(sys.argv[2]).read_bytes().split(b"\0")[:-1]
    assert arguments == [
        b"-F", b"/dev/null",
        b"-o", f"UserKnownHostsFile={known_hosts}".encode(),
        b"-o", b"GlobalKnownHostsFile=/dev/null",
        b"-o", b"StrictHostKeyChecking=yes",
        b"-o", b"CheckHostIP=yes",
        b"-o", b"HostKeyAlias=home-server",
        b"-N", b"-L", b"8080:127.0.0.1:8080",
        b"housemate@100.87.199.107",
    ], arguments
    PY

    ${pkgs.bash}/bin/bash ${script} jonathan -- systemctl status mosquitto
    ${pkgs.python3}/bin/python - "$SSH_ARGUMENTS" <<'PY'
    import pathlib
    import sys

    arguments = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")[:-1]
    assert arguments[-4:] == [
        b"jonathan@100.87.199.107",
        b"systemctl", b"status", b"mosquitto",
    ], arguments
    PY

    rm -f "$SSH_ARGUMENTS"
    if ${pkgs.bash}/bin/bash ${script} '../bad'; then
      echo 'unsafe account was accepted' >&2
      exit 1
    fi
    test ! -e "$SSH_ARGUMENTS"

    ${pkgs.gnugrep}/bin/grep -Fx 'home-server,100.87.199.107 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+ root@home-server' ${knownHosts}
    touch "$out"
  ''
