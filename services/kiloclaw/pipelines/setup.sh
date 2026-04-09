#!/usr/bin/env bash
#
# One-time setup: create Cloudflare Pipeline streams, sinks, and pipelines for
# kiloclaw_events and kiloclaw_controller_telemetry → R2 → Snowflake.
#
# NOTE: This script is an alternative to the dashboard wizard.
# If using the wizard, enter the pipeline name (e.g. kiloclaw_events_pipeline)
# and the wizard will auto-name the stream and sink with the same prefix.
#
# Usage:
#   ./pipelines/setup.sh <r2-bucket-name>
#
# The R2 bucket should be the same one used by the o11y pipelines so we can
# reuse the existing Snowflake external stage. Look it up from the dashboard:
#   Cloudflare → Pipelines → Streams → o11y_api_metrics_pipeline_sink → Settings
#
# After running this script:
#   1. Copy the two pipeline IDs printed at the end into wrangler.jsonc
#   2. Commit and open the PR
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN with Pipelines:Edit permission
#   - Run from the services/kiloclaw/ directory

set -euo pipefail

R2_BUCKET="${1:?Usage: $0 <r2-bucket-name>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/6] Creating kiloclaw_events_pipeline_stream..."
npx wrangler pipelines streams create kiloclaw_events_pipeline_stream \
  --schema-file "$SCRIPT_DIR/events-schema.json" \
  --no-http-enabled

echo ""
echo "==> [2/6] Creating kiloclaw_events_pipeline_sink (R2 bucket: ${R2_BUCKET})..."
npx wrangler pipelines sinks create kiloclaw_events_pipeline_sink \
  --type r2 \
  --bucket "$R2_BUCKET" \
  --format parquet \
  --compression zstd \
  --path "kiloclaw/events"

echo ""
echo "==> [3/6] Creating kiloclaw_events_pipeline..."
npx wrangler pipelines create kiloclaw_events_pipeline \
  --sql "INSERT INTO kiloclaw_events_pipeline_sink SELECT * FROM kiloclaw_events_pipeline_stream"

echo ""
echo "==> [4/6] Creating kiloclaw_controller_telemetry_pipeline_stream..."
npx wrangler pipelines streams create kiloclaw_controller_telemetry_pipeline_stream \
  --schema-file "$SCRIPT_DIR/controller-telemetry-schema.json" \
  --no-http-enabled

echo ""
echo "==> [5/6] Creating kiloclaw_controller_telemetry_pipeline_sink (R2 bucket: ${R2_BUCKET})..."
npx wrangler pipelines sinks create kiloclaw_controller_telemetry_pipeline_sink \
  --type r2 \
  --bucket "$R2_BUCKET" \
  --format parquet \
  --compression zstd \
  --path "kiloclaw/controller-telemetry"

echo ""
echo "==> [6/6] Creating kiloclaw_controller_telemetry_pipeline..."
npx wrangler pipelines create kiloclaw_controller_telemetry_pipeline \
  --sql "INSERT INTO kiloclaw_controller_telemetry_pipeline_sink SELECT * FROM kiloclaw_controller_telemetry_pipeline_stream"

echo ""
echo "==> Done. Pipeline IDs to copy into wrangler.jsonc:"
echo ""
npx wrangler pipelines list --json 2>/dev/null \
  | jq -r '.[] | select(.name | startswith("kiloclaw_")) | "\(.name): \(.id)"'
echo ""
echo "Replace KILOCLAW_EVENTS_PIPELINE_ID and KILOCLAW_CONTROLLER_TELEMETRY_PIPELINE_ID"
echo "in wrangler.jsonc with the IDs above, commit, and open the PR."
