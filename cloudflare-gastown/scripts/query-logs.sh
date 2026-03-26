#!/bin/bash
# Query Cloudflare Workers Observability logs and Analytics Engine for a gastown town.
#
# Usage:
#   ./scripts/query-logs.sh <subcommand> [options]
#
# Subcommands:
#   logs      <townId> [minutes]   — Fetch recent worker logs mentioning this town
#   errors    <townId> [minutes]   — Fetch recent errors/warnings for this town
#   ae-events <townId> [hours]     — Query Analytics Engine events for this town
#   ae-reconciler <townId> [hours] — Query reconciler tick metrics from Analytics Engine
#
# Required environment variables:
#   GASTOWN_CF_ANALYTICS_API_KEY  — Cloudflare API token with Workers Observability + AE read
#   CF_ACCOUNT_ID                 — Cloudflare account ID (auto-detected from wrangler if absent)
#
# Optional:
#   GASTOWN_SCRIPT_NAME           — Worker script name (default: "gastown")

set -euo pipefail

SCRIPT_NAME="${GASTOWN_SCRIPT_NAME:-gastown}"

# ── Resolve account ID ──────────────────────────────────────────────────
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  # Try to extract from wrangler whoami or fall back to prompting
  echo "Error: CF_ACCOUNT_ID must be set."
  echo "Find it at: https://dash.cloudflare.com → Workers & Pages → Overview (right sidebar)"
  exit 1
fi

if [ -z "${GASTOWN_CF_ANALYTICS_API_KEY:-}" ]; then
  echo "Error: GASTOWN_CF_ANALYTICS_API_KEY must be set."
  echo "Create a token at https://dash.cloudflare.com/profile/api-tokens with:"
  echo "  - Account > Workers Observability > Read"
  echo "  - Account > Analytics > Read"
  exit 1
fi

API_KEY="$GASTOWN_CF_ANALYTICS_API_KEY"
ACCOUNT="$CF_ACCOUNT_ID"

# ── Workers Observability query helper ──────────────────────────────────
# Uses the telemetry/query API to search structured logs.
# Docs: https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
query_observability() {
  local body="$1"
  curl -s "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# ── Analytics Engine SQL helper ─────────────────────────────────────────
# Docs: https://developers.cloudflare.com/analytics/analytics-engine/sql-api
query_ae() {
  local sql="$1"
  curl -s "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$sql"
}

# ── Subcommands ─────────────────────────────────────────────────────────

cmd_logs() {
  local town_id="$1"
  local minutes="${2:-30}"
  local now_ms=$(date +%s)000
  local from_ms=$(( ($(date +%s) - minutes * 60) ))000

  echo "Fetching logs for town=${town_id} (last ${minutes}m)..."
  echo ""

  query_observability "$(cat <<EOF
{
  "queryId": "",
  "timeframe": { "from": ${from_ms}, "to": ${now_ms} },
  "limit": 100,
  "view": "events",
  "parameters": {
    "datasets": ["${SCRIPT_NAME}"],
    "calculations": [{ "operator": "count" }],
    "filters": [
      {
        "key": "message",
        "operation": "contains",
        "value": "${town_id}",
        "type": "string"
      }
    ],
    "orderBy": { "value": "timestamp", "order": "desc" }
  }
}
EOF
)" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    print('[ERROR] Failed to parse response')
    sys.exit(1)

if data.get('errors'):
    for e in data['errors']:
        print(f'[API ERROR] {e.get(\"message\", e)}')
    sys.exit(1)

events = data.get('result', {}).get('events', {})
for dataset_name, event_list in events.items():
    for event in event_list:
        ts = event.get('timestamp', '')
        msg = event.get('message', '')
        level = event.get('level', 'info')
        # Format timestamp
        if isinstance(ts, (int, float)):
            from datetime import datetime, timezone
            ts = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%H:%M:%S')
        marker = '!!' if level in ('error', 'warn') else '  '
        print(f'{ts} {marker} {msg[:200]}')

if not any(events.values()):
    print('(no logs found)')
" 2>/dev/null
}

