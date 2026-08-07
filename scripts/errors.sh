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
    # Curated view: only our own telemetry lines (one per error, has errorId). Payload's pino
    # logger ("level":"error"/"level":50) emits its own line for the same error, so matching
    # both level patterns here would double-report every incident.
    if ! logs="$(docker compose logs app --no-log-prefix --since "${hours}h" 2>&1)"; then
      echo "docker compose logs fehlgeschlagen" >&2
      exit 1
    fi
    matches="$(grep -F '"errorId":"' <<< "$logs" || true)"
    if [ -z "$matches" ]; then
      echo "keine Fehler in den letzten ${hours}h"
    else
      jq -r '[.time, .errorId // "-", .msg, (.path // .url // "-")] | @tsv' <<< "$matches"
    fi
    ;;
  tail)
    # Live firehose: both our telemetry lines and Payload's own error-level lines, unfiltered.
    # No --line-buffered: BusyBox grep (Alpine) lacks the flag, and terminal stdout is
    # line-buffered by default anyway, so output still streams line-by-line.
    docker compose logs app --no-log-prefix -f 2>/dev/null | grep -E '"level":"error"|"level":50'
    ;;
  *)
    # treat as Fehler-ID
    docker compose logs app --no-log-prefix 2>/dev/null | grep -F "\"errorId\":\"$cmd\"" | jq . 2>/dev/null \
      || { echo "Fehler-ID $cmd nicht gefunden (Log evtl. rotiert)"; exit 1; }
    ;;
esac
