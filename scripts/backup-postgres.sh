#!/usr/bin/env sh
set -eu

: "${POSTGRES_URL:?POSTGRES_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/maskchat-$STAMP.dump"
SHA="$OUT.sha256"

umask 077
printf '%s\n' "Creating PostgreSQL backup: $OUT"
pg_dump "$POSTGRES_URL" --format=custom --no-owner --no-privileges --file="$OUT"
sha256sum "$OUT" > "$SHA"

find "$BACKUP_DIR" -type f -name 'maskchat-*.dump' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -type f -name 'maskchat-*.dump.sha256' -mtime "+$RETENTION_DAYS" -delete

if [ -n "${BACKUP_UPLOAD_COMMAND:-}" ]; then
  # Example: BACKUP_UPLOAD_COMMAND='rclone copy "$1" remote:maskchat/'
  # The command receives the dump path as $1. Keep cloud credentials outside git.
  sh -c "$BACKUP_UPLOAD_COMMAND" -- "$OUT"
fi

echo "Backup and checksum created: $OUT"
