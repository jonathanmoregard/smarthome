# Deployment

GitHub builds; `home-server` only fetches, verifies, and activates. Application
and system publication are independent:

- App: `packages.x86_64-linux.default` → `release/app` →
  `/nix/var/nix/profiles/smarthome`; state is
  `/var/lib/smarthome-deploy`.
- System: `nixosConfigurations.home-server.config.system.build.toplevel` →
  `release/home-server` → `/nix/var/nix/profiles/system`; state is
  `/var/lib/smarthome-system-deploy`.

Each main workflow builds the exact root, pushes its recursive closure in
bounded batches, proves the root is signed by the project cache, realizes the
full closure from the project and official NixOS caches with builders disabled,
then fast-forwards the release ref. Failed build, publication, or verification
leaves the old release ref unchanged.

On the server, both deployers fetch the public repository over HTTPS and share
`/run/smarthome-deploy/deploy.lock`. They reject a release ref outside `main`,
reject release revisions that rewind the last successful revision, hydrate only
closures signed by the pinned cache keys, and retain at most two profile
generations.

Before an application candidate can open SQLite, the old application creates a
consistent backup in `/var/lib/smarthome-deploy/rollback-database.sqlite3` and
the activator records `/var/lib/smarthome-deploy/pending-activation`. Failed or
interrupted candidates restore that snapshot atomically before restarting the
old binary. Successful activation commits the journal to `last-success` and
removes the temporary backup. A later poll performs recovery before fetching or
evaluating another revision.

## Status and manual trigger

```console
systemctl status app-deploy.timer system-deploy.timer --no-pager
sudo systemctl start app-deploy.service
sudo systemctl start system-deploy.service
journalctl -u app-deploy.service -u system-deploy.service -n 200 --no-pager
sudo cat /var/lib/smarthome-deploy/last-success
sudo cat /var/lib/smarthome-system-deploy/last-success
nix-env --profile /nix/var/nix/profiles/smarthome --list-generations
sudo nix-env --profile /nix/var/nix/profiles/system --list-generations
```

Timers run two and three minutes after boot respectively, then every 15
minutes. They are persistent, so a missed run is retried after boot. Replaying
an already successful revision is a no-op.

`last-success` records exact `rev`, `path`, previous path, and previous
generation. Compare `rev` with the corresponding release ref and `path` with
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
sudo systemctl stop app-deploy.timer system-deploy.timer
sudo systemctl stop app-deploy.service system-deploy.service
systemctl is-active app-deploy.service system-deploy.service
sudo install -d -m 0700 /run/smarthome-deploy
sudo flock --exclusive /run/smarthome-deploy/deploy.lock \
  /run/current-system/sw/bin/bash -eu -c '
    cp -a /var/lib/smarthome-deploy/last-failure \
      /var/lib/smarthome-deploy/last-failure.audit
    mv /var/lib/smarthome-deploy/last-failure \
      /var/lib/smarthome-deploy/last-failure.cleared
  '
sudo systemctl start app-deploy.timer system-deploy.timer
sudo systemctl start app-deploy.service
```

Both services must report `inactive` before marker changes. Use
`/var/lib/smarthome-system-deploy` and trigger `system-deploy.service` instead
only for a system poison. Never delete `pending-activation`; it is the
crash-recovery journal.

## Disk policy

The server stores no build products beyond substituted closures. Derivations
and outputs are not retained globally. App and system profiles each keep two
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
