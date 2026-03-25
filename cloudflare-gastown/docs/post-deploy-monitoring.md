# Post-Deploy Town Health Monitoring

Guide for an AI agent to verify town health after a production deploy.

## Prerequisites

- The debug endpoint is deployed: `GET /debug/towns/:townId/status`
- The debug endpoint is protected by Cloudflare Access. Requests must include service token headers.
- Base URL: `https://gastown.kiloapps.io`
- Town ID: obtain from `GET /trpc/gastown.listOrgTowns` (requires auth) or from the user

### Authentication

The debug endpoint requires Cloudflare Access service token headers. These are the same credentials the Next.js app uses to communicate with gastown:

```bash
# Set these from your Cloudflare Access service token
export CF_ACCESS_CLIENT_ID="<service-token-client-id>"
export CF_ACCESS_CLIENT_SECRET="<service-token-client-secret>"
```

For querying Cloudflare logs and Analytics Engine, you also need:

```bash
# Cloudflare API token with Workers Observability + Analytics Engine read permissions
export GASTOWN_CF_ANALYTICS_API_KEY="<api-token>"
# Cloudflare account ID (found at: Workers & Pages → Overview, right sidebar)
export CF_ACCOUNT_ID="<account-id>"
```

All `curl` commands in this document use a helper function that includes these headers:

```bash
debug_curl() {
  curl -s \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    "$@"
}
```

## 1. Monitor Script

The monitoring script at `scripts/monitor-town.sh` polls the debug endpoint:

```bash
export CF_ACCESS_CLIENT_ID="<client-id>"
export CF_ACCESS_CLIENT_SECRET="<client-secret>"
./scripts/monitor-town.sh <townId> [interval_seconds]
```

Or poll manually:

```bash
debug_curl "https://gastown.kiloapps.io/debug/towns/$TOWN_ID/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d['alarmStatus']
print(f\"Working: {a['agents']['working']}  Idle: {a['agents']['idle']}\")
print(f\"open: {a['beads']['open']}  inProgress: {a['beads']['inProgress']}  inReview: {a['beads']['inReview']}\")
ref = [x for x in d['agentMeta'] if x.get('role') == 'refinery']
if ref:
    r = ref[0]
    print(f\"Refinery: status={r['status']} hook={r.get('current_hook_bead_id') or 'NULL'}\")
recon = a.get('reconciler')
if recon:
    print(f\"Reconciler: events={recon['eventsDrained']} actions={recon['actionsEmitted']} violations={recon['invariantViolations']} wallMs={recon['wallClockMs']}\")
for e in a.get('recentEvents', [])[:5]:
    print(f\"  {e['time'][:19]}  {e['message'][:80]}\")
"
```

## 2. Post-Deploy Health Checks

After `pnpm deploy:prod`, verify these in order:

### Phase 1: DO Reset (0-30s)

The Durable Object reinitializes. Check the alarm is running:

```bash
# Alarm should show 'active (5s)' within 10s of deploy
debug_curl "https://gastown.kiloapps.io/debug/towns/$TOWN_ID/status" | python3 -c "
import sys, json; d = json.load(sys.stdin)
print(d['alarmStatus']['alarm']['intervalLabel'])
"
```

**Expected**: `active (5s)` or `idle (60s)`

### Phase 2: Container Restart (30s-3min)

The container is evicted and a new one starts. The `ensureMayor` tRPC call can kick-start it:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"townId\":\"$TOWN_ID\"}" \
  "https://gastown.kiloapps.io/trpc/gastown.ensureMayor"
