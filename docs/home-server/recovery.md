# Recovery and rollback

Automatic activation is transactional. Both tracks record the old generation,
switch the profile, run health checks, and return to the exact old generation
on failure. System activation additionally keeps
`/var/lib/smarthome-system-deploy/pending-activation`; the next run completes
recovery after interruption before considering a new release.

## Diagnose first

```console
systemctl --failed
systemctl status app-deploy.service system-deploy.service --no-pager
journalctl -b -u app-deploy.service -u system-deploy.service --no-pager
sudo find /var/lib/smarthome-deploy /var/lib/smarthome-system-deploy \
  -maxdepth 1 -type f -print
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
readlink -f /nix/var/nix/profiles/smarthome
```

Save the journal and marker contents before changing state. Secret values must
not be copied into an issue or chat.

## Application rollback

```console
sudo systemctl stop app-deploy.timer system-deploy.timer
sudo systemctl stop app-deploy.service system-deploy.service
systemctl is-active app-deploy.service system-deploy.service
if systemctl cat house-automationd.service >/dev/null 2>&1; then
  sudo systemctl stop house-automationd.service
fi
sudo install -d -m 0700 /run/smarthome-deploy
nix-env --profile /nix/var/nix/profiles/smarthome --list-generations
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  nix-env --profile /nix/var/nix/profiles/smarthome \
    --switch-generation GENERATION
```

Both deploy services must report `inactive` before switching the profile. The
deployer notices profile drift and refuses to overwrite a manual rollback.
Keep both timers stopped until the cause is known.

SQLite migrations are forward-only. Before starting an older binary, determine
whether the rollback crosses a migration. If it does, or if uncertain, restore
a tested database backup created by that older release. With the daemon stopped,
preserve the newer database and publish the compatible backup atomically:

```console
compatible_backup=/srv/backup/COMPATIBLE-house-automation-state.sqlite3
sudo test -f "$compatible_backup"
sudo /run/current-system/sw/bin/bash -eu -c '
  state=/var/lib/house-automation
  backup=$1
  archive="$state/pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  restore="$state/.state.sqlite3.restore.$$"
  trap '\''rm -f -- "$restore"'\'' EXIT
  install -d -o house-automation -g house-automation -m 0700 "$archive"
  shopt -s nullglob
  current=("$state"/state.sqlite3 "$state"/state.sqlite3-wal \
    "$state"/state.sqlite3-shm)
  for file in "${current[@]}"; do
    [ ! -e "$file" ] || mv -- "$file" "$archive/"
  done
  install -o house-automation -g house-automation -m 0600 \
    "$backup" "$restore"
  mv -f -- "$restore" "$state/state.sqlite3"
  trap - EXIT
' _ "$compatible_backup"
```

If no compatible backup exists, keep the old daemon stopped and repair forward;
do not let an older binary open the newer database. Otherwise validate the
rolled-back app:

```console
if systemctl cat house-automationd.service >/dev/null 2>&1; then
  sudo systemctl restart house-automationd.service
  curl --fail-with-body http://127.0.0.1:9876/healthz
else
  readlink -f /nix/var/nix/profiles/smarthome
fi
```

If house topology is not enabled, `house-automationd.service` and its health
endpoint are intentionally absent; the branch verifies the profile path.

Manual rollback is an intentional latch. To resume automatic deployment, first
merge and promote a fixed descendant. Then briefly restore the exact path in
`last-success`, validate it, and immediately trigger the fixed release:

```console
app_last_good="$(sudo sed -n 's/^path=//p' \
  /var/lib/smarthome-deploy/last-success)"
test -x "$app_last_good/bin/house-automationd"
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  nix-env --profile /nix/var/nix/profiles/smarthome --set "$app_last_good"
if systemctl cat house-automationd.service >/dev/null 2>&1; then
  sudo systemctl restart house-automationd.service
  curl --fail-with-body http://127.0.0.1:9876/healthz
fi
sudo systemctl start app-deploy.timer system-deploy.timer
sudo systemctl start app-deploy.service system-deploy.service
```

Do not edit `last-success`: its exact revision/path pair is the monotonic trust
anchor. If restoring that path is unsafe, leave both timers stopped and repair
forward under operator control.

## System rollback

From a running system:

```console
sudo systemctl stop app-deploy.timer system-deploy.timer
sudo systemctl stop app-deploy.service system-deploy.service
systemctl is-active app-deploy.service system-deploy.service
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
sudo systemctl start app-deploy.timer system-deploy.timer
sudo systemctl start app-deploy.service system-deploy.service
```

The fixed release must descend from the last successful revision. Do not edit
the marker. If restoring its path is unsafe, keep both timers stopped and
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

After every recovery, reboot once and verify SSH over Tailscale, both timers,
mounts, profiles, Mosquitto, Zigbee2MQTT, application health when configured,
and zero failed units.
