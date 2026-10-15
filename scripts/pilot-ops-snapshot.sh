#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
OUTPUT_FILE="${OUTPUT_FILE:-pilot-operations.json}"

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "ADMIN_TOKEN is required." >&2
  exit 2
fi

curl --fail --silent --show-error \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -H 'accept: application/json' \
  "${BASE_URL%/}/api/admin/pilot/operations" > "$OUTPUT_FILE"

echo "Pilot operations snapshot written to $OUTPUT_FILE"
