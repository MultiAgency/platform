#!/bin/sh
# Starts the platform: the headless gateway, which runs each hosted agent's server beside it.
# The volume holds all state in /data/state; the app stays in /app. Nothing here ever overwrites state.
set -eu
umask 077
APP=${APP_DIR:-/app}
STATE=${DATA_DIR:-/data}/state
mkdir -p "$STATE"
cd "$STATE"
exec "$APP/node_modules/.bin/tsx" "$APP/src/gateway/server.ts"
