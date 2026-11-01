# Deployment: pont.example.com

Runs on `your-server` behind nginx, the same way as the other sites there.

| What | Where |
|---|---|
| App code (one folder per release) | `/opt/pont/releases/<commit>/server`, `current` points at the live one |
| Database and photos | `/var/lib/pont/` (owner `pont`, mode 700) |
| Settings and secrets | `/etc/pont/env` (see `env.example`) |
| Service | `pont-atm.service` (user `pont`, listens on `127.0.0.1:3000` only) |
| nginx | `/etc/nginx/sites-available/pont.example.com`, linked from `sites-enabled` |
| Certificate | certbot, RSA key (the readers need RSA), renews by itself and reloads nginx |
| Android apps | `/var/lib/pont/downloads/` (published with `deploy/publish-apps.sh`), offered at `https://pont.example.com/app` |

## Update the server

From the repository, on the commit to deploy (the working tree must be clean):

```sh
SHA=$(git rev-parse --short HEAD); H=root@your-server
ssh $H "mkdir -p /opt/pont/releases/$SHA"
git archive --format=tar HEAD server | ssh $H "tar -x -C /opt/pont/releases/$SHA && chown -R pont:pont /opt/pont/releases/$SHA"
ssh $H "cd /opt/pont/releases/$SHA/server && runuser -u pont -- env HOME=/var/lib/pont sh -c 'npm ci && npm run build && npx vitest run && npm prune --omit=dev' \
  && rm -rf test vitest.config.ts && chown -R root:root .. && chmod -R go-w .. \
  && ln -sfn /opt/pont/releases/$SHA /opt/pont/current && systemctl restart pont-atm && sleep 2 && systemctl is-active pont-atm"
```

To go back, point `current` at the previous release folder and restart the service. The database is never touched by an update (new columns are added when the server starts).

## Publish the Android apps

Two apps are offered at `https://pont.example.com/app`: **Pont Card** (for card holders, module `:user`, shown first and big) and **Pont Terminal** (for staff phones, module `:app`). One command builds both for the server, signs them and uploads them:

```sh
deploy/publish-apps.sh            # build, sign, upload, then download them again to check
deploy/publish-apps.sh --dry-run  # build and sign only
```

The files go to `/var/lib/pont/downloads/` (`pont-card.apk`, `pont-terminal.apk`) and `apps.json` is written last; the page reads it to show the version, size and checksum. The page is served by the app itself, so nothing is needed in nginx.

**Keep `~/.config/pont-atm/release.keystore` and its password file safe and backed up.** Phones only accept an update signed with the same key: if it is lost, every phone has to uninstall and reinstall the apps.

## Readers

Set `SERVER_URL "https://pont.example.com"` in `firmware/esp32-reader/include/config.h`, then write one board with `pio run -t upload`, or many with `firmware/esp32-reader/tools/flash-many.sh`.
The readers trust Let's Encrypt's ISRG Root X1 (`include/root_ca.h`). The server's certificate chains to it through Let's Encrypt's cross-signed "Root YR", whose cross-signature runs out on 2032-09-02: before then, add Let's Encrypt's own Root YR to `root_ca.h` and reflash the readers.
