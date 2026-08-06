#!/usr/bin/env bash
# Query the app's structured error logs. Run from the repo directory on the server.
#   scripts/errors.sh recent [hours]   errors of the last N hours (default 24)
#   scripts/errors.sh <fehler-id>      every log line for one Fehler-ID
#   scripts/errors.sh tail             follow error output live
# Requires jq (apt/apk install jq). Log storage: Docker json-file driver with rotation
# (docker-compose.yml), so history is bounded but survives restarts.
set -euo pipefail
cd "$(dirname "$0")/.."
cmd="${1:-recent}"
case "$cmd" in
  recent)
    hours="${2:-24}"
    docker compose logs app --no-log-prefix --since "${hours}h" 2>/dev/null \
      | grep -E '"level":"error"|"level":50' \
      | jq -r '[.time, .errorId // "-", .msg, (.path // .url // "-")] | @tsv' 2>/dev/null \
      || echo "keine Fehler in den letzten ${hours}h"
    ;;
  tail)
    docker compose logs app --no-log-prefix -f 2>/dev/null | grep --line-buffered -E '"level":"error"|"level":50'
    ;;
  *)
    # treat as Fehler-ID
    docker compose logs app --no-log-prefix 2>/dev/null | grep -F "\"errorId\":\"$cmd\"" | jq . 2>/dev/null \
      || { echo "Fehler-ID $cmd nicht gefunden (Log evtl. rotiert)"; exit 1; }
    ;;
esac
