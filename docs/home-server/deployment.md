# Home-server deployment

CI publishes and verifies the NixOS closure for `nixosConfigurations.home-server`
and fast-forwards `release/home-server`. The host's `system-deploy.service`
polls that ref and is guarded by `system-deploy.timer`.

Useful diagnostics:

```console
systemctl status system-deploy.timer system-deploy.service --no-pager
journalctl -b -u system-deploy.service --no-pager
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
```

The system deployer uses the project and official Nix caches with pinned trust
keys, and never enables Nix builders on the host.
