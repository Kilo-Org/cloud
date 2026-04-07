# Local Debug Testing Guide

Guide for an AI agent to test gastown features locally — dispatching work, monitoring agents, triggering container eviction, and verifying the drain flow.

## Prerequisites

- Wrangler dev server running for gastown (`pnpm dev` in `cloudflare-gastown/`)
- Read the dev server port from the wrangler config (default: 8803)
- A town ID (ask the user or check the UI)
- Docker running (containers are managed by wrangler's container runtime)

## Quick Reference

```bash
BASE=http://localhost:8803
TOWN_ID="<town-id>"
```

## 1. Debug Endpoints

All `/debug/` endpoints are unauthenticated in local dev.

### Town Status

The primary status endpoint — shows agents, beads, alarm, patrol, and drain state:

```bash
curl -s $BASE/debug/towns/$TOWN_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d.get('alarmStatus', {})
print('Agents:', json.dumps(a.get('agents', {})))
print('Draining:', a.get('draining', False))
print()
for am in d.get('agentMeta', []):
    print(f\"  {am.get('role', '?'):12s} bead={am.get('bead_id', '?')[:8]} status={am.get('status', '?'):10s} hook={str(am.get('current_hook_bead_id', 'NULL'))[:8]}\")
print()
for b in d.get('beadSummary', []):
    if b.get('type') == 'issue' and b.get('status') in ('open', 'in_progress'):
        print(f\"  bead={b.get('bead_id', '?')[:8]} status={b.get('status', '?'):15s} {b.get('title', '')[:60]}\")
"
```

### Drain Status

```bash
curl -s $BASE/debug/towns/$TOWN_ID/drain-status | python3 -m json.tool
```

### Pending Nudges

```bash
curl -s $BASE/debug/towns/$TOWN_ID/nudges | python3 -m json.tool
```

### Send Message to Mayor (dev only)

Creates beads by telling the mayor what to do:

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a bead for this task: Write src/example.ts with 10 utility functions. Commit and push when done."}'
```

### Trigger Graceful Stop (dev only)

Sends SIGTERM to the container, initiating the drain flow:

```bash
curl -s -X POST $BASE/debug/towns/$TOWN_ID/graceful-stop
```

## 2. Container Monitoring

### Find the Active Container

```bash
CONTAINER_ID=$(docker ps --format "{{.ID}}\t{{.Image}}" | grep towncontainerdo | head -1 | awk '{print $1}')
echo "Container: $CONTAINER_ID"
```

### Container Health

```bash
docker exec $CONTAINER_ID curl -s http://localhost:8080/health | python3 -m json.tool
```

### Live Container Logs

Stream to a file for analysis:

```bash
docker logs -f $CONTAINER_ID > /tmp/container-logs.log 2>&1 &
```

### Filter Drain Logs

```bash
grep -E "\[drain\]|handleIdleEvent|idle timeout|agent\.(exit|start)|Drain complete" /tmp/container-logs.log
```

### Check Agent Events

```bash
docker logs $CONTAINER_ID 2>&1 | grep "Event #" | tail -10
```

## 3. Testing Graceful Container Eviction

### Full Test Loop

The recommended sequence for verifying the drain flow end-to-end:

#### Step 1: Verify clean state

```bash
# Not draining, agents are available
curl -s $BASE/debug/towns/$TOWN_ID/drain-status  # draining: false
curl -s $BASE/debug/towns/$TOWN_ID/status         # check agent statuses
```

#### Step 2: Send work to the mayor

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a bead for this task: <describe a task that takes 1-3 minutes>."}'
```

#### Step 3: Wait for a polecat to be dispatched and working

Poll until a polecat shows `status=working`:

```bash
for i in $(seq 1 40); do
  WORKING=$(curl -s $BASE/debug/towns/$TOWN_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
for am in d.get('agentMeta', []):
    if am.get('role') == 'polecat' and am.get('status') == 'working':
        print(f\"polecat:{am.get('bead_id', '?')[:8]}\")
" 2>/dev/null)
  echo "$(date +%H:%M:%S) $WORKING"
  if [ -n "$WORKING" ]; then echo "READY"; break; fi
  sleep 15
done
```

#### Step 4: Start monitoring container logs

```bash
CONTAINER_ID=$(docker ps --format "{{.ID}}\t{{.Image}}" | grep towncontainerdo | head -1 | awk '{print $1}')
docker logs -f $CONTAINER_ID > /tmp/drain-test.log 2>&1 &
```

#### Step 5: Trigger graceful stop

```bash
curl -s -X POST $BASE/debug/towns/$TOWN_ID/graceful-stop
```

#### Step 6: Monitor the drain

```bash
# Watch for container exit
for i in $(seq 1 60); do
  sleep 10
  RUNNING=$(docker ps -q --filter "id=$CONTAINER_ID")
  if [ -z "$RUNNING" ]; then
    echo "$(date +%H:%M:%S) CONTAINER EXITED"
    break
  fi
  DRAIN_LINE=$(grep "\[drain\]" /tmp/drain-test.log | tail -1)
  echo "$(date +%H:%M:%S) ${DRAIN_LINE:0:100}"
done
```

#### Step 7: Verify the drain log

```bash
grep -E "\[drain\]|handleIdleEvent.*(idle timeout fired)|agent\.(exit|start)|Drain complete" /tmp/drain-test.log
```

**Expected drain flow:**

1. `Phase 1: TownDO responded 200` — TownDO notified, dispatch blocked
2. `Phase 2: waiting up to 300s` — waiting for non-mayor agents
3. `Waiting for N non-mayor agents` — polling until agents finish or idle
4. `All N non-mayor agents are idle` — agents finished, timers pending
5. `idle timeout fired` / `agent.exit` — agents exit via normal path
6. `Phase 3: freezing N straggler(s)` — only the mayor (or truly stuck agents)
7. `Phase 3: force-saving agent ...` — WIP git commit for stragglers
8. `Drain complete` — container exits

#### Step 8: Verify post-drain state

```bash
# Drain flag should clear within ~30s (heartbeat instance ID detection)
curl -s $BASE/debug/towns/$TOWN_ID/drain-status

# Check bead states — evicted beads should be 'open' with eviction context
curl -s $BASE/debug/towns/$TOWN_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
for am in d.get('agentMeta', []):
    print(f\"  {am.get('role', '?'):12s} status={am.get('status', '?'):10s} hook={str(am.get('current_hook_bead_id', 'NULL'))[:8]}\")
"
```

## 4. Wrangler Management

### Restart Wrangler

When you need to pick up code changes:

```bash
# Kill existing
ps aux | grep -i wrangler | grep gastown | grep -v grep | awk '{print $2}' | xargs kill -9
ps aux | grep workerd | grep -v grep | awk '{print $2}' | xargs kill -9
sleep 3

# Start fresh
cd cloudflare-gastown && nohup pnpm dev > /tmp/gastown-wrangler.log 2>&1 &
sleep 25
curl -s http://localhost:8803/health
```

### Check Wrangler Logs

```bash
# Dispatch errors
grep -i "error\|failed\|dispatch" /tmp/gastown-wrangler.log | tail -20

# Container lifecycle
grep "container\|startAgent\|eviction" /tmp/gastown-wrangler.log | tail -20
```

## 5. Drain Architecture

### 3-Phase Drain (SIGTERM handler)

1. **Phase 1: Notify TownDO** — POST `/api/towns/:id/container-eviction`. Sets `_draining = true` on the TownDO, blocking new agent dispatch. Records the drain nonce and start time.

2. **Phase 2: Wait for agents** — Poll the container's local `agents` Map every 5s for up to 5 minutes. Excludes mayors (they never exit on their own). When all non-mayor agents have idle timers pending (meaning they called `gt_done` and went idle), polls at 1s for fast exit. Agents exit through the normal `exitAgent` → `reportAgentCompleted` path.

3. **Phase 3: Force-save stragglers** — Any agents still running after 5 minutes are frozen (SDK session aborted), WIP git committed and pushed, eviction context written on the bead body, and `reportAgentCompleted(agent, 'completed', 'container eviction')` called. The TownDO resets the bead to `open` and clears the assignee so the reconciler re-dispatches on the next tick.

### Drain Flag Clearing

The TownDO's `_draining` flag is cleared by whichever happens first:

- **Heartbeat instance ID change** (~30s): each container has a UUID. When a new container's heartbeat arrives with a different ID, the drain clears.
- **Nonce handshake**: the new container calls `/container-ready` with the drain nonce.
- **Hard timeout** (7 min): safety net if no heartbeat or handshake arrives.

### Key Behaviors During Drain

- `isDraining()` returns true → `/agents/start` returns 503
- `handleIdleEvent` skips `fetchPendingNudges` (avoids hanging outbound HTTP)
- Idle timeout is 10s (vs normal 120s/600s) so agents exit promptly
- `reconcileAgents` skips stale-heartbeat checks (heartbeat reporter is stopped)
- `reconcileGUPP` skips entirely (no false "idle for 15 minutes" nudges)
- Evicted `in_progress` beads are reset to `open` with assignee cleared

## 6. Common Issues

### Container Keeps Cycling

Containers start and immediately get killed (exit code 137). This is usually the wrangler container runtime recreating them. Kill all containers and restart wrangler cleanly:

```bash
docker kill $(docker ps -q) 2>/dev/null
# Then restart wrangler (see section 4)
```

### Drain Stuck "Waiting for N agents"

Agents show as `running` but aren't doing work. Common causes:

- **`fetchPendingNudges` hanging**: should be skipped during drain (check `_draining` flag)
- **`server.heartbeat` clearing idle timer**: these events should be in `IDLE_TIMER_IGNORE_EVENTS`
- **Agent in `starting` status**: `session.prompt()` blocking. Status is set to `running` before the prompt now.

### Drain Flag Persists After Restart

The drain banner stays visible after the container restarted. Causes:

- **No heartbeats arriving**: container failed to start, no agents registered
- **`_containerInstanceId` not persisted**: should be in `ctx.storage`
- Fallback: wait for the 7-minute hard timeout

### Git Credential Errors

Container starts but agents fail at `git clone`:

```
Error checking if container is ready: Invalid username
```

This means the git token is stale/expired. Refresh credentials in the town settings.

### Accumulating Escalation Beads

Triage/escalation beads pile up with `rig_id=NULL`. These are by design:

- `type=escalation` beads surface for human attention (merge conflicts, rework)
- `type=issue` triage beads are handled by `maybeDispatchTriageAgent`
- GUPP force-stop beads are created by the patrol system for stuck agents

During testing, container restarts generate many of these. Bulk-close via admin panel if needed.

## 7. Auto-Merge with Workers AI Thread Classification

The auto-merge flow uses Workers AI (Gemma 4 26B) to classify unresolved PR review threads as blocking vs non-blocking. This prevents informational bot comments (status reports, code review summaries) from blocking auto-merge.

### How It Works

1. `poll_pr` runs every ~60s for MR beads with a `pr_url`
2. `checkPRFeedback` fetches review threads via GitHub GraphQL (including comment bodies)
3. If unresolved threads exist, `areThreadsBlocking()` sends them to Workers AI
4. The model classifies threads as BLOCKING (requires code changes, bugs, security) or NON-BLOCKING (informational, nits, bot status reports)
5. Only truly blocking threads prevent auto-merge

### Config Required

Set these on the town config (via `PATCH /debug/towns/:townId/config`):

```json
{
  "refinery": {
    "auto_merge": true,
    "auto_merge_delay_minutes": 0,
    "auto_resolve_pr_feedback": true
  }
}
```

### Testing Locally

The `areThreadsBlocking` AI call only triggers when:

- An MR bead has a `pr_url` (external GitHub PR exists)
- The PR has unresolved review threads on GitHub
- `auto_merge` is enabled in the town config

In local dev, PRs created by the refinery in review-and-merge mode may not create external GitHub PRs, so the AI classification branch won't fire. To test the AI path end-to-end:

1. Manually create a PR with unresolved review comments on the target repo
2. Create an MR bead that references that PR
3. Watch the wrangler logs for `areThreadsBlocking` output

### Monitoring in Production

Query Analytics Engine for the `areThreadsBlocking` log output:

```bash
# Check wrangler tail for AI classification logs
npx wrangler tail gastown --format json --search "areThreadsBlocking"
```

The `areThreadsBlocking` method logs its decision:

```
[town] areThreadsBlocking: blocking=false reason=<explanation> threads=2
```

If the AI call fails, it conservatively defaults to `blocking=true` and logs a warning.
