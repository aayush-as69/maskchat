#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:=http://localhost:3001}"
: "${ADMIN_TOKEN:?Set ADMIN_TOKEN for the pilot preflight.}"

fail=0
check() {
  local label="$1" url="$2"
  echo "== $label =="
  if ! curl -fsS --max-time 10 "$url" >/tmp/maskchat-preflight.json; then
    echo "FAIL: $url"
    fail=1
  else
    echo "PASS"
  fi
}

check "readiness" "$BASE_URL/api/ready"
check "pilot status" "$BASE_URL/api/pilot/status"

if ! curl -fsS --max-time 10 -H "x-admin-token: $ADMIN_TOKEN" "$BASE_URL/api/admin/pilot" >/tmp/maskchat-admin-pilot.json; then
  echo "FAIL: admin pilot endpoint"
  fail=1
else
  echo "PASS: admin pilot endpoint"
fi

if [ "$fail" -ne 0 ]; then
  echo "Pilot preflight FAILED."
  exit 1
fi

echo "Pilot preflight passed."
