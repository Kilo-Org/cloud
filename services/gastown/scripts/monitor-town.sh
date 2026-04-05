#!/bin/bash
# Continuously monitor a town's state via the debug endpoint.
# Usage: ./scripts/monitor-town.sh [townId] [interval_seconds]
#
# Requires Cloudflare Access service token credentials:
#   export CF_ACCESS_CLIENT_ID="<service-token-client-id>"
#   export CF_ACCESS_CLIENT_SECRET="<service-token-client-secret>"

TOWN_ID="${1:-8a6f9375-b806-4ee0-ad6e-1697ea2dbfff}"
INTERVAL="${2:-15}"
BASE_URL="${GASTOWN_URL:-https://gastown.kiloapps.io}"
URL="${BASE_URL}/debug/towns/${TOWN_ID}/status"

if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
  echo "Error: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set"
  echo "These are the Cloudflare Access service token credentials."
  exit 1
fi

echo "Monitoring town ${TOWN_ID} every ${INTERVAL}s"
echo "Endpoint: ${URL}"
echo "Press Ctrl+C to stop"
echo "=========================================="

while true; do
  RESP=$(curl -s --max-time 10 \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    "${URL}" 2>/dev/null)
  if [ -z "$RESP" ]; then
    echo "$(date -u +%H:%M:%S)  [ERROR] No response from ${URL}"
    sleep "$INTERVAL"
    continue
  fi

  echo "$RESP" | python3 -c "
import sys, json, datetime

try:
    d = json.load(sys.stdin)
except:
    print('$(date -u +%H:%M:%S)  [ERROR] Invalid JSON response')
    sys.exit(0)

ts = datetime.datetime.utcnow().strftime('%H:%M:%S')
alarm = d.get('alarmStatus', {})
agents_info = alarm.get('agents', {})
beads_info = alarm.get('beads', {})
patrol_info = alarm.get('patrol', {})
recon = alarm.get('reconciler') or {}
events = alarm.get('recentEvents', [])

working = agents_info.get('working', 0)
idle = agents_info.get('idle', 0)
op = beads_info.get('open', 0)
ip = beads_info.get('inProgress', 0)
ir = beads_info.get('inReview', 0)
failed = beads_info.get('failed', 0)
violations = recon.get('invariantViolations', '-')
actions = recon.get('actionsEmitted', '-')
wall_ms = recon.get('wallClockMs', '-')

# Agent details
agents = d.get('agentMeta', [])
hooked_agents = [a for a in agents if a.get('current_hook_bead_id')]
refinery = [a for a in agents if a.get('role') == 'refinery']

# Non-terminal beads
beads = d.get('beadSummary', [])

print(f'{ts}  W={working} I={idle} | open={op} prog={ip} review={ir} fail={failed} | v={violations} act={actions} ms={wall_ms}')

# Show refinery state
for r in refinery:
    hook = r.get('current_hook_bead_id', 'NULL') or 'NULL'
    print(f'         refinery: status={r.get(\"status\",\"?\"):8s} hook={hook[:12]:12s} dispatch={r.get(\"dispatch_attempts\",0)}')

# Show non-terminal beads
if beads:
    for b in beads[:8]:
        assignee = str(b.get('assignee_agent_bead_id', '') or '')[:8]
        print(f'         {b.get(\"status\",\"?\"):12s} {b.get(\"type\",\"?\"):16s} {str(b.get(\"bead_id\",\"\"))[:8]}  agent={assignee:8s}  {str(b.get(\"title\",\"\"))[:50]}')
    if len(beads) > 8:
        print(f'         ... and {len(beads) - 8} more')

# Show most recent event
if events:
    e = events[0]
    print(f'         last: {e.get(\"time\",\"\")[:19]}  {e.get(\"type\",\"\"):20s}  {e.get(\"message\",\"\")[:70]}')

# Show review outcomes
review_events = [e for e in events if e.get('type') == 'review_completed']
for e in review_events[:2]:
    print(f'         REVIEW: {e.get(\"time\",\"\")[:19]}  {e.get(\"message\",\"\")[:70]}')

print()
" 2>/dev/null

  sleep "$INTERVAL"
done
