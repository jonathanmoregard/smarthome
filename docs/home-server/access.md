# Operator and housemate access

The server uses ordinary OpenSSH over the Tailscale network. Tailscale SSH is
disabled. Password and keyboard-interactive SSH login are disabled, root cannot
log in, and port 22 is open only on `tailscale0`.

## Pin the server host key

The repository pins this host key:

<!-- markdownlint-disable MD013 -->
```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+ root@home-server
```
<!-- markdownlint-enable MD013 -->

Expected fingerprint:

```text
SHA256:uGZypONrT3PNbrdQG0Cp25x/el1ck6b7Azp6WRuKkSE
```

On any operator machine, verify that fingerprint from this repository, then add
the public key with the actual tailnet names or address to that machine's
`known_hosts`. Do not accept a different interactive first-use key.

Example entry for the current Tailscale IPv4:

```text
home-server,100.87.199.107 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+
```

Connect with a separately generated private key:

```console
ssh ACCOUNT@100.87.199.107
```

## Independent Tailscale enrollment

SSH is reachable only through `tailscale0`, so a server account and key are not
enough. The tailnet owner must invite the housemate's own identity, require them
to enroll their own computer, and grant that identity TCP port 22 to
`home-server` (currently `100.87.199.107`) in the tailnet access policy. Do not
share Jonathan's Tailscale login, node state, or reusable auth key.

On the housemate's computer, install Tailscale and authenticate interactively
with the invited identity:

```console
sudo tailscale up
tailscale status
tailscale ping 100.87.199.107
ssh HOUSEMATE@100.87.199.107
```

Keep the policy limited to TCP 22. Zigbee2MQTT remains loopback-only and is
reached through the SSH tunnel below. Validate the housemate's login before
removing any existing operator or changing the tailnet policy again.

`jonathan@dellan` remains authorized during cutover. Add and verify a Tuxedo or
portable Jonathan operator public key in
[`home-server-base.nix`](../../nixos/profiles/home-server-base.nix) before
retiring Dellan. Private keys never enter this repository.

## Housemate account

Give each person a separate NixOS user and public key. Do not share Jonathan's
private key or account. A housemate who pairs devices and works through GitHub
does not need `wheel`: grant `systemd-journal` for diagnostics, SSH forwarding
for the loopback Zigbee2MQTT UI, and repository permissions through their own
GitHub identity. Add elevated commands only when a concrete task requires them.

Example declarative shape, with a real account name and public key supplied by
that person:

```nix
users.users.HOUSEMATE = {
  isNormalUser = true;
  extraGroups = [ "systemd-journal" ];
  openssh.authorizedKeys.keys = [ "ssh-ed25519 ... HOUSEMATE" ];
};
```

Submit the change through this repository's PR and system-release pipeline.
Verify login before removing any older administrator key.

## Pair devices without public services

Forward the loopback Zigbee2MQTT UI over the pinned SSH connection:

```console
ssh -N -L 8080:127.0.0.1:8080 ACCOUNT@100.87.199.107
```

Open `http://127.0.0.1:8080`, enable joining briefly, reset and interview one
device, assign a unique stable `friendly_name`, then disable joining. Add that
name and its observed capabilities to
`nixos/hosts/home-server/house.toml`, enable `homeServer.houseSettings` as
described in the README, and open a PR. Editing `examples/house.toml` does not
configure the server. Never expose the UI or MQTT broker to the public Internet.

Code development needs no server shell: fork or clone this public repository,
run selected Nix checks, and open a PR. GitHub builds and publishes; the server
deploys only a verified promoted revision after merge.

## Offboarding

Remove only the departing person's public key/account in a reviewed PR. Keep at
least two independently held administrator paths until the new generation has
deployed and both have verified login. Removing a public key does not revoke a
GitHub account or Tailscale membership; revoke those separately.