cmd_errors() {
  local town_id="$1"
  local minutes="${2:-60}"
  local now_ms=$(date +%s)000
  local from_ms=$(( ($(date +%s) - minutes * 60) ))000

  echo "Fetching errors/warnings for town=${town_id} (last ${minutes}m)..."
  echo ""

  query_observability "$(cat <<EOF
{
  "queryId": "",
  "timeframe": { "from": ${from_ms}, "to": ${now_ms} },
  "limit": 50,
  "view": "events",
  "parameters": {
    "datasets": ["${SCRIPT_NAME}"],
    "calculations": [{ "operator": "count" }],
    "filters": [
      {
        "key": "message",
        "operation": "contains",
        "value": "${town_id}",
        "type": "string"
      },
      {
        "key": "level",
        "operation": "in",
        "value": ["error", "warn"],
        "type": "string"
      }
    ],
    "orderBy": { "value": "timestamp", "order": "desc" }
  }
}
EOF
)" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    print('[ERROR] Failed to parse response')
    sys.exit(1)

if data.get('errors'):
    for e in data['errors']:
        print(f'[API ERROR] {e.get(\"message\", e)}')
    sys.exit(1)

events = data.get('result', {}).get('events', {})
for dataset_name, event_list in events.items():
    for event in event_list:
        ts = event.get('timestamp', '')
        msg = event.get('message', '')
        level = event.get('level', 'info')
        if isinstance(ts, (int, float)):
            from datetime import datetime, timezone
            ts = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%H:%M:%S')
        print(f'{ts} [{level:5s}] {msg[:200]}')

if not any(events.values()):
    print('(no errors/warnings found)')
" 2>/dev/null
}

cmd_ae_events() {
  local town_id="$1"
  local hours="${2:-1}"

  echo "Analytics Engine: events for town=${town_id} (last ${hours}h)..."
  echo ""
  echo "  blob1=event  blob2=userId  blob6=townId  blob7=rigId"
  echo "  blob8=agentId  blob10=label  blob12=role  double1=durationMs"
  echo ""

  # The gastown_events dataset uses:
  #   blob1=event, blob2=userId, blob6=townId, blob7=rigId,
  #   blob8=agentId, blob9=beadId, blob10=label, blob12=role
  #   double1=durationMs, double2=value
  query_ae "
    SELECT
      timestamp,
      blob1 AS event,
      blob2 AS user_id,
      blob7 AS rig_id,
      blob8 AS agent_id,
      blob12 AS role,
      double1 AS duration_ms,
      blob10 AS label
    FROM gastown_events
    WHERE blob6 = '${town_id}'
      AND timestamp > NOW() - INTERVAL '${hours}' HOUR
    ORDER BY timestamp DESC
    LIMIT 50
    FORMAT JSONCompact
  " | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    print('[ERROR] Failed to parse AE response. Raw:')
    sys.exit(1)

rows = data.get('data', [])
cols = [c.get('name','') for c in data.get('meta', [])]
if not rows:
    print('(no events found)')
    sys.exit(0)

for row in rows:
    d = dict(zip(cols, row))
    ts = d.get('timestamp','')[:19]
    evt = d.get('event','')
    role = d.get('role','')
    dur = d.get('duration_ms','')
    label = d.get('label','')[:60]
    agent = d.get('agent_id','')[:8]
    parts = [ts, evt]
    if role: parts.append(f'role={role}')
    if agent: parts.append(f'agent={agent}')
    if dur and float(dur) > 0: parts.append(f'{float(dur):.0f}ms')
    if label: parts.append(label)
    print('  '.join(parts))
" 2>/dev/null
}

