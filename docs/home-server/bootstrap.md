# Home-server bootstrap

This repository is the complete source of truth for `home-server`. The physical
target is an x86-64 Dell Wyse 5070 with UEFI, an Intel CPU, an ext4 root labeled
`nixos`, and a FAT EFI partition labeled `EFI`. Review
[`hardware-configuration.nix`](../../nixos/hosts/home-server/hardware-configuration.nix)
against freshly generated hardware data before installing different hardware.
Never assume a device name such as `/dev/sda` on a new machine.

## Preconditions

- protected `main` requires the stable `ci` status;
- GitHub Actions has a cache-scoped `CACHIX_AUTH_TOKEN`;
- `release/app` and `release/home-server` point at verified ancestors of
  `main`;
- both exact release roots exist in `jonathanmoregard.cachix.org`;
- the server host public key and every administrator public key are committed
  here, and the matching host private key is recoverable without entering Git;
- `nixos/secrets/zigbee2mqtt-network-key.age` includes the physical host age
  recipient;
- at least one non-Dellan operator key is enrolled before Dellan is retired.

The repository is public. Fetch it over HTTPS. No GitHub deploy key or private
Git credential belongs on the server.

## First activation

Build and test changes on GitHub or another machine. Do not build on the
server: its Nix daemon has `max-jobs = 0`, no builders, and no fallback.

For the existing server, first merge the temporary `nixos-config` cutover PR.
That PR must pin the merged standalone revision, import only its system deploy
client, disable `nixos-deploy.timer`, and enable `system-deploy.timer` in one
generation. Immediately after merge, while the old generation still provides
`nixos-deploy.service`, start it and wait for it to install the bridge. The
first command blocks until activation finishes; only then inspect the journal
and new timer states:

```console
sudo systemctl start nixos-deploy.service
journalctl -u nixos-deploy.service -n 50 --no-pager
systemctl is-enabled nixos-deploy.timer
systemctl is-enabled system-deploy.timer
sudo systemctl start system-deploy.service
sudo systemctl status system-deploy.service --no-pager
```

Expected timer states are `disabled` for `nixos-deploy.timer` and `enabled` for
`system-deploy.timer`. Do not remove old repository files or credentials until
the standalone service survives reboot and a second poll.

For a blank machine, boot the NixOS installer, identify the target by model,
serial, size, and existing signatures, then partition and mount that explicitly
reviewed disk. The commands below begin only after its root is mounted at
`/mnt` and EFI at `/mnt/boot`; they do not select or partition a disk:

The pinned SSH fingerprint and agenix recipient both derive from the existing
host private key. Before installation, restore that private key from its
approved KeePass backup into the target filesystem. From a trusted shell with
the KeePass database available:

<!-- markdownlint-disable MD013 -->
```console
nix shell nixpkgs#keepassxc --command bash
read -r -p 'KeePass database path: ' keepass_database
read -r -p 'Home-server SSH identity entry: ' host_identity_entry
exec 3< <(keepassxc-cli show -q -s -a Password \
  "$keepass_database" "$host_identity_entry")
sudo install -d -m 0755 /mnt/etc/ssh
sudo install -m 0600 /dev/null /mnt/etc/ssh/ssh_host_ed25519_key
sudo tee /mnt/etc/ssh/ssh_host_ed25519_key </proc/self/fd/3 >/dev/null
exec 3<&-
sudo ssh-keygen -y -f /mnt/etc/ssh/ssh_host_ed25519_key |
  sudo tee /mnt/etc/ssh/ssh_host_ed25519_key.pub >/dev/null
sudo chmod 0644 /mnt/etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /mnt/etc/ssh/ssh_host_ed25519_key.pub
```

The fingerprint must equal
`SHA256:uGZypONrT3PNbrdQG0Cp25x/el1ck6b7Azp6WRuKkSE`. If the matching private
key is unavailable, stop. Generate a new target host key, use a portable age
recovery identity to re-encrypt the Zigbee secret to its public recipient,
update `deployment-identity.nix` and the pinned key in `access.md`, then merge
and publish that change before restarting this installation from the new
`release/home-server`. Never copy a host private key into Git or a Nix store.

