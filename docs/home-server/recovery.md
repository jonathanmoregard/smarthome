# Recovery and rollback

System activation records the previous generation and runs sustained health
checks. A failed candidate is rolled back transactionally; an operator-selected
rollback is preserved until a descendant release is promoted.

```console
systemctl --failed
systemctl status system-deploy.service --no-pager
journalctl -b -u system-deploy.service --no-pager
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
```

For a deliberate local rollback:

```console
sudo nixos-rebuild switch --rollback --fast
systemctl is-active sshd tailscaled mosquitto
systemctl --failed
```

Keep the Zigbee channel, PAN ID, extended PAN ID, and encrypted network key
unchanged. Restore `/var/lib/zigbee2mqtt`, `/var/lib/mosquitto`, and agenix
ciphertext only from a tested matching backup.
