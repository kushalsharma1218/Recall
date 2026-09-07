#!/usr/bin/env bash
# Runs every test layer. Starts the backend and a static server if they are not already up.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
STARTED_BACKEND=0
STARTED_FRONTEND=0

cleanup() {
  [ "$STARTED_BACKEND" = 1 ] && pkill -f 'spring-boot:run' >/dev/null 2>&1
  [ "$STARTED_FRONTEND" = 1 ] && pkill -f 'http.server 4173' >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

echo "=== [1/3] Backend: unit, contract, robustness, backtest ==="
( cd "$ROOT/spring-backend" && mvn -B test ) || exit 1

echo
echo "=== [2/3] Starting services for end-to-end ==="
if ! curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; then
  ( cd "$ROOT/spring-backend" && nohup mvn -B spring-boot:run >/tmp/recall-backend.log 2>&1 & )
  STARTED_BACKEND=1
  for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1 && break; sleep 2; done
fi
curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1 || { echo "backend did not start; see /tmp/recall-backend.log"; exit 1; }

if ! curl -sf http://127.0.0.1:4173/ >/dev/null 2>&1; then
  ( python3 -m http.server 4173 --directory "$ROOT/frontend" >/tmp/recall-frontend.log 2>&1 & )
  STARTED_FRONTEND=1
  sleep 2
fi

echo
echo "=== [3/3] End-to-end journeys ==="
( cd "$ROOT/frontend/e2e" && { [ -d node_modules ] || npm install --silent; } && node journeys.mjs ) || exit 1
