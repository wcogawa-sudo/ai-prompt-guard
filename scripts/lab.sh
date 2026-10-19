#!/usr/bin/env bash
# Start the Prompt Guard lab: the test Chromium profile (with the extension)
# plus the log collector. Ctrl+C stops the collector; close the browser as usual.
#
#   scripts/lab.sh                 start everything
#   scripts/lab.sh --reset-storage wipe the extension's stored data in the test
#                                  profile first (settings + queue), then start.
#                                  Only works while the test browser is closed.
#
# Env: PG_TOKEN (default lab-test-token)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$HOME/.config/chromium-promptguard-test"
EXT_ID="nkfbgnhhnhdpimbkgkbeddiijbeoklgc"
STORAGE="$PROFILE/Default/Local Extension Settings/$EXT_ID"
export PG_TOKEN="${PG_TOKEN:-lab-test-token}"
export PG_ADMIN_PASSWORD="${PG_ADMIN_PASSWORD:-lab-admin}"   # lab only; the collector listens on 127.0.0.1

browser_running() { pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; }

if [[ "${1:-}" == "--reset-storage" ]]; then
  if browser_running; then
    echo "The test browser is still running. Close it completely, then run this again." >&2
    exit 1
  fi
  if [[ -d "$STORAGE" ]]; then
    rm -rf -- "$STORAGE"
    echo "Extension storage wiped. Re-enter the options (URL, token, name) after the browser opens."
  else
    echo "No extension storage found (already clean)."
  fi
fi

if curl -s -m 2 http://127.0.0.1:8787/health >/dev/null; then
  echo "A collector is already running on :8787. Using it."
  COLLECTOR_RUNNING=1
else
  COLLECTOR_RUNNING=0
fi

if browser_running; then
  echo "Test browser already open."
else
  echo "Opening test browser..."
  chromium --user-data-dir="$PROFILE" >/dev/null 2>&1 &
  disown
fi

if [[ "$COLLECTOR_RUNNING" == 0 ]]; then
  echo "Starting collector (token: $PG_TOKEN). Ctrl+C to stop it."
  echo "Admin dashboard: http://127.0.0.1:8787/admin  (user: admin, password: $PG_ADMIN_PASSWORD)"
  echo "Tip: in another terminal, run 'npm run logs -- --follow' to watch prompts live."
  cd "$ROOT"
  exec node collector/server.js
fi
