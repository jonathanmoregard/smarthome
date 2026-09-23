# Secrets

Only ciphertext belongs in Git. The current production secret is
`nixos/secrets/zigbee2mqtt-network-key.age`; agenix decrypts it at activation to
`/run/agenix/zigbee2mqtt-network-key` with mode `0400`, owned by root.

The physical host age recipient is committed in
[`deployment-identity.nix`](../../nixos/hosts/home-server/deployment-identity.nix).
Current ciphertext has only that physical-host recipient. Standalone cutover is
therefore blocked on creating a separate portable age recovery identity,
storing its private half in KeePass, re-encrypting to both recipients, and
committing only its public recipient. Never share a private identity between
housemates.

## Encrypt or rekey

Use `age` from the repository development shell. Supply plaintext and private
identities through a KeePass-backed file descriptor: never a shell argument,
environment variable, command log, chat message, or ordinary temporary file.
Start an operator shell containing `keepassxc-cli`, then set only non-secret
locations and public recipients:

<!-- markdownlint-disable MD013 -->
```console
nix shell nixpkgs#keepassxc --command bash
read -r -p 'KeePass database path: ' keepass_database
read -r -p 'Zigbee plaintext entry path: ' zigbee_plaintext_entry
read -r -p 'Portable age identity entry path: ' portable_identity_entry
host_recipient='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+ root@home-server'
portable_recipient='AGE_PUBLIC_RECIPIENT_FROM_KEEPASS'
umask 077
```
<!-- markdownlint-enable MD013 -->

For the Zigbee key, plaintext must be one compact JSON array containing exactly
16 integers from 0 through 255. Encrypt to both the physical host recipient and
the portable recovery recipient:

<!-- markdownlint-disable MD013 -->
```console
exec 3< <(keepassxc-cli show -q -s -a Password \
  "$keepass_database" "$zigbee_plaintext_entry")
nix develop --command age \
  -r "$host_recipient" \
  -r "$portable_recipient" \
  -o nixos/secrets/zigbee2mqtt-network-key.age.new \
  /proc/self/fd/3
exec 3<&-
```
<!-- markdownlint-enable MD013 -->

For existing ciphertext, the portable identity must already be one of its
recipients. Keep plaintext inside a pipe:

```console
exec 3< <(keepassxc-cli show -q -s -a Password \
  "$keepass_database" "$portable_identity_entry")
nix develop --command bash -euo pipefail -c '
  age -d -i /proc/self/fd/3 \
    nixos/secrets/zigbee2mqtt-network-key.age |
    age -r "$1" -r "$2" \
      -o nixos/secrets/zigbee2mqtt-network-key.age.new
' _ "$host_recipient" "$portable_recipient"
exec 3<&-
```

Verify the portable identity without printing plaintext:

```console
exec 3< <(keepassxc-cli show -q -s -a Password \
  "$keepass_database" "$portable_identity_entry")
nix develop --command age -d -i /proc/self/fd/3 -o /dev/null \
  nixos/secrets/zigbee2mqtt-network-key.age.new
exec 3<&-
```

Verify the physical host recipient using the host's private identity, without
copying that identity off the server. The uploaded file remains ciphertext:

<!-- markdownlint-disable MD013 -->
```console
scp nixos/secrets/zigbee2mqtt-network-key.age.new \
  jonathan@100.87.199.107:zigbee2mqtt-network-key.age.new
ssh -t jonathan@100.87.199.107 \
  "sudo nix shell github:NixOS/nixpkgs/b7c2ada94fe99c15b0dbcf4d11fd7850b957a436#age --command age -d -i /etc/ssh/ssh_host_ed25519_key -o /dev/null /home/jonathan/zigbee2mqtt-network-key.age.new"
ssh jonathan@100.87.199.107 \
  'rm -- /home/jonathan/zigbee2mqtt-network-key.age.new'
mv -- nixos/secrets/zigbee2mqtt-network-key.age.new \
  nixos/secrets/zigbee2mqtt-network-key.age
```
<!-- markdownlint-enable MD013 -->

If neither the KeePass-held plaintext nor a decrypting recovery identity
exists, stop. Do not copy the host private key off the server. Add the portable
recipient only through a separately reviewed secret-recovery procedure.

After changing ciphertext:

```console
nix build --no-link -L .#checks.x86_64-linux.home-server-services
nix build --no-link -L .#nixosConfigurations.home-server.config.system.build.toplevel
git diff --check
```

Review must confirm only ciphertext changed. Never paste decrypted content into
test fixtures; VM tests create disposable independent age identities.

## Runtime rules

- Secrets are read from `/run/agenix` or systemd credentials, never the Nix
  store.
- Do not inspect a secret with `cat` during routine health checks. Test owner,
  mode, non-empty size, and consumer health instead.
- Back up the portable recovery identity and KeePass database independently.
- Rotating Zigbee network identity requires repairing every paired device; do
  it only as an explicit network migration.

The old private-repository SSH deploy credential is not part of this design.
After both physical deployers have successfully fetched the public HTTPS origin
and survived reboot, revoke GitHub deploy key id `164001088`. Confirm it is
absent through GitHub's deploy-key API, then trigger both services again. Keep
ordinary operator SSH keys; they are unrelated.

```console
gh api --method DELETE \
  repos/jonathanmoregard/smarthome/keys/164001088
if gh api repos/jonathanmoregard/smarthome/keys/164001088; then
  echo 'deploy key still exists' >&2
  exit 1
fi
ssh jonathan@100.87.199.107 \
  'sudo systemctl start app-deploy.service system-deploy.service'
```
