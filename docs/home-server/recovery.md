# Recovery and rollback

Automatic activation is transactional. The system track records the old
generation in a `pending-activation` journal, switches the profile, runs health
checks, and returns to the exact old generation on failure. The next poll
completes interrupted recovery before considering a new release.

## Diagnose first

```console
systemctl --failed
systemctl status system-deploy.service --no-pager
journalctl -b -u system-deploy.service --no-pager
sudo find /var/lib/smarthome-system-deploy -maxdepth 1 -type f -print
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
```

Save the journal and marker contents before changing state. Secret values must
not be copied into an issue or chat.

## System rollback

From a running system:

```console
sudo systemctl stop system-deploy.timer
sudo systemctl stop system-deploy.service
systemctl is-active system-deploy.service
sudo install -d -m 0700 /run/smarthome-deploy
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  nixos-rebuild switch --rollback --fast
readlink -f /run/current-system
systemctl is-active sshd tailscaled mosquitto
systemctl --failed
```

The deployer preserves this manual rollback and refuses to clobber it. To
return to another retained generation explicitly:

```console
sudo nix-env --profile /nix/var/nix/profiles/system --list-generations
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  /run/current-system/sw/bin/bash -eu -c '
    nix-env --profile /nix/var/nix/profiles/system \
      --switch-generation GENERATION
    /nix/var/nix/profiles/system/bin/switch-to-configuration switch
  '
```

To resume automatic deployment, first merge and promote a fixed descendant.
Then restore the exact recorded last-success system under the shared lock,
verify it, and immediately trigger the fixed release:

```console
system_last_good="$(sudo sed -n 's/^path=//p' \
  /var/lib/smarthome-system-deploy/last-success)"
test -x "$system_last_good/bin/switch-to-configuration"
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  /run/current-system/sw/bin/bash -eu -c '
    path=$1
    nix-env --profile /nix/var/nix/profiles/system --set "$path"
    "$path/bin/switch-to-configuration" switch
  ' _ "$system_last_good"
test "$(readlink -f /run/current-system)" = "$system_last_good"
systemctl is-active sshd tailscaled mosquitto
systemctl --failed
sudo systemctl start system-deploy.timer
sudo systemctl start system-deploy.service
```

The fixed release must descend from the last successful revision. Do not edit
the marker. If restoring its path is unsafe, keep the timer stopped and
repair forward under operator control.

If the machine cannot boot, choose the prior NixOS generation in systemd-boot.
Once logged in, inspect the system deployment marker and journal. Do not remove
the last bootable generation or repartition the disk during diagnosis.

## Service and Zigbee recovery

```console
systemctl is-active mosquitto zigbee2mqtt tailscaled sshd
journalctl -b -u zigbee2mqtt --no-pager
readlink -f /dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0
sudo test -r /run/agenix/zigbee2mqtt-network-key
```

Zigbee network identity is channel 25, PAN ID 50324, extended PAN ID
`[52,207,50,36,195,122,154,61]`, plus the encrypted 16-byte network key. Do not
regenerate any of these during service recovery: doing so would orphan paired
devices. Restore `/var/lib/zigbee2mqtt` and the matching secret together from a
tested backup when recovering a lost disk.

After every recovery, reboot once and verify SSH over Tailscale, the deploy timer,
mounts, profiles, Mosquitto, Zigbee2MQTT, and zero failed units.
