#!/usr/bin/env bash
# scripts/backup.sh — nightly via cron on the VPS. Restore procedure: docs/betrieb.md
#
# Usage: OFFSITE_TARGET=... ./scripts/backup.sh
#   Production (Hetzner Storage Box over ssh): OFFSITE_TARGET=u123@u123.your-storagebox.de:
#   Local test (plain rsync path):             OFFSITE_TARGET=/tmp/archiv-offsite/
#   (OFFSITE_TARGET is used as a literal rsync destination prefix — include the trailing ":"
#   for a remote-shell target or "/" for a local path; this is what lets the same script and
#   the same cron line work for both, see betrieb.md.)
# Run from the repo directory (e.g. /opt/archiv) so `$(basename "$PWD")` matches the compose
# project name and therefore the actual docker volume name for uploads.
set -euo pipefail

: "${OFFSITE_TARGET:?Set OFFSITE_TARGET, e.g. u123@u123.your-storagebox.de: or a local path for testing}"

STAMP=$(date +%F)
BACKUP_DIR=/var/backups/archiv
mkdir -p "$BACKUP_DIR"

docker compose exec -T db pg_dump -U archiv archiv | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

# uploads: rsync the docker volume to the offsite target (Hetzner Storage Box via ssh)
rsync -az "/var/lib/docker/volumes/$(basename "$PWD")_uploads/_data/" \
  "${OFFSITE_TARGET}backups/archiv/uploads/"
rsync -az "$BACKUP_DIR/" "${OFFSITE_TARGET}backups/archiv/db/"

# keep 30 days locally
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +30 -delete
