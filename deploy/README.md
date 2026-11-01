# Deploying Pont

Pont is one Node process (the server, with its admin site and public pages) behind a reverse proxy. These notes use made-up names: replace `pont.example.com` with your own address and `deploy@your-server` with the account you use to log in to the machine.

The layout used here is only a suggestion:

| What | Where |
|---|---|
| App code (one folder per release) | `/opt/pont/releases/<commit>/server`, with `current` pointing at the live one |
| Database, photos and downloads | `/var/lib/pont/` (owned by the service user, mode 700) |
| Settings and secrets | `/etc/pont/env` (see `env.example`; never commit the real file) |
| Service | `pont.service.example`: runs as its own user and listens on `127.0.0.1` only |
| Reverse proxy | `nginx.example.conf`: https, and the WebSocket and live display streams passed through |
| Certificate | Let's Encrypt with an RSA key (the ESP32 readers need RSA) |
| Android apps | `<data folder>/downloads/`, published with `deploy/publish-apps.sh` and offered at `/app` |

## Update the server

From the repository, on the commit to deploy (the working tree must be clean):

```sh
SHA=$(git rev-parse --short HEAD); H=deploy@your-server
ssh $H "mkdir -p /opt/pont/releases/$SHA"
git archive --format=tar HEAD server | ssh $H "tar -x -C /opt/pont/releases/$SHA"
ssh $H "cd /opt/pont/releases/$SHA/server && npm ci && npm run build && npx vitest run && npm prune --omit=dev \
  && ln -sfn /opt/pont/releases/$SHA /opt/pont/current && sudo systemctl restart pont"
```

To go back, point `current` at the previous release folder and restart the service. The database is never touched by an update (new columns are added when the server starts).

## Publish the Android apps

`deploy/publish-apps.sh` builds the apps for your server, signs them with your release key and uploads them to the downloads folder, then downloads them again to check. It has no built-in server: tell it where to go with `--host` and `--url`, with the variables `PONT_HOST`, `PONT_URL` and `PONT_REMOTE_DIR`, or in a file called `private/deploy.env` (the `private/` folder is ignored by git, so your real server details never get committed).

```sh
deploy/publish-apps.sh --host deploy@your-server --url https://pont.example.com --remote-dir /var/lib/pont/downloads
deploy/publish-apps.sh --dry-run   # build and sign only
```

`apps.json` is written last, so the page never points at a file that is not there yet. The release key (a keystore and its password file, kept outside the repository; set `KEYSTORE` and `KEYPASS_FILE`) must be kept safe and backed up: phones only accept an update signed with the same key.

## Readers

Set `SERVER_URL` in `firmware/esp32-reader/include/config.h` to your https address, then write one board with `pio run -t upload`, or many with `firmware/esp32-reader/tools/flash-many.sh`.
The readers trust Let's Encrypt's ISRG Root X1 (`include/root_ca.h`). The server's certificate chains to it through Let's Encrypt's cross-signed "Root YR", whose cross-signature runs out on 2032-09-02: before then, add Let's Encrypt's own Root YR to `root_ca.h` and reflash the readers.
