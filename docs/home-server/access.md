# Operator and housemate access

The server uses ordinary OpenSSH over the Tailscale network. Tailscale SSH is
disabled. Password and keyboard-interactive SSH login are disabled, root cannot
log in, and port 22 is open only on `tailscale0`.

## Connect with the pinned host key

The repository pins this host key in
[`known_hosts`](../../nixos/hosts/home-server/known_hosts):

<!-- markdownlint-disable MD013 -->
```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+ root@home-server
```
<!-- markdownlint-enable MD013 -->

Expected fingerprint:

```text
SHA256:uGZypONrT3PNbrdQG0Cp25x/el1ck6b7Azp6WRuKkSE
```

From any clone, connect through the repository-owned wrapper. It ignores local
SSH host configuration, uses only the committed host key, requires strict host
key checking, and targets the current Tailscale IPv4:

```console
./scripts/home-server-ssh jonathan
./scripts/home-server-ssh jonathan -- systemctl status mosquitto
```

The private user key still comes from the operator's SSH agent or standard key
files and never enters this repository. Do not bypass the wrapper or accept a
different interactive first-use host key.

## Independent Tailscale enrollment

SSH is reachable only through `tailscale0`, so a server account and key are not
enough. The tailnet owner must invite the housemate's own identity, require them
to enroll their own computer, and grant that identity TCP port 22 to
`home-server` (currently `100.87.199.107`) in the tailnet access policy. Do not
share Jonathan's Tailscale login, node state, or reusable auth key.

On the housemate's computer, install Tailscale and authenticate interactively
with the invited identity:

```console
sudo tailscale up --ssh=false
tailscale status
tailscale ping 100.87.199.107
./scripts/home-server-ssh housemate
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

Production does not yet contain a `housemate` account because no housemate
public key has been supplied. Add this exact least-privilege shape after that
person provides an `ssh-ed25519` public key:

```nix
users.users.housemate = {
  isNormalUser = true;
  extraGroups = [ "systemd-journal" ];
  openssh.authorizedKeys.keys = [ "ssh-ed25519 ... housemate" ];
};
```

Submit the change through this repository's PR and system-release pipeline.
Verify login before removing any older administrator key.

## Pair devices without public services

Forward the loopback Zigbee2MQTT UI over the pinned SSH connection:

```console
./scripts/home-server-ssh housemate --pairing-ui
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
