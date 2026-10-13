# Deployment

GitHub builds; `home-server` only fetches, verifies, and activates. The system
track is:

- System: `nixosConfigurations.home-server.config.system.build.toplevel` →
  `release/home-server` → `/nix/var/nix/profiles/system`; state is
  `/var/lib/smarthome-system-deploy`.

Each main workflow builds the exact root, pushes its recursive closure in
bounded batches, proves the root is signed by the project cache, realizes the
full closure from the project and official NixOS caches with builders disabled,
then fast-forwards the release ref. Failed build, publication, or verification
leaves the old release ref unchanged.

On the server, the deployer fetches the public repository over HTTPS and holds
`/run/smarthome-deploy/deploy.lock`. It rejects a release ref outside `main`,
rejects release revisions that rewind the last successful revision, hydrates only
closures signed by the pinned cache keys, and retains at most two profile
generations.

Before a system candidate is switched, the activator records
`/var/lib/smarthome-system-deploy/pending-activation`. Failed or interrupted
candidates return to the exact old generation. Successful activation commits
the journal to `last-success`. A later poll performs recovery before fetching or
evaluating another revision.

## Status and manual trigger

```console
systemctl status system-deploy.timer --no-pager
sudo systemctl start system-deploy.service
journalctl -u system-deploy.service -n 200 --no-pager
sudo cat /var/lib/smarthome-system-deploy/last-success
sudo nix-env --profile /nix/var/nix/profiles/system --list-generations
```

The timer runs three minutes after boot, then every 15
minutes. It is persistent, so a missed run is retried after boot. Replaying
an already successful revision is a no-op.

`last-success` records exact `rev`, `path`, previous path, and previous
generation. Compare `rev` with `release/home-server` and `path` with
the active profile. Do not treat `main` as deployed until the promoted ref and
marker both advance.

## Failures and poison

Network, GitHub, or cache failures do not change a profile. Wait for the next
timer or trigger the service after the external problem is fixed. Do not enable
builders or fallback.

An unhealthy candidate is rolled back and recorded in `last-failure`. A
revision whose marker says `reason=candidate-health-failed` and
`rollback=complete` is poisoned: repeat polls refuse it instead of repeatedly
disrupting services. Inspect the journal and marker first. Normal repair is a
new descendant commit, which produces a new immutable revision.

If failure was conclusively environmental and retrying the *same* immutable
revision is intentional, preserve the evidence while clearing the active
marker:

```console
sudo systemctl stop system-deploy.timer
sudo systemctl stop system-deploy.service
systemctl is-active system-deploy.service
sudo install -d -m 0700 /run/smarthome-deploy
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  /run/current-system/sw/bin/bash -eu -c '
    cp -a /var/lib/smarthome-system-deploy/last-failure \
      /var/lib/smarthome-system-deploy/last-failure.audit
    mv /var/lib/smarthome-system-deploy/last-failure \
      /var/lib/smarthome-system-deploy/last-failure.cleared
  '
sudo systemctl start system-deploy.timer
sudo systemctl start system-deploy.service
```

The service must report `inactive` before marker changes. Never delete
`pending-activation`; it is the crash-recovery journal.

## Disk policy

The server stores no build products beyond substituted closures. Derivations
and outputs are not retained globally. The system profile keeps two
generations; systemd-boot keeps eight boot entries. Daily GC removes unreachable
paths older than 14 days, weekly optimisation deduplicates the store, and Nix's
free-space guard operates between 1 and 5 GiB.

```console
df -h / /nix/store
sudo nix-store --gc --print-roots
systemctl list-timers nix-gc.timer nix-optimise.timer
```

Do not manually delete store paths. If space remains low after normal GC,
inspect roots and mutable service data before changing retention.
