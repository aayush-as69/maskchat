#!/usr/bin/env sh
set -eu

FILE="${1:?usage: verify-backup.sh /path/to/maskchat-*.dump}"
SHA="$FILE.sha256"
[ -f "$FILE" ] || { echo "Backup not found: $FILE" >&2; exit 1; }
[ -f "$SHA" ] || { echo "Checksum not found: $SHA" >&2; exit 1; }
sha256sum -c "$SHA"

# pg_restore --list validates the custom-format archive without changing a database.
pg_restore --list "$FILE" >/dev/null
echo "Backup archive is readable and checksum-valid: $FILE"