cmd_ae_reconciler() {
  local town_id="$1"
  local hours="${2:-1}"

  echo "Analytics Engine: reconciler ticks for town=${town_id} (last ${hours}h)..."
  echo ""

  # reconciler_tick events use:
  #   double1=wallClockMs, double2=eventsDrained (stored in 'value'),
  #   double3=actionsEmitted, double7=invariantViolations,
  #   double8=pendingEventCount, blob10=actionsByType JSON
  query_ae "
    SELECT
      intDiv(toUInt32(timestamp), 300) * 300 AS bucket,
      SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_wall_ms,
      SUM(_sample_interval * double2) AS total_events_drained,
      SUM(_sample_interval * double3) AS total_actions,
      SUM(_sample_interval * double7) AS total_violations,
      MAX(double8) AS max_pending
    FROM gastown_events
    WHERE blob1 = 'reconciler_tick'
      AND blob6 = '${town_id}'
      AND timestamp > NOW() - INTERVAL '${hours}' HOUR
    GROUP BY bucket
    ORDER BY bucket DESC
    LIMIT 20
    FORMAT JSONCompact
  " | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    print('[ERROR] Failed to parse AE response')
    sys.exit(1)

rows = data.get('data', [])
if not rows:
    print('(no reconciler ticks found)')
    sys.exit(0)

print(f'{\"time\":>10s}  {\"avgMs\":>6s}  {\"events\":>7s}  {\"actions\":>8s}  {\"violat\":>7s}  {\"pending\":>8s}')
print('-' * 60)
cols = [c.get('name','') for c in data.get('meta', [])]
for row in rows:
    d = dict(zip(cols, row))
    bucket = d.get('bucket','')
    # bucket is a unix timestamp (seconds); convert to HH:MM:SS
    try:
        from datetime import datetime, timezone
        ts = datetime.fromtimestamp(int(bucket), tz=timezone.utc).strftime('%H:%M:%S')
    except (ValueError, TypeError, OSError):
        ts = str(bucket)
    print(f'{str(ts):>10s}  {float(d.get(\"avg_wall_ms\",0)):6.1f}  {float(d.get(\"total_events_drained\",0)):7.0f}  {float(d.get(\"total_actions\",0)):8.0f}  {float(d.get(\"total_violations\",0)):7.0f}  {float(d.get(\"max_pending\",0)):8.0f}')
" 2>/dev/null
}

# ── Dispatch ────────────────────────────────────────────────────────────

case "${1:-help}" in
  logs)
    [ -z "${2:-}" ] && echo "Usage: $0 logs <townId> [minutes]" && exit 1
    cmd_logs "$2" "${3:-30}"
    ;;
  errors)
    [ -z "${2:-}" ] && echo "Usage: $0 errors <townId> [minutes]" && exit 1
    cmd_errors "$2" "${3:-60}"
    ;;
  ae-events)
    [ -z "${2:-}" ] && echo "Usage: $0 ae-events <townId> [hours]" && exit 1
    cmd_ae_events "$2" "${3:-1}"
    ;;
  ae-reconciler)
    [ -z "${2:-}" ] && echo "Usage: $0 ae-reconciler <townId> [hours]" && exit 1
    cmd_ae_reconciler "$2" "${3:-1}"
    ;;
  *)
    echo "Usage: $0 <subcommand> [options]"
    echo ""
    echo "Subcommands:"
    echo "  logs           <townId> [minutes]  — Recent worker logs (default: 30m)"
    echo "  errors         <townId> [minutes]  — Recent errors/warnings (default: 60m)"
    echo "  ae-events      <townId> [hours]    — Analytics Engine events (default: 1h)"
    echo "  ae-reconciler  <townId> [hours]    — Reconciler tick metrics (default: 1h)"
    echo ""
    echo "Required env vars:"
    echo "  GASTOWN_CF_ANALYTICS_API_KEY  — CF API token (Workers Observability + AE read)"
    echo "  CF_ACCOUNT_ID                 — Cloudflare account ID"
    ;;
esac
