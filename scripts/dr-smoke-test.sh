#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
READY="$(curl -fsS "$BASE_URL/api/ready")"
echo "$READY"
printf '%s' "$READY" | grep -q '"ok":true'
curl -fsS "$BASE_URL/api/health" >/dev/null
echo "DR smoke test passed."