```console
sudo test ! -e /mnt/etc/ssh/ssh_host_ed25519_key
sudo ssh-keygen -q -t ed25519 -N '' -C root@home-server \
  -f /mnt/etc/ssh/ssh_host_ed25519_key
sudo cat /mnt/etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /mnt/etc/ssh/ssh_host_ed25519_key.pub
```

Only the displayed public key and fingerprint enter the PR. Follow the
[secret rekey procedure](secrets.md#encrypt-or-rekey) with the portable private
identity, but set `host_recipient` to the newly displayed public key instead of
the old pinned value. Before merge, copy only the candidate ciphertext to the
installer and prove the new target identity can decrypt it:

```console
scp nixos/secrets/zigbee2mqtt-network-key.age.new \
  nixos@INSTALLER_IP:/tmp/zigbee2mqtt-network-key.age.new
ssh -t nixos@INSTALLER_IP \
  "sudo nix shell github:NixOS/nixpkgs/b7c2ada94fe99c15b0dbcf4d11fd7850b957a436#age --command age -d -i /mnt/etc/ssh/ssh_host_ed25519_key -o /dev/null /tmp/zigbee2mqtt-network-key.age.new"
ssh nixos@INSTALLER_IP \
  'rm -- /tmp/zigbee2mqtt-network-key.age.new'
```

After both the portable and new target identities decrypt to `/dev/null`, merge
the public-key, fingerprint, and ciphertext update; wait for both publication
tracks, then fetch and verify the new release below. Do not install the older
release against the new identity.

```console
findmnt --target /mnt
findmnt --target /mnt/boot
install -d /tmp/smarthome-bootstrap
git -C /tmp/smarthome-bootstrap init
git -C /tmp/smarthome-bootstrap remote add origin \
  https://github.com/jonathanmoregard/smarthome.git
git -C /tmp/smarthome-bootstrap fetch origin \
  +refs/heads/main:refs/remotes/origin/main \
  +refs/heads/release/home-server:refs/remotes/origin/release/home-server
release="$(git -C /tmp/smarthome-bootstrap rev-parse \
  refs/remotes/origin/release/home-server)"
git -C /tmp/smarthome-bootstrap merge-base --is-ancestor \
  "$release" refs/remotes/origin/main
git -C /tmp/smarthome-bootstrap checkout --detach "$release"
sudo nixos-install --root /mnt --no-root-passwd \
  --flake /tmp/smarthome-bootstrap#home-server \
  --option substituters \
    'https://jonathanmoregard.cachix.org https://cache.nixos.org' \
  --option trusted-public-keys \
    'jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8= cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=' \
  --option max-jobs 0 --option fallback false --option builders ''
sudo nixos-enter --root /mnt -c 'passwd jonathan'
```
<!-- markdownlint-enable MD013 -->

Missing cache paths are a publication failure. Never enable local compilation
to get past one. Reboot only after `nixos-install` succeeds and the generated
bootloader entries exist below `/mnt/boot`.

Set Jonathan's password at the hidden `passwd` prompts with KeePass paste or
auto-type; do not put it in a command argument, environment variable, or shell
history. On first boot, log in on the physical console and run `sudo tailscale
up`. Verify Tailscale and pinned-key SSH from another machine before relying on
remote-only access.

Enroll Tailscale once through its interactive login, then verify ordinary
OpenSSH over `tailscale0`. Tailscale SSH is deliberately disabled; OpenSSH owns
authentication and uses repository-managed authorized keys.

## Bootstrap verification

```console
systemctl is-active sshd tailscaled mosquitto zigbee2mqtt
systemctl is-enabled app-deploy.timer system-deploy.timer
systemctl list-timers app-deploy.timer system-deploy.timer
systemctl --failed
nix show-config | grep -E '^(max-jobs|builders|fallback) ='
findmnt --target /
findmnt --target /boot
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
readlink -f /nix/var/nix/profiles/smarthome
```

Expected Nix values are `max-jobs = 0`, empty `builders`, and
`fallback = false`. `/run/current-system` and the system profile must resolve to
the same store path. `systemctl --failed` must be empty.

The coordinator identity is fixed in
[`zigbee-coordinator.nix`](../../nixos/hosts/home-server/zigbee-coordinator.nix).
Confirm the actual dongle appears at that `/dev/serial/by-id/...` path before
starting Zigbee2MQTT. Never replace it with `/dev/ttyUSB0`.
