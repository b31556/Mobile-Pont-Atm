#!/usr/bin/env bash
# Runs the Pont ATM server in the foreground (Ctrl+C stops it).
# Settings (JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, PORT, HOST, DB_PATH) come from ~/.config/pont-atm/env,
# the same file the systemd service uses. Builds first when the compiled code is missing or older than the source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PONT_ENV:-$HOME/.config/pont-atm/env}"
cd "$ROOT/server"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE (needs JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, and optionally PORT, HOST, DB_PATH)" >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

if systemctl --user is-active --quiet pont-atm 2>/dev/null; then
  echo "The pont-atm service is already running. Stop it first: systemctl --user stop pont-atm" >&2
  exit 1
fi

if [ ! -d node_modules ]; then npm ci; fi
if [ ! -f dist/index.js ] || [ -n "$(find src -newer dist/index.js -type f -print -quit)" ]; then
  npm run build
fi

echo "Pont ATM on http://${HOST:-127.0.0.1}:${PORT:-3000}  (display pages: /display, admin: /admin)"
exec node dist/index.js
