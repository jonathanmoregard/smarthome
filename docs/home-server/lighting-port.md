# Lighting port

The lighting port (`lighting-scripts/`, the TypeScript Home Assistant lighting
controller) runs on the home server as `lighting-port.service`, defined in
[`lighting-port.nix`](../../nixos/modules/lighting-port.nix). The service runs
the port's dev watcher from a git checkout on the server that follows a
branch of the repository: a push to that branch reaches the server within
about a minute, a changed file under `src/` is recompiled and the port
restarted within a couple of seconds, and a compile error keeps the last good
build running. No deploy, no CI run and no step on the server is involved in
changing the code.

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
in `services.lighting-port.branch` (today `feature/typescript-lighting-scripts`;
`main` once the port is merged). The service runs `npm ci --ignore-scripts` in
`lighting-scripts/` when `node_modules` is missing or `package-lock.json`
changed, on its next start. It runs no dependency install scripts, because
the process can read the Home Assistant token; the port's dependencies have
none.

`/var/lib/lighting-port` belongs to the `lighting-port` group, is setgid and
group-writable, and `jonathan` is a member, so you write the env file and the
catalog over SSH without sudo. Log in again after the first deploy for the
membership to apply.

## Following the branch

`lighting-port-follow.timer` runs `lighting-port-follow.service` every
minute. It fetches the branch from the checkout's `origin` and, when the
checkout is anywhere else, forces it there (`git checkout --force -B`):

1. A push reaches the server within about a minute. The watcher picks up
   changes under `lighting-scripts/src/` by itself. When the update changes
   anything else under `lighting-scripts/` (`scripts/`, `package.json`,
   `tsconfig.json`, ...), or `package-lock.json` differs from what is
   installed, the follower restarts `lighting-port.service`, which installs
   the dependencies again if needed. It never restarts it while an install
   runs, nor before the checkout has got through: a checkout that keeps
   failing (a directory it cannot write, a full disk) is logged every run
   and restarts nothing until it succeeds.
2. The checkout is not edited on the server. On the next run, local edits to
   tracked files are discarded (the journal lists the files), and a local
   commit or a checked-out local branch is left behind for the followed
   branch. Untracked and ignored files stay:
   `.runtime/` (catalog, journal) and `node_modules` are never touched.
3. Changing `services.lighting-port.branch` switches the checkout to the new
   branch on the first run after the deploy.
4. A fetch that fails (GitHub or the network down) is logged and tried again
   next minute. A run is stopped after 150 s, and a git lock that a killed
   run left behind is moved aside to `/var/lib/lighting-port/.stale-git-locks`
   once it is 5 minutes old. Git's own upkeep (`git maintenance run --auto`)
   runs at the end of a run, in the foreground, when git finds it due. The
   follower never ends `failed`, and it is not a deploy health unit.
5. A branch that no longer exists on origin freezes the checkout where it is,
   and every run logs `branch <name> no longer exists on origin`. When the
   port's pull request is merged and `feature/typescript-lighting-scripts` is
   deleted, set `services.lighting-port.branch = "main"` in the same change
   (or before deleting the branch); until that deploys, pushes reach nothing.

```sh
journalctl -u lighting-port-follow -f              # what it fetched, discarded, restarted
sudo systemctl stop lighting-port-follow.timer     # pause following
sudo systemctl start lighting-port-follow.timer    # resume
sudo -u lighting-port git -C /var/lib/lighting-port/src log -1 --oneline   # what runs
```

A stopped timer stays stopped until the next boot or a deploy that starts it.

Run git in the checkout as `lighting-port`, never as yourself. Git refuses to
work there as you, on purpose: `lighting-port` (and so the port's own code)
can write the checkout's `.git/config`, and settings there such as
`core.fsmonitor` or hooks run commands as whoever runs git. Do not add the
checkout to your own `safe.directory`.

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
sudo systemctl restart lighting-port    # pick up env-file changes
```

Pushed code needs no restart: the watcher, or the follower (above), sees to
it. A restart is needed after changing the env file.

What the states mean:

1. `active (running)`: the watcher runs.
2. `inactive (dead)` after a line `lighting-port: refusing to start: ...`:
   something only you can fix (env file, `LIVE_ROOMS`, token, a catalog
   missing or not readable by the service, `node_modules` it cannot write,
   or a checkout without
   `lighting-scripts/package-lock.json`). Fix it and restart. It stays
   stopped until then.
3. `lighting-port: <what> failed; retrying in <n>s (setup failure <k> in a
   row)`: a clone, an `npm ci` or another setup step failed and is retried
   on its own, waiting 10 s, then twice as long each time, at most 5 min.
   A clone that has moved less than 1 KB/s for a minute counts as failed.
   A restart retries at once.
4. `watcher exited with status N after <t>s; retrying in <n>s (watcher exit
   <k> in a row)`: the port exited. It crashed, or refused something only
   you can fix (a room in `LIVE_ROOMS` the house does not have, a catalog it
   rejects, a revoked token); the lines before say which. The service cannot
   tell these apart, so it never stops for them: it restarts the port with
   the same backoff as a failed setup step, and the count starts over once
   the port has run 5 minutes.

`systemctl stop lighting-port` lasts until the next boot or deploy, which
start it again. To keep the port off, remove the `LIVE_ROOMS` line. A port
still shutting down 15 s after a stop is killed; the journal is written whole
and renamed into place, so that cannot corrupt it.

The port is not a deploy health unit, and none of these states fails a
deploy: the unit exits 0 when it is retrying or stopped and 78 when it
refuses, so `switch-to-configuration` never sees it failed, and a crashing
port does not roll the server back.

A clone cut short leaves `/var/lib/lighting-port/.src.partial.<time>` behind;
delete it when convenient.

To start over from a fresh clone (a broken `.git`, say), move `src` aside.
The catalog and the journal live in the old checkout's `.runtime`, so carry
them into the new one:

```sh
sudo systemctl stop lighting-port
mv /var/lib/lighting-port/src /var/lib/lighting-port/src.old
sudo systemctl start lighting-port
```

The service clones and installs again, then stops with `refusing to start:
.../.runtime/catalog.json does not exist`. Then:

```sh
mv /var/lib/lighting-port/src.old/lighting-scripts/.runtime/* \
  /var/lib/lighting-port/src/lighting-scripts/.runtime/
sudo systemctl restart lighting-port
```

Move them, do not copy them: a copy is yours, with your umask, and the service
may not be able to read or replace it. Delete `src.old` once the new
checkout runs.
