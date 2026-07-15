#!/usr/bin/env bash
# Deploy the app to a VPS: rsync the source up, then ssh in to reinstall deps
# and (re)start the server on a fixed port.
# NODE_ENV=production: HMR off — the dev server's hot-reload websocket would
# push page reloads to every open browser whenever the server re-bundles.
#
# Configure the target with env vars (or edit the defaults below):
#   DEPLOY_KEY   path to the SSH private key
#   DEPLOY_HOST  user@host of the VPS
#   DEPLOY_PORT  port the server listens on
#   DEPLOY_DIR   remote directory to deploy into
set -euo pipefail

cd "$(dirname "$0")"

KEY="${DEPLOY_KEY:-$HOME/.ssh/id_rsa}"
HOST="${DEPLOY_HOST:-user@example.com}"
PORT="${DEPLOY_PORT:-3001}"
REMOTE_DIR="${DEPLOY_DIR:-app}"

SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"

echo "[deploy] rsync -> $HOST:$REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude tmp \
  --exclude data/prod \
  -e "$SSH" \
  ./ "$HOST:$REMOTE_DIR/"

echo "[deploy] rebuild + (re)run on :$PORT"
$SSH "$HOST" PORT="$PORT" REMOTE_DIR="$REMOTE_DIR" 'bash -s' <<'REMOTE'
set -euo pipefail

# Ensure bun is on PATH (install once if missing).
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "[remote] installing bun"
  curl -fsSL https://bun.sh/install | bash
fi

cd "$HOME/$REMOTE_DIR"

echo "[remote] bun install"
bun install

# Stop any previous instance bound to this port.
pkill -f "PORT=$PORT bun" 2>/dev/null || true
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT/tcp" 2>/dev/null || true
elif [ -x /usr/sbin/fuser ]; then
  /usr/sbin/fuser -k "$PORT/tcp" 2>/dev/null || true
else
  echo "[remote] fuser not found; cannot kill process on :$PORT" >&2
fi
sleep 1

echo "[remote] starting server on :$PORT"
APP_ENV=prod PORT=$PORT NODE_ENV=production nohup bun main.ts > "$HOME/$REMOTE_DIR/dev.log" 2>&1 &
sleep 2
echo "[remote] running (pid $!), recent log:"
tail -n 15 "$HOME/$REMOTE_DIR/dev.log" || true
REMOTE

echo "[deploy] done -> $HOST:$PORT"
