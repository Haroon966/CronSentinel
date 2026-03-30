#!/bin/sh
set -e
cd /app
# Bind-mounted source can update package-lock.json while /app/node_modules is a Docker volume
# from an older image — then new npm deps are missing. Re-sync when the lock changes.
LOCK=/app/package-lock.json
STAMP=/app/node_modules/.package-lock.sha256
if [ ! -f "$LOCK" ]; then
  echo "docker-entrypoint-dev: package-lock.json not found in /app" >&2
  exit 1
fi
CUR="$(sha256sum "$LOCK" | awk '{print $1}')"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$CUR" ]; then
  echo "docker-entrypoint-dev: installing deps (package-lock.json new or changed)..."
  npm ci
  printf '%s\n' "$CUR" > "$STAMP"
fi
exec "$@"