```

Poll until agents start working:

```bash
# Should see Working > 0 within 2-3 min
debug_curl "https://gastown.kiloapps.io/debug/towns/$TOWN_ID/status" | python3 -c "
import sys, json; d = json.load(sys.stdin)
print(f\"Working: {d['alarmStatus']['agents']['working']}\")
"
```

### Phase 3: Agent Recovery (1-5min)

Verify agents recover from the container restart. The reconciler handles all recovery:

- **Polecats**: idle+hooked agents are re-dispatched by `reconcileBeads` Rule 2
- **Refinery**: if it was mid-review, the container status observation detects the dead container and sets the refinery to idle. `reconcileReviewQueue` Rule 6 re-dispatches it.
- **Orphaned beads**: `reconcileBeads` Rule 3 resets in-progress beads with no working agent to open after 5 min, then Rule 1 assigns a new agent.

**Red flags**:

- `Working: 0` for more than 5 min after container is active
- `invariantViolations > 0` in reconciler metrics
- `failed` count increasing rapidly (dispatch attempts burning out)

### Phase 4: Review Pipeline (5-15min)

Watch for a full review cycle:

```
in_progress → in_review → review_completed → closed
```

Check that:

- The refinery picks up MR beads (status transitions to `working`)
- Reviews complete as `merged` (not `Refinery container failed to start`)
- Source beads reach `closed` and stay closed

### Phase 5: Reconciler Health

Verify the reconciler is running correctly:

```bash
debug_curl "https://gastown.kiloapps.io/debug/towns/$TOWN_ID/status" | python3 -c "
import sys, json; d = json.load(sys.stdin)
r = d['alarmStatus'].get('reconciler')
if r:
    print(f\"Events drained: {r['eventsDrained']}\")
    print(f\"Actions emitted: {r['actionsEmitted']}\")
    print(f\"Invariant violations: {r['invariantViolations']}\")
    print(f\"Wall clock: {r['wallClockMs']}ms\")
    print(f\"Pending events: {r['pendingEventCount']}\")
    if r.get('actionsByType'):
        print(f\"Action types: {r['actionsByType']}\")
else:
    print('No reconciler metrics yet')
"
```

**Expected**: `invariantViolations: 0`, `wallClockMs < 100`, `pendingEventCount: 0`

## 3. Test Convoy

Create a simple test convoy to verify the full pipeline. Use the tRPC `slingConvoy` endpoint:

```bash
TOKEN="<bearer-token>"
TOWN_ID="<town-id>"
RIG_ID="<rig-id>"

# Create a 2-bead test convoy
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"rigId\": \"$RIG_ID\",
    \"convoyTitle\": \"Post-deploy health check $(date -u +%H:%M)\",
    \"tasks\": [
      {\"title\": \"Update README with current timestamp (pass 1 of 2)\"},
      {\"title\": \"Update README with current timestamp (pass 2 of 2)\"}
    ]
  }" \
  "https://gastown.kiloapps.io/trpc/gastown.slingConvoy"
```

Then monitor until both beads reach `closed`:

```bash
# Poll every 30s until no non-terminal issue beads remain
while true; do
  RESP=$(debug_curl "https://gastown.kiloapps.io/debug/towns/$TOWN_ID/status")
  ISSUES=$(echo "$RESP" | python3 -c "
import sys, json
beads = json.load(sys.stdin).get('beadSummary', [])
issues = [b for b in beads if b.get('type') == 'issue']
print(len(issues))
for b in issues:
    print(f\"  {b['status']:12s} {b.get('title','')[:60]}\")
")
  echo "$(date -u +%H:%M:%S) Non-terminal issues: $ISSUES"
  # Exit when 0 non-terminal issues
  echo "$ISSUES" | head -1 | grep -q "^0$" && echo "All beads closed!" && break
  sleep 30
done
```

**Expected timeline**:

- 0-2 min: beads created, polecats dispatched by reconciler (lazy assignment)
- 2-10 min: polecats work, submit reviews
- 10-15 min: refinery reviews and merges
- 15-25 min: second bead goes through the same cycle
- 25-30 min: convoy lands (all beads closed)

**Failure indicators**:

- Beads stuck in `open` for >5 min → check reconciler actions (should emit `dispatch_agent`)
- Beads stuck in `in_review` for >15 min → check refinery status and MR beads
- MR beads stuck in `in_progress` for >5 min → check refinery dispatch retry
- Beads cycling `in_progress → open` → check `agentCompleted` events and STALE_IN_PROGRESS_TIMEOUT_MS
- Reviews completing as `failed` → check container start errors on refinery agent status message

## 4. Cleanup

After monitoring is complete, clean up test beads.

### Remove test convoy beads

```bash
# Get all beads for the rig
BEADS=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gastown.kiloapps.io/trpc/gastown.listBeads?input=$(python3 -c \
  'import json,urllib.parse; print(urllib.parse.quote(json.dumps({"rigId":"'$RIG_ID'"})))')")

# Find and delete test convoy beads (match by title prefix)
echo "$BEADS" | python3 -c "
import sys, json
data = json.load(sys.stdin)['result']['data']
for b in data:
    title = b.get('title', '')
    if 'Post-deploy health check' in title or 'Update README with current timestamp' in title:
        print(b['bead_id'])
" | while read BEAD_ID; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"rigId\":\"$RIG_ID\",\"beadId\":\"$BEAD_ID\"}" \
    "https://gastown.kiloapps.io/trpc/gastown.deleteBead"
  echo "Deleted $BEAD_ID"
done
```

## 5. Key Metrics to Watch

| Metric                | Healthy                                 | Unhealthy                             |
| --------------------- | --------------------------------------- | ------------------------------------- |
| Working agents        | >0 when beads exist                     | 0 for >5 min with open beads          |
| Failed bead count     | Stable                                  | Increasing rapidly                    |
| Invariant violations  | 0                                       | >0 (check reconciler logs)            |
| Refinery status       | `working` during review, `idle` between | `idle` with in_progress MR for >5 min |
| Review outcomes       | `merged`                                | `Refinery container failed to start`  |
| Alarm interval        | `active (5s)` with work                 | Stuck at same `nextFireAt`            |
| Reconciler wall clock | <100ms                                  | >500ms consistently                   |
| Pending event count   | 0 between ticks                         | Growing (events not draining)         |

## 6. Querying Cloudflare Logs (Workers Observability)

Workers Observability is enabled at 100% sampling (`wrangler.jsonc` → `observability`). All `console.log/warn/error` output is indexed and searchable via the Cloudflare API. Key log lines emit structured JSON with `townId`, `rigId`, `userId`, `orgId`, and `agentId` fields for filtering.

### Log Query Script

The `scripts/query-logs.sh` script wraps the Workers Observability and Analytics Engine APIs:

```bash
export GASTOWN_CF_ANALYTICS_API_KEY="<api-token>"
export CF_ACCOUNT_ID="<account-id>"

# Fetch recent logs mentioning a town (last 30 min by default)
./scripts/query-logs.sh logs <townId> [minutes]

# Fetch only errors/warnings for a town
./scripts/query-logs.sh errors <townId> [minutes]

# Query Analytics Engine events for a town
./scripts/query-logs.sh ae-events <townId> [hours]

# Query reconciler tick metrics from Analytics Engine
./scripts/query-logs.sh ae-reconciler <townId> [hours]
```

### Manual Log Queries

Query the Workers Observability API directly. The structured logs use JSON format with fields like `townId`, `rigId`, `userId`, `orgId`, `agentId`:

```bash
# Search for all logs mentioning a specific town in the last hour
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $GASTOWN_CF_ANALYTICS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "queryId": "",
    "timeframe": { "from": '$(($(date +%s) - 3600))'000, "to": '$(date +%s)'000 },
    "limit": 50,
    "view": "events",
    "parameters": {
      "datasets": ["gastown"],
      "calculations": [{ "operator": "count" }],
      "filters": [
        { "key": "message", "operation": "contains", "value": "'$TOWN_ID'", "type": "string" }
      ],
      "orderBy": { "value": "timestamp", "order": "desc" }
    }
  }' | python3 -c "
import sys, json
data = json.load(sys.stdin)
for ds, evts in data.get('result',{}).get('events',{}).items():
    for e in evts:
        ts = e.get('timestamp','')
        msg = e.get('message','')[:200]
        level = e.get('level','info')
        print(f'{ts}  [{level}]  {msg}')
"
```

### Useful search patterns

Since the structured logs are JSON, you can search for specific fields:

- **All errors for a town**: filter `message contains "<townId>"` + `level in ["error","warn"]`
- **Mayor session issues**: search for `"ensureMayor"` or `"sendMayorMessage"` in message
- **Rig configuration**: search for `"configureRig"` in message
- **Reconciler problems**: search for `"reconciler"` + `level = "error"`
- **Container dispatch failures**: search for `"startAgentInContainer"` + `level = "error"`
- **Git credential issues**: search for `"git credential"` or `"refreshGitCredentials"` in message
- **Rig repo setup failures (container)**: search for `"/repos/setup: FAILED"` or `"browse worktree setup FAILED"` — these are container-side errors logged at `error` level when git clone or worktree creation fails. Visible in Workers Observability via `$containers` log enrichment.
- **Mayor can't see rigs**: search for `"mayor rig setup:"` to see summary of rig setup failures during mayor startup

### Dashboard

The Cloudflare Workers Observability dashboard provides an interactive UI for the same data:

1. Go to **Workers & Pages** → select **gastown** → **Observability** → **Overview**
2. Use the search bar with the query language: `message : "<townId>"`
3. Filter by level: `level = "error"` or `level = "warn"`
4. Group by invocation to see all logs from a single request

## 7. Querying Analytics Engine

The `gastown_events` Analytics Engine dataset stores all lifecycle events (bead status changes, agent dispatches, reconciler ticks, reviews, etc.). Unlike logs, AE data is designed for aggregation and time-series queries.

### Dataset schema

The `gastown_events` dataset maps fields as follows:

| Column  | Field               | Description                                       |
| ------- | ------------------- | ------------------------------------------------- |
| blob1   | event               | Event name (e.g. `bead.created`, `agent.spawned`) |
| blob2   | userId              | User who triggered the event                      |
| blob3   | delivery            | `http`, `trpc`, or `internal`                     |
| blob4   | route               | HTTP route pattern (for HTTP events)              |
| blob5   | error               | Error message (if any)                            |
| blob6   | townId              | Town ID                                           |
| blob7   | rigId               | Rig ID                                            |
| blob8   | agentId             | Agent ID                                          |
| blob9   | beadId              | Bead ID                                           |
| blob10  | label               | Free-form label (e.g. actionsByType JSON)         |
| blob11  | convoyId            | Convoy ID                                         |
| blob12  | role                | Agent role (`polecat`, `refinery`, `mayor`)       |
| blob13  | beadType            | Bead type                                         |
| double1 | durationMs          | Duration in milliseconds                          |
| double2 | value               | Generic numeric value                             |
| double3 | actionsEmitted      | (reconciler_tick) actions count                   |
| double7 | invariantViolations | (reconciler_tick) violation count                 |
| double8 | pendingEventCount   | (reconciler_tick) pending event count             |

### Example AE queries

```bash
AE_API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql"

# Count events by type for a town in the last hour
curl -s "$AE_API" \
  -H "Authorization: Bearer $GASTOWN_CF_ANALYTICS_API_KEY" \
  -d "SELECT blob1 AS event, SUM(_sample_interval) AS count
      FROM gastown_events
      WHERE blob6 = '$TOWN_ID'
        AND timestamp > NOW() - INTERVAL '1' HOUR
      GROUP BY event ORDER BY count DESC LIMIT 20
      FORMAT JSONCompact"

# Reconciler health over the last 6 hours (5-min buckets)
curl -s "$AE_API" \
  -H "Authorization: Bearer $GASTOWN_CF_ANALYTICS_API_KEY" \
  -d "SELECT
        intDiv(toUInt32(timestamp), 300) * 300 AS t,
        SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_wall_ms,
        SUM(_sample_interval * double3) AS total_actions,
        SUM(_sample_interval * double7) AS total_violations
      FROM gastown_events
      WHERE blob1 = 'reconciler_tick' AND blob6 = '$TOWN_ID'
        AND timestamp > NOW() - INTERVAL '6' HOUR
      GROUP BY t ORDER BY t
      FORMAT JSONCompact"

# Agent dispatch failures in the last day
curl -s "$AE_API" \
  -H "Authorization: Bearer $GASTOWN_CF_ANALYTICS_API_KEY" \
  -d "SELECT timestamp, blob8 AS agent_id, blob12 AS role, blob5 AS error
      FROM gastown_events
      WHERE blob1 = 'agent.dispatch_failed' AND blob6 = '$TOWN_ID'
        AND timestamp > NOW() - INTERVAL '1' DAY
      ORDER BY timestamp DESC LIMIT 20
      FORMAT JSONCompact"

# Bead lifecycle for a specific town (status changes)
curl -s "$AE_API" \
  -H "Authorization: Bearer $GASTOWN_CF_ANALYTICS_API_KEY" \
  -d "SELECT timestamp, blob1 AS event, blob9 AS bead_id, blob10 AS label
      FROM gastown_events
      WHERE blob1 LIKE 'bead.%' AND blob6 = '$TOWN_ID'
        AND timestamp > NOW() - INTERVAL '1' HOUR
      ORDER BY timestamp DESC LIMIT 50
      FORMAT JSONCompact"
```

### Structured log fields

Worker logs now emit JSON-structured entries. Key fields available for filtering in Workers Observability:

| JSON field | Description                 | Example filter                  |
| ---------- | --------------------------- | ------------------------------- |
| `source`   | Module that emitted the log | `"Town.do"`, `"gastown-worker"` |
| `townId`   | Town UUID                   | `message : "townId":"<uuid>"`   |
| `rigId`    | Rig UUID                    | `message : "rigId":"<uuid>"`    |
| `userId`   | User UUID                   | `message : "userId":"<uuid>"`   |
| `orgId`    | Organization UUID           | `message : "orgId":"<uuid>"`    |
| `agentId`  | Agent UUID                  | `message : "agentId":"<uuid>"`  |
| `level`    | `info`, `warn`, or `error`  | `message : "level":"error"`     |

These fields are embedded in the `message` text as JSON, so use the `contains` operator or `:` in the dashboard query language to filter by them.
