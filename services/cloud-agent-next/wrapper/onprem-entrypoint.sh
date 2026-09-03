#!/bin/sh
set -eu
umask 077

: "${SANDBOX_CONTROL_URL:?Missing sandbox control URL}"
: "${SANDBOX_CONTROL_CREDENTIAL:?Missing sandbox control credential}"
: "${PROVIDER_INSTANCE_ID:?Missing provider instance ID}"
: "${KILO_ONPREM_BROKER_URL:?Missing on-prem broker URL}"
: "${KILO_ONPREM_HARD_STOP_AT:?Missing on-prem hard deadline}"
case "$KILO_ONPREM_HARD_STOP_AT" in
    ''|*[!0-9]*)
        printf '%s\n' 'On-prem hard deadline is invalid' >&2
        exit 1
        ;;
esac
if [ "${#KILO_ONPREM_HARD_STOP_AT}" -gt 16 ] || [ "$KILO_ONPREM_HARD_STOP_AT" -le "$(date +%s%3N)" ]; then
    printf '%s\n' 'On-prem hard deadline is invalid or expired' >&2
    exit 1
fi

public_ca="${KILO_ONPREM_CA_CERT:-/etc/kilo-onprem/ca.crt}"
if [ ! -r "$public_ca" ] || ! grep -q -- '-----BEGIN CERTIFICATE-----' "$public_ca"; then
    printf '%s\n' 'On-prem public CA certificate is unavailable' >&2
    exit 1
fi
if grep -q -- 'PRIVATE KEY' "$public_ca"; then
    printf '%s\n' 'On-prem CA mount must contain public certificates only' >&2
    exit 1
fi

mkdir -p "$HOME" /var/cache/kilo/pnpm-store
bundle_dir="$(mktemp -d /tmp/kilo-onprem-ca.XXXXXX)"
bundle="$bundle_dir/ca-bundle.crt"
cat /etc/ssl/certs/ca-certificates.crt "$public_ca" > "$bundle"

export NODE_EXTRA_CA_CERTS="$public_ca"
export SSL_CERT_FILE="$bundle"
export GIT_SSL_CAINFO="$bundle"
export CURL_CA_BUNDLE="$bundle"

remaining_seconds=$(( (KILO_ONPREM_HARD_STOP_AT - $(date +%s%3N)) / 1000 ))
if [ "$remaining_seconds" -le 0 ]; then
    printf '%s\n' 'On-prem hard deadline expired before launch' >&2
    exit 1
fi
exec timeout --signal=TERM --kill-after=5 "$remaining_seconds" /usr/local/bin/bun /usr/local/bin/kilocode-control-wrapper.js
