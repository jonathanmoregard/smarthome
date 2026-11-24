# Lighting port

The lighting port (`lighting-scripts/`, the TypeScript Home Assistant lighting
controller) runs on the home server as `lighting-port.service`, defined in
[`lighting-port.nix`](../../nixos/modules/lighting-port.nix). The service runs
the port's dev watcher from a git checkout on the server: saving a file under
`src/` recompiles it and restarts the port within a couple of seconds, and a
compile error keeps the last good build running. No deploy and no CI run is
involved in changing the code.

NixOS provides Node 22, the `lighting-port` user and the unit, never the code.

## Where things live

| Path | What |
|---|---|
| `/var/lib/lighting-port/src` | The checkout: a clone of `jonathanmoregard/smarthome` |
| `/var/lib/lighting-port/src/lighting-scripts/.runtime/catalog.json` | The catalog |
| `/var/lib/lighting-port/src/lighting-scripts/.runtime/journal.json` | The journal (and `.lock`) |
| `/var/lib/lighting-port/env` | Which rooms the port may drive |
| `/run/agenix/lighting-port-ha-token` | The Home Assistant token, see [secrets](secrets.md) |

The port reaches Home Assistant at `http://127.0.0.1:8123`.

The service clones the checkout only when `src` does not exist, from the branch
in `services.lighting-port.branch` (today `feature/typescript-lighting-scripts`).
After that the checkout is yours: nothing fetches, pulls or resets it, and
changing the branch option does not touch it. The service runs `npm ci --ignore-scripts` in
`lighting-scripts/` when `node_modules` is missing or `package-lock.json`
changed, on its next start. It runs no dependency install scripts, because
the process can read the Home Assistant token; the port's dependencies have
none.

`/var/lib/lighting-port` belongs to the `lighting-port` group, is setgid and
group-writable, and `jonathan` is a member, so you edit the checkout and the
env file over SSH without sudo. Log in again after the first deploy for the
membership to apply. A directory you create there yourself follows your
umask; run `umask 007` first if the port has to write into it.

### Git and npm run as lighting-port

Run git in the checkout as `lighting-port`, never as yourself:

```sh
sudo -u lighting-port git -C /var/lib/lighting-port/src status
sudo -u lighting-port git -C /var/lib/lighting-port/src \
  -c user.name='Jonathan Moregard' -c user.email='<your address>' commit -am '...'
```

Git refuses to work there as you, on purpose: `lighting-port` (and so the
port's own code) can write the checkout's `.git/config`, and settings there
such as `core.fsmonitor` or hooks run commands as whoever runs git. Do not add
the checkout to your own `safe.directory`.

Run npm there as `lighting-port` too, without install scripts:

```sh
cd /var/lib/lighting-port/src/lighting-scripts
sudo -u lighting-port HOME=/var/lib/lighting-port \
  nix shell nixpkgs#nodejs_22 --command npm install --ignore-scripts <package>
```

npm run as yourself leaves directories in `node_modules` the service cannot
replace. The service then refuses to start and names one; give the tree back
with `sudo chown -R lighting-port:lighting-port
/var/lib/lighting-port/src/lighting-scripts/node_modules`.

## First start

1. Commit the token ciphertext ([secrets](secrets.md#home-assistant-token-for-the-lighting-port))
   and let it deploy. The first deploy clones the checkout and installs its
   dependencies, then the service stops and says what is missing.
2. Stop the port on the laptop. Two ports must never drive the same rooms.
3. Copy the catalog from the laptop into
   `/var/lib/lighting-port/src/lighting-scripts/.runtime/catalog.json`.
   The service creates `.runtime` itself.
4. Create the env file with the rooms the port may drive:

   ```sh
   printf 'LIVE_ROOMS=bedroom\n' > /var/lib/lighting-port/env
   ```

5. Start it: `sudo systemctl restart lighting-port`.

## Rooms

`LIVE_ROOMS` is passed to the port as `--live-rooms`. Moving from the bedroom
to the whole house is an edit and a restart, no deploy:

```sh
printf 'LIVE_ROOMS=all\n' > /var/lib/lighting-port/env
sudo systemctl restart lighting-port
```

`LIVE_ROOMS=` (empty) is the port's own "no rooms": it runs and sends nothing.
A missing env file or a missing `LIVE_ROOMS` line never means any room: the
service refuses to start.

## Operating it

```sh
systemctl status lighting-port          # state and the last log lines
journalctl -u lighting-port -f          # follow the logs
sudo systemctl restart lighting-port    # pick up env-file or dependency changes
```

Code edits need no restart. A restart is needed after changing the env file,
and to install a changed `package-lock.json`.

What the states mean:

1. `active (running)`: the watcher runs.
2. `inactive (dead)` after a line `lighting-port: refusing to start: ...`:
   something only you can fix (env file, `LIVE_ROOMS`, token, catalog,
   `node_modules` the service cannot write, or a checkout without
   `lighting-scripts/package-lock.json`). Fix it and restart. It stays
   stopped until then.
3. `lighting-port: <what> failed; retrying in <n>s (setup failure <k> in a
   row)`: a clone, an `npm ci` or another setup step failed and is retried
   on its own, waiting 10 s, then twice as long each time, at most 5 min.
   A clone that has moved less than 1 KB/s for a minute counts as failed.
   A restart retries at once.
4. `watcher exited with status N; restarting`: the port stopped or crashed
   and is restarted after 10 s.

`systemctl stop lighting-port` lasts until the next boot or deploy, which
start it again. To keep the port off, remove the `LIVE_ROOMS` line. A port
still shutting down 15 s after a stop is killed; the journal is written whole
and renamed into place, so that cannot corrupt it.

The port is not a deploy health unit, and none of these states fails a
deploy: the unit exits 0 when it is retrying or stopped and 78 when it
refuses, so `switch-to-configuration` never sees it failed, and a crashing
port does not roll the server back.

A clone cut short leaves `/var/lib/lighting-port/.src.partial.<time>` behind;
delete it when convenient. To start over from a fresh clone, move `src` aside
and restart.

## Reconciling edits into the repository

Edits made on the server stay on the server until you bring them into the
repository by hand; nothing opens pull requests for them. Commit in the
checkout on a branch (as `lighting-port`, above), write the branch to a
bundle, and fetch it from the bundle on your laptop. A bundle carries only
commits, never the checkout's git configuration:

```sh
ssh -t jonathan@100.87.199.107 'sudo -u lighting-port git -C /var/lib/lighting-port/src \
  bundle create /var/lib/lighting-port/reconcile.bundle <branch>'
scp jonathan@100.87.199.107:/var/lib/lighting-port/reconcile.bundle /tmp/
git fetch /tmp/reconcile.bundle <branch>:<branch>
```

and open a pull request from there as usual. CI checks the pull request; it
never blocks what runs on the server.
