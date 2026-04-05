# E2E Local Testing: PR Feedback Auto-Resolve & Auto-Merge

Guide for an AI agent to test the PR feedback auto-resolve and auto-merge feature locally. Covers the full lifecycle for both single beads and convoys.

## Architecture Overview

When `merge_strategy: 'pr'` is configured:

1. **Polecat creates the PR** — pushes branch, runs `gh pr create`, passes `pr_url` to `gt_done`
2. **Refinery reviews the existing PR** — runs quality gates, reviews diff, adds GitHub review comments (approve or request changes)
3. **Auto-resolve detects comments** — `poll_pr` checks for unresolved review threads, dispatches polecat to fix
4. **Auto-merge** — once all comments resolved and CI passes, grace period timer starts, then PR is merged via API

## Prerequisites

- Wrangler dev server running for gastown (`pnpm dev` in `cloudflare-gastown/`, port 8803)
- Docker running (containers are managed by wrangler's container runtime)
- A town with an active container and at least one rig configured with a GitHub repo
- `gh` CLI authenticated (for adding PR comments and verifying merges)

## Quick Reference

```bash
BASE=http://localhost:8803
TOWN_ID="${TOWN_ID:-a093a551-ff4d-4c36-9274-252df66128fd}"
RIG_ID="${RIG_ID:-mega-todo-app5}"
REPO="${REPO:-jrf0110/mega-todo-app5}"
```

## 1. Verify Town Settings

Check these settings in the town settings UI:

| Setting                  | Required Value                 |
| ------------------------ | ------------------------------ |
| Merge strategy           | `pr` (Pull Request)            |
| Auto-merge               | enabled                        |
| Auto-resolve PR feedback | enabled                        |
| Auto-merge delay         | 2 minutes (or preferred delay) |

### Verify Clean State

```bash
curl -s $BASE/debug/towns/$TOWN_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
alarm = d.get('alarmStatus', {})
print('Agents:', json.dumps(alarm.get('agents', {})))
print('Beads:', json.dumps(alarm.get('beads', {})))
summary = d.get('beadSummary', [])
if summary:
    print(f'WARNING: {len(summary)} non-terminal bead(s)')
    for b in summary:
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:60]}')
else:
    print('Clean state.')
"
```

---

## Test A: Single Bead Flow

### A.1. Send Work to the Mayor

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a bead for this task on the $RIG_ID rig: Add a new utility file src/utils/string-helpers.ts with 5 string utility functions (capitalize, truncate, slugify, camelToKebab, kebabToCamel). Each function should have JSDoc comments. Commit and push when done.\"}"
```

### A.2. Wait for Polecat to Create PR

The polecat now creates the PR itself. Poll until the MR bead appears with a PR URL:

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    btype = b.get('type', '?')
    if btype in ('issue', 'merge_request'):
        print(f'  {btype:16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:55]}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle':
        hook = str(am.get('current_hook_bead_id', 'NULL') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:3]:
    t = e.get('type', '')
    if 'pr_' in t or 'created' in t or 'review' in t:
        print(f'  EVT: {t:20s} {e.get(\"message\",\"\")[:60]}')
" 2>/dev/null
  MR_READY=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    if b.get('type') == 'merge_request':
        print('MR_EXISTS')
        break
" 2>/dev/null)
  if [ "$MR_READY" = "MR_EXISTS" ]; then echo "=== MR BEAD CREATED (polecat created PR) ==="; break; fi
  sleep 15
done
```

**Expected:** The polecat creates the PR and calls `gt_done(branch, pr_url)`. The MR bead appears as `open`.

### A.3. Verify PR Exists on GitHub

```bash
gh pr list --repo $REPO --state open --limit 5 --json number,title,headRefName,createdAt
```

Record the PR number:

```bash
PR_NUMBER=<number>
```

### A.4. Wait for Refinery Review

The refinery is dispatched to review the existing PR. It runs quality gates, reviews the diff, and adds review comments. Watch for the refinery to complete:

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    if b.get('type') == 'merge_request':
        print(f'  MR: status={b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:50]}')
for am in d.get('agentMeta', []):
    if am.get('role') == 'refinery' and am.get('status') != 'idle':
        print(f'  refinery: status={am.get(\"status\",\"?\"):10s}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:3]:
    t = e.get('type', '')
    if 'pr_' in t or 'review' in t:
        print(f'  EVT: {t:20s} {e.get(\"message\",\"\")[:60]}')
" 2>/dev/null
  # MR in_progress means refinery called gt_done with pr_url
  IN_PROGRESS=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    if b.get('type') == 'merge_request' and b.get('status') == 'in_progress':
        print('yes')
" 2>/dev/null)
  if [ "$IN_PROGRESS" = "yes" ]; then echo "=== REFINERY DONE — MR in_progress, poll_pr active ==="; break; fi
  sleep 15
done
```

### A.5. Check for Refinery Comments (Optional)

If the refinery requested changes, an auto-resolve cycle will begin automatically. Check:

```bash
gh api graphql -f query='query {
  repository(owner: "'$(echo $REPO | cut -d/ -f1)'", name: "'$(echo $REPO | cut -d/ -f2)'") {
    pullRequest(number: '$PR_NUMBER') {
      reviewThreads(first: 100) {
        nodes { isResolved, comments(first: 1) { nodes { body, author { login } } } }
      }
    }
  }
}'
```

### A.6. Add a Human Review Comment

To test the human feedback loop, add a review with inline comments:

```bash
gh api repos/$REPO/pulls/$PR_NUMBER/reviews \
  --method POST \
  --input - <<'EOF'
{
  "event": "REQUEST_CHANGES",
  "body": "The capitalize function needs input validation.",
  "comments": [
    {
      "path": "src/utils/string-helpers.ts",
      "position": 5,
      "body": "Please add input validation - handle empty strings and non-string inputs gracefully."
    }
  ]
}
EOF
```

**Note:** You must use inline comments (with `path` and `position`) to create review threads. The `checkPRFeedback` function detects **unresolved review threads** via GitHub GraphQL, not review state.

### A.7. Observe Feedback Detection and Resolution

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    title = str(b.get('title', ''))
    if b.get('type') in ('issue', 'merge_request'):
        marker = ' <-- FEEDBACK' if ('Address' in title or 'PR #' in title) else ''
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:50]}{marker}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle':
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s}')
" 2>/dev/null
  sleep 10
done
```

### A.8. Wait for Auto-Merge

After all review threads are resolved and CI passes, the auto-merge timer starts (configured delay, e.g. 2 minutes). Monitor until all beads close:

```bash
echo "Waiting for auto-merge..."
MERGE_START=$(date +%s)
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  ELAPSED=$(( $(date +%s) - MERGE_START ))
  echo "$(date +%H:%M:%S) [${ELAPSED}s]"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
beads = d.get('beadSummary', [])
relevant = [b for b in beads if b.get('type') in ('merge_request',) or 'string' in str(b.get('title','')).lower() or 'Address' in str(b.get('title',''))]
if not relevant:
    print('  ALL DONE')
else:
    for b in relevant:
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:50]}')
" 2>/dev/null
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
beads = d.get('beadSummary', [])
relevant = [b for b in beads if b.get('type') in ('merge_request',) or 'string' in str(b.get('title','')).lower() or 'Address' in str(b.get('title',''))]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== AUTO-MERGE COMPLETE ==="; break; fi
  sleep 10
done
```

### A.9. Verify Merge

```bash
gh pr view $PR_NUMBER --repo $REPO --json state,mergedAt
```

---

## Test B: 3-Bead Convoy Flow

This tests the review-and-merge convoy mode where each bead gets its own PR, review, and auto-merge.

### B.1. Send Convoy Work to the Mayor

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a convoy of 3 beads on the $RIG_ID rig with merge mode review-and-merge. The beads should be: (1) Add src/utils/array-helpers.ts with functions: unique, flatten, chunk, zip, groupBy. (2) Add src/utils/object-helpers.ts with functions: pick, omit, deepClone, merge, hasKey. (3) Add src/utils/math-helpers.ts with functions: clamp, lerp, roundTo, sum, average. Each file should have JSDoc comments and a simple test file alongside it. Use review-and-merge mode so each bead gets its own PR.\"}"
```

### B.2. Monitor All 3 Beads

Poll the status showing all beads and their progress:

```bash
for i in $(seq 1 120); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
beads = d.get('beadSummary', [])
for b in beads:
    btype = b.get('type', '?')
    if btype in ('issue', 'merge_request', 'convoy'):
        print(f'  {btype:16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:55]}')
agents = d.get('agentMeta', [])
active = [a for a in agents if a.get('status') != 'idle']
for am in active:
    hook = str(am.get('current_hook_bead_id', 'NULL') or 'NULL')[:8]
    print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
alarm = d.get('alarmStatus', {})
recon = alarm.get('reconciler', {})
actions = recon.get('actionsByType', {})
if actions:
    print(f'  reconciler: {json.dumps(actions)}')
" 2>/dev/null
  # Check if all relevant beads are closed
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
beads = d.get('beadSummary', [])
relevant = [b for b in beads if b.get('type') in ('issue', 'merge_request', 'convoy') and ('helper' in str(b.get('title','')).lower() or 'Review' in str(b.get('title','')) or 'convoy' in b.get('type',''))]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== ALL CONVOY BEADS COMPLETE ==="; break; fi
  sleep 15
done
```

### B.3. Verify All PRs Merged

```bash
gh pr list --repo $REPO --state merged --limit 10 --json number,title,mergedAt | python3 -c "
import sys, json
prs = json.load(sys.stdin)
today = '$(date -u +%Y-%m-%d)'
for pr in prs:
    if today in pr.get('mergedAt', ''):
        print(f'  PR #{pr[\"number\"]}: {pr[\"title\"]} (merged: {pr[\"mergedAt\"][:19]})')
"
```

---

## Expected Timeline

### Single Bead

| Step                                 | Duration              |
| ------------------------------------ | --------------------- |
| Mayor slings bead                    | ~30s                  |
| Polecat works + creates PR           | 2-5 min               |
| Refinery reviews PR, adds comments   | 2-5 min               |
| Feedback detected + polecat resolves | 2-5 min (if comments) |
| Auto-merge grace period              | 2 min (configured)    |
| **Total**                            | **8-17 min**          |

### 3-Bead Convoy (review-and-merge)

| Step                                     | Duration                 |
| ---------------------------------------- | ------------------------ |
| Mayor creates convoy + 3 beads           | ~1 min                   |
| 3 polecats work in parallel + create PRs | 2-5 min                  |
| 3 refinery reviews (sequential per rig)  | 5-15 min                 |
| Feedback resolution cycles               | 2-5 min each (if needed) |
| Auto-merge per PR                        | 2 min grace each         |
| **Total**                                | **15-30 min**            |

---

## Troubleshooting

### Polecat Doesn't Create PR

If the polecat pushes but doesn't create a PR:

- Check the polecat's system prompt includes "Pull Request Creation" section
- Verify `merge_strategy` is `pr` in town settings
- Check wrangler logs for the polecat's agent output

### Refinery Tries to Create a New PR

If the refinery creates a duplicate PR instead of reviewing the existing one:

- Check that `review_metadata.pr_url` is set on the MR bead (polecat should have passed it)
- The refinery prompt switches to "PR review mode" only when `existingPrUrl` is set

### Feedback Not Detected

`checkPRFeedback` checks for **unresolved review threads** via GitHub GraphQL, not review state. A `REQUEST_CHANGES` review without inline/line comments does NOT create review threads. Use reviews with `comments[].path` and `comments[].position` to create detectable threads.

### Auto-Merge Stuck

- `allChecksPass` requires either (a) 0 check-runs (no CI = pass) or (b) all check-runs completed successfully. If the repo has CI, all checks must pass.
- The GitHub token in town config must be valid. Check wrangler logs for `401` errors from `checkPRStatus` or `checkPRFeedback`.
- Check `auto_merge_delay_minutes` is set (not null) in town config.

### Convoy Beads Not Dispatching

- In `review-and-merge` mode, each bead is independent — no sequencing dependencies.
- In `review-then-land` mode, beads with `blocks` dependencies wait for their predecessors. Intermediate beads do NOT create PRs (the refinery merges directly to the feature branch).

### Container Networking (Local Dev)

The wrangler container runtime occasionally fails to route DO `container.fetch()` to the container's port 8080 — `send-message` returns `sessionStatus: "idle"` even though Docker shows the container as healthy. Workarounds:

1. **Have a human start wrangler** via the terminal (not `nohup`). The TTY seems to help with container proxy setup.
2. **Kill all containers and restart wrangler cleanly** — stale proxy state can prevent new connections.
3. **Wait 30-60s after wrangler starts** before sending messages — the container needs time to fully initialize.
4. The `GET /health` endpoint returning 200 does NOT mean the DO-to-container path works. The DO's `container.fetch()` uses a different routing mechanism.

---

## Debug Endpoints

### Inspect a Bead

Get full bead details including review_metadata and dependencies:

```bash
curl -s $BASE/debug/towns/$TOWN_ID/beads/<bead_id> | python3 -c "
import sys, json
d = json.load(sys.stdin)
bead = d.get('bead', {})
print(f'Type: {bead.get(\"type\")}  Status: {bead.get(\"status\")}')
print(f'Title: {bead.get(\"title\")}')
print(f'Parent: {bead.get(\"parent_bead_id\", \"NULL\")}')
rm = d.get('reviewMetadata')
if rm:
    print(f'PR URL: {rm.get(\"pr_url\")}')
    print(f'Branch: {rm.get(\"branch\")} -> {rm.get(\"target_branch\")}')
    print(f'Auto-merge ready since: {rm.get(\"auto_merge_ready_since\", \"NULL\")}')
    print(f'Last feedback check: {rm.get(\"last_feedback_check_at\", \"NULL\")}')
deps = d.get('dependencies', [])
if deps:
    print(f'Dependencies ({len(deps)}):')
    for dep in deps:
        print(f'  {dep[\"bead_id\"][:8]} -> {dep[\"depends_on_bead_id\"][:8]} ({dep[\"dependency_type\"]})')
"
```

### Verify Bead Chain (parent_bead_id linkage)

After a rework or feedback cycle, verify the chain:

```bash
# Get the MR bead
MR_ID=<mr_bead_id>
curl -s $BASE/debug/towns/$TOWN_ID/beads/$MR_ID | python3 -c "
import sys, json
d = json.load(sys.stdin)
deps = d.get('dependencies', [])
print('MR bead dependencies:')
for dep in deps:
    print(f'  {dep[\"dependency_type\"]}: {dep[\"depends_on_bead_id\"][:12]}')
"
# Then check a rework/feedback bead's parent
REWORK_ID=<rework_bead_id>
curl -s $BASE/debug/towns/$TOWN_ID/beads/$REWORK_ID | python3 -c "
import sys, json
bead = json.load(sys.stdin).get('bead', {})
print(f'parent_bead_id: {bead.get(\"parent_bead_id\", \"NULL\")}')
# Should match the MR bead ID
"
```

---

## Test C: Code Review Toggle (refinery disabled)

Tests the `refinery.code_review` setting — when disabled, MR beads skip the refinery and go directly to `poll_pr`.

### C.1. Disable Code Review

In the town settings UI, set **Refinery code review** to disabled (unchecked).

### C.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a bead for this task on the $RIG_ID rig: Add src/utils/type-guards.ts with functions: isString, isNumber, isArray, isObject, isNonNullable. Each with JSDoc. Commit and push.\"}"
```

### C.3. Verify MR Bead Skips Refinery

Watch for the MR bead to go directly from `open` to `in_progress` without a refinery being dispatched:

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    if b.get('type') == 'merge_request':
        print(f'  MR: {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:50]}')
for am in d.get('agentMeta', []):
    if am.get('role') == 'refinery' and am.get('status') != 'idle':
        print(f'  WARNING: refinery is {am.get(\"status\")} — should be idle!')
" 2>/dev/null
  sleep 15
done
```

**Expected:** The MR bead transitions from `open` → `in_progress` by the reconciler (not the refinery). No refinery agents should become `working`. The `poll_pr` action should start immediately.

### C.4. Re-enable Code Review

After testing, re-enable **Refinery code review** in town settings.
