#!/usr/bin/env bash
# Run the app in production on a VPS.
#
#   ./scripts/prod.sh
#
# NODE_ENV=production turns OFF Bun's browser dev server / HMR surface (so the
# /_bun/* dev endpoints and source aren't exposed) while still serving the
# bundled SPA + API. APP_ENV=prod selects data/prod/db.sqlite3 + .env.prod.
# Override any of these inline, e.g.:
#   PORT=8080 ./scripts/prod.sh
set -euo pipefail

# Run from the project root regardless of where the script is invoked.
cd "$(dirname "$0")/.."

export NODE_ENV="${NODE_ENV:-production}"
export APP_ENV="${APP_ENV:-prod}"
export PORT="${PORT:-3001}"

echo "[prod] NODE_ENV=$NODE_ENV APP_ENV=$APP_ENV PORT=$PORT"
exec bun --hot main.ts
