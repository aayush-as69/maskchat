#!/usr/bin/env sh
set -eu

: "${POSTGRES_URL:?POSTGRES_URL is required}"
FILE="${1:?usage: restore-postgres.sh /path/to/maskchat-*.dump}"
CONFIRM="${CONFIRM_RESTORE:-NO}"
if [ "$CONFIRM" != "YES" ]; then
  echo "Refusing destructive restore. Set CONFIRM_RESTORE=YES after verifying the backup and target database." >&2
  exit 2
fi

"$(dirname "$0")/verify-backup.sh" "$FILE"
echo "Restoring $FILE into the configured PostgreSQL database..."
pg_restore "$POSTGRES_URL" --clean --if-exists --no-owner --no-privileges "$FILE"
echo "Restore completed. Run application readiness and smoke tests before reopening traffic."
