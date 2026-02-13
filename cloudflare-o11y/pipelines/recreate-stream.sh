#!/usr/bin/env bash
#
# Recreates a Cloudflare Pipeline stream with an updated schema.
#
# Streams are immutable — changing the schema requires deleting and recreating
# the stream (and its pipeline). This script automates the full cycle:
#   1. Look up current stream/pipeline IDs by name
#   2. Delete the pipeline, then the stream (via CF API to skip interactive prompts)
#   3. Create new stream with the schema file
#   4. Create new pipeline with the same SQL
#   5. Update the stream ID in wrangler.jsonc
#   6. Deploy the worker
#
# Usage:
#   ./pipelines/recreate-stream.sh <stream-name> <schema-file> <pipeline-name> <sink-name> <binding-name>
#
# Example:
#   ./pipelines/recreate-stream.sh \
#     o11y_api_metrics_stream \
#     pipelines/api-metrics-schema.json \
#     o11y_api_metrics_pipeline \
#     o11y_api_metrics_sink \
#     API_METRICS_STREAM
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN env var (or wrangler OAuth already configured)
#   - Run from the cloudflare-o11y/ directory

set -euo pipefail

STREAM_NAME="${1:?Usage: $0 <stream-name> <schema-file> <pipeline-name> <sink-name> <binding-name>}"
SCHEMA_FILE="${2:?Missing schema file path}"
PIPELINE_NAME="${3:?Missing pipeline name}"
SINK_NAME="${4:?Missing sink name}"
BINDING_NAME="${5:?Missing binding name}"

ACCOUNT_ID="e115e769bcdd4c3d66af59d3332cb394"
CF_API="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pipelines/v1"

if [[ ! -f "$SCHEMA_FILE" ]]; then
	echo "Error: schema file not found: $SCHEMA_FILE" >&2
	exit 1
fi

# Resolve API token: prefer env var, fall back to wrangler's stored OAuth token
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
	AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
else
	echo "CLOUDFLARE_API_TOKEN not set; trying wrangler OAuth token..."
	# Run whoami to trigger a token refresh if the stored token is expired
	npx wrangler whoami > /dev/null 2>&1 || true
	WRANGLER_CONFIG="${HOME}/Library/Preferences/.wrangler/config/default.toml"
	if [[ ! -f "$WRANGLER_CONFIG" ]]; then
		# Linux / fallback path
		WRANGLER_CONFIG="${HOME}/.wrangler/config/default.toml"
	fi
	if [[ -f "$WRANGLER_CONFIG" ]]; then
		OAUTH_TOKEN=$(grep '^oauth_token' "$WRANGLER_CONFIG" | sed 's/^oauth_token *= *"\(.*\)"/\1/')
	fi
	if [[ -z "${OAUTH_TOKEN:-}" ]]; then
		echo "Error: no CLOUDFLARE_API_TOKEN and no wrangler OAuth token found. Run 'wrangler login' first." >&2
		exit 1
	fi
	AUTH_HEADER="Authorization: Bearer ${OAUTH_TOKEN}"
fi

# Helper: CF API call
cf_api() {
	local method="$1" path="$2"
	shift 2
	curl -sf -X "$method" "${CF_API}${path}" \
		-H "$AUTH_HEADER" \
		-H "Content-Type: application/json" \
		"$@"
}

echo "==> Looking up stream '${STREAM_NAME}'..."
STREAM_ID=$(npx wrangler pipelines streams list --json 2>/dev/null \
	| jq -r --arg name "$STREAM_NAME" '.[] | select(.name == $name) | .id')

if [[ -z "$STREAM_ID" ]]; then
	echo "Error: stream '${STREAM_NAME}' not found" >&2
	exit 1
fi
echo "    Found stream ID: ${STREAM_ID}"

echo "==> Looking up pipeline '${PIPELINE_NAME}'..."
PIPELINE_ID=$(npx wrangler pipelines list --json 2>/dev/null \
	| jq -r --arg name "$PIPELINE_NAME" '.[] | select(.name == $name) | .id')

if [[ -z "$PIPELINE_ID" ]]; then
	echo "Error: pipeline '${PIPELINE_NAME}' not found" >&2
	exit 1
fi
echo "    Found pipeline ID: ${PIPELINE_ID}"

echo "==> Deleting pipeline '${PIPELINE_NAME}' (${PIPELINE_ID})..."
cf_api DELETE "/pipelines/${PIPELINE_ID}" > /dev/null
echo "    Deleted."

echo "==> Deleting stream '${STREAM_NAME}' (${STREAM_ID})..."
cf_api DELETE "/streams/${STREAM_ID}" > /dev/null
echo "    Deleted."

OLD_STREAM_ID="$STREAM_ID"

echo "==> Creating new stream '${STREAM_NAME}' with schema ${SCHEMA_FILE}..."
npx wrangler pipelines streams create "$STREAM_NAME" --schema-file "$SCHEMA_FILE"

NEW_STREAM_ID=$(npx wrangler pipelines streams list --json 2>/dev/null \
	| jq -r --arg name "$STREAM_NAME" '.[] | select(.name == $name) | .id')

if [[ -z "$NEW_STREAM_ID" ]]; then
	echo "Error: failed to find newly created stream '${STREAM_NAME}'" >&2
	exit 1
fi
echo "    New stream ID: ${NEW_STREAM_ID}"

PIPELINE_SQL="INSERT INTO ${SINK_NAME} SELECT * FROM ${STREAM_NAME}"
echo "==> Creating new pipeline '${PIPELINE_NAME}'..."
echo "    SQL: ${PIPELINE_SQL}"
npx wrangler pipelines create "$PIPELINE_NAME" --sql "$PIPELINE_SQL"

echo "==> Updating wrangler.jsonc (${OLD_STREAM_ID} -> ${NEW_STREAM_ID})..."
if ! grep -q "$OLD_STREAM_ID" wrangler.jsonc; then
	echo "Error: old stream ID ${OLD_STREAM_ID} not found in wrangler.jsonc" >&2
	exit 1
fi
sed -i '' "s/${OLD_STREAM_ID}/${NEW_STREAM_ID}/g" wrangler.jsonc
echo "    Updated."

echo "==> Deploying worker..."
npx wrangler deploy

echo ""
echo "Done. Stream '${STREAM_NAME}' recreated with new ID ${NEW_STREAM_ID}."
echo "Remember to commit the updated wrangler.jsonc."
