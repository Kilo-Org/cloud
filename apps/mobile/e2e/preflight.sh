#!/usr/bin/env bash
set -euo pipefail

DEVICE="${1:?usage: preflight.sh <device-udid>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

STATUS="$(cd "$REPO_ROOT" && pnpm -s dev:status --json)"
node - "$STATUS" "$REPO_ROOT" <<'NODE'
const [statusJson, expectedRoot] = process.argv.slice(2);
const status = JSON.parse(statusJson);
const required = ['mobile', 'nextjs', 'cloudflare-session-ingest'];
const failed = required.filter(name => status.services.find(service => service.name === name)?.status !== 'up');
if (failed.length) throw new Error(`Required services are not up in ${expectedRoot}: ${failed.join(', ')}`);
NODE

SESSION_INGEST_PORT="$(node - "$STATUS" <<'NODE'
const status = JSON.parse(process.argv[2]);
const port = status.services.find(service => service.name === 'cloudflare-session-ingest')?.port;
if (!port) throw new Error('session-ingest port missing');
process.stdout.write(String(port));
NODE
)"
SESSION_PROBE="$(mktemp)"
trap 'rm -f "$SESSION_PROBE"' EXIT
SESSION_STATUS="$(curl -sS -o "$SESSION_PROBE" -w '%{http_code}' \
  -H 'Authorization: Bearer invalid' "http://127.0.0.1:${SESSION_INGEST_PORT}/api/sessions")"
if [ "$SESSION_STATUS" != "401" ] || ! grep -Fq 'Invalid or expired token' "$SESSION_PROBE"; then
  printf 'session-ingest secret readiness probe failed with HTTP %s\n' "$SESSION_STATUS" >&2
  cat "$SESSION_PROBE" >&2
  exit 1
fi

PLATFORM="ios"
if (cd "$REPO_ROOT" && pnpm -s dev:mobile:android adb devices | awk -v device="$DEVICE" '$1 == device && $2 == "device" { found=1 } END { exit !found }'); then
  PLATFORM="android"
  CLAIM="$(cd "$REPO_ROOT" && pnpm -s dev:mobile:android claim "$DEVICE")"
else
  CLAIM="$(cd "$REPO_ROOT" && pnpm -s dev:mobile:simulator claim "$DEVICE")"
fi
node - "$CLAIM" "$REPO_ROOT" <<'NODE'
const [claimOutput, expectedRoot] = process.argv.slice(2);
const claim = JSON.parse(claimOutput.trim().split('\n').at(-1));
if (claim.worktreeRoot !== expectedRoot) {
  throw new Error(`Device belongs to ${claim.worktreeRoot}, expected ${expectedRoot}`);
}
NODE

MOBILE_LOG="$(cd "$REPO_ROOT" && pnpm -s dev:capture mobile 300)"
if ! grep -Fq "Starting project at $REPO_ROOT/apps/mobile" <<<"$MOBILE_LOG"; then
  printf 'Metro does not belong to this worktree: %s\n' "$REPO_ROOT" >&2
  exit 1
fi
if ! grep -Eq 'iOS Bundled|Starting Metro Bundler' <<<"$MOBILE_LOG"; then
  printf 'Metro has not reached a usable state for %s\n' "$REPO_ROOT" >&2
  exit 1
fi

EXPECTED_API_PORT="$(node - "$STATUS" <<'NODE'
const status = JSON.parse(process.argv[2]);
const port = status.services.find(service => service.name === 'nextjs')?.port;
if (!port) throw new Error('nextjs port missing');
process.stdout.write(String(port));
NODE
)"
if ! grep -Eq "^API_BASE_URL=http://[^:]+:${EXPECTED_API_PORT}$" "$REPO_ROOT/apps/mobile/.env.local"; then
  printf 'apps/mobile/.env.local does not target this worktree nextjs port %s\n' "$EXPECTED_API_PORT" >&2
  exit 1
fi

MOBILE_HOST="$(perl -ne 'print $1 if /^API_BASE_URL=http:\/\/([^:]+):/' "$REPO_ROOT/apps/mobile/.env.local")"
METRO_PORT="$(node - "$STATUS" <<'NODE'
const status = JSON.parse(process.argv[2]);
const port = status.services.find(service => service.name === 'mobile')?.port;
if (!port) throw new Error('mobile port missing');
process.stdout.write(String(port));
NODE
)"
METRO_URL="http://${MOBILE_HOST}:${METRO_PORT}"
MANIFEST="$(mktemp)"
trap 'rm -f "$SESSION_PROBE" "$MANIFEST"' EXIT
curl -sS -H 'expo-platform: ios' -H 'expo-protocol-version: 1' \
  -H 'accept: application/expo+json,application/json' "$METRO_URL" >"$MANIFEST"
node - "$MANIFEST" "http://${MOBILE_HOST}:${EXPECTED_API_PORT}" "$REPO_ROOT" <<'NODE'
const fs = require('node:fs');
const [manifestPath, expectedApiUrl, expectedRoot] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const expoClient = manifest.extra?.expoClient;
if (expoClient?.extra?.apiBaseUrl !== expectedApiUrl) {
  throw new Error(`Metro manifest API URL is ${expoClient?.extra?.apiBaseUrl}, expected ${expectedApiUrl}`);
}
if (expoClient?._internal?.projectRoot !== `${expectedRoot}/apps/mobile`) {
  throw new Error(`Metro manifest belongs to ${expoClient?._internal?.projectRoot}, expected ${expectedRoot}/apps/mobile`);
}
NODE
ENCODED_METRO_URL="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$METRO_URL")"
if [ "$PLATFORM" = "ios" ]; then
  xcrun simctl openurl "$DEVICE" \
    "exp+kilo-app://expo-development-client/?url=${ENCODED_METRO_URL}"
else
  cd "$REPO_ROOT"
  pnpm -s dev:mobile:android adb -s "$DEVICE" reverse "tcp:${EXPECTED_API_PORT}" "tcp:${EXPECTED_API_PORT}"
  pnpm -s dev:mobile:android adb -s "$DEVICE" reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}"
  pnpm -s dev:mobile:android adb -s "$DEVICE" shell am start -a android.intent.action.VIEW \
    -d "exp+kilo-app://expo-development-client/?url=${ENCODED_METRO_URL}" >/dev/null
fi

echo "Mobile E2E preflight passed for $PLATFORM device $DEVICE in $REPO_ROOT ($METRO_URL)"
