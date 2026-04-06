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

## Pre-Flight Checklist

Run this before EACH scenario to validate town state.

### 1. Verify/Update Town Settings via Debug API

The debug config endpoint (dev only) allows reading and updating town configuration without auth:

```bash
# Read current settings
curl -s $BASE/debug/towns/$TOWN_ID/config | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('merge_strategy:', d.get('merge_strategy'))
ref = d.get('refinery', {})
print('refinery.code_review:', ref.get('code_review'))
print('refinery.auto_merge:', ref.get('auto_merge'))
print('refinery.auto_resolve_pr_feedback:', ref.get('auto_resolve_pr_feedback'))
print('refinery.auto_merge_delay_minutes:', ref.get('auto_merge_delay_minutes'))
print('refinery.review_mode:', ref.get('review_mode'))
"
```

Update settings with PATCH (partial update, unspecified fields preserved):

```bash
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "refinery": {
      "code_review": false,
      "auto_merge": true,
      "auto_resolve_pr_feedback": true,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }'
```

### 2. Verify Clean State

```bash
curl -s $BASE/debug/towns/$TOWN_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
alarm = d.get('alarmStatus', {})
agents = alarm.get('agents', {})
beads = alarm.get('beads', {})
recon = alarm.get('reconciler', {})
print('Agents:', json.dumps(agents))
print('Beads:', json.dumps(beads))
print(f'Reconciler: violations={recon.get(\"invariantViolations\", \"?\")}, pending={recon.get(\"pendingEventCount\", \"?\")}')
summary = d.get('beadSummary', [])
if summary:
    print(f'WARNING: {len(summary)} non-terminal bead(s)')
    for b in summary:
        assignee = b.get('assignee_agent_bead_id') or 'none'
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {assignee[:12]:14s} {str(b.get(\"title\",\"\"))[:50]}')
else:
    print('Clean state.')
active = [am for am in d.get('agentMeta', []) if am.get('status') != 'idle']
if active:
    print(f'Active agents ({len(active)}):')
    for am in active:
        print(f'  {am[\"role\"]:12s} {am[\"status\"]:10s}')
"
```

### 3. Wait for Active Agents to Settle

If agents are still working from a previous test, wait:

```bash
for i in $(seq 1 20); do
  WORKING=$(curl -s $BASE/debug/towns/$TOWN_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
w = d.get('alarmStatus', {}).get('agents', {}).get('working', 0)
print(w)
" 2>/dev/null)
  echo "$(date +%H:%M:%S) working=$WORKING"
  if [ "$WORKING" -le 1 ]; then echo "Settled"; break; fi
  sleep 15
done
```

Note: The mayor often stays `working` for extended periods while processing stale triage beads. It's safe to proceed with `working=1` if only the mayor is active.

---

## Scenario 1: Auto-Merge Without Code Review

**Settings:** `merge_strategy=pr`, `code_review=false`, `auto_resolve_pr_feedback=false`, `auto_merge=true`, `auto_merge_delay_minutes=2`

**Goal:** Verify that with code review disabled, the polecat creates a PR and it auto-merges without refinery involvement.

### 1.1. Configure Settings

```bash
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "refinery": {
      "code_review": false,
      "auto_merge": true,
      "auto_resolve_pr_feedback": false,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }' | python3 -c "
import sys, json; d = json.load(sys.stdin); ref = d.get('refinery', {})
print(f'code_review={ref.get(\"code_review\")} auto_merge={ref.get(\"auto_merge\")} delay={ref.get(\"auto_merge_delay_minutes\")}')
"
```

### 1.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a bead for this task on the $RIG_ID rig: Add a new file src/utils/color-helpers.ts with 3 simple utility functions (hexToRgb, rgbToHex, lightenColor). Each function should have JSDoc comments. Commit and push when done.\"}"
```

### 1.3. Monitor Until Complete

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    title = b.get('title', '') or ''
    if 'color' in title.lower() or b.get('type') == 'merge_request':
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:60]}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle':
        hook = str(am.get('current_hook_bead_id') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:3]:
    t = e.get('type', '')
    msg = e.get('message', '')
    if 'color' in msg.lower() or 'pr_' in t or 'merge' in t.lower():
        print(f'  EVT: {t:20s} {msg[:60]}')
" 2>/dev/null
  sleep 15
done
```

### 1.4. Verify

```bash
# Check PR was merged
gh pr list --repo $REPO --state merged --limit 3 --json number,title,mergedAt,mergedBy

# Check no stray post-merge comments
PR_NUMBER=<number>
gh api repos/$REPO/issues/$PR_NUMBER/comments --jq 'length'
gh api repos/$REPO/pulls/$PR_NUMBER/comments --jq 'length'
```

### Expected Outcome

- Polecat creates PR (not refinery)
- No refinery agent becomes `working`
- MR bead transitions `open` → `in_progress` (fast-tracked by reconciler)
- Auto-merge fires after ~2 min delay
- PR merged on GitHub, no post-merge comments

### Historical Test Results (2026-04-05)

Early test rounds found two issues that have since been addressed:

1. **Refinery dispatched during `pr_url=null` window** — Fixed by transitioning all open MR beads with `pr_url` when `code_review=false`, and always dispatching the refinery for direct-merge beads.
2. **Polecat not reliably creating PRs** — The polecat LLM occasionally skips the `gh pr create` step despite prompt instructions. This is a prompt reliability issue, not a code bug. The system prompt includes clear PR creation instructions; LLM compliance varies by run.

---

## Scenario 2: Refinery Review (Rework Mode) + Auto-Merge

**Settings:** `merge_strategy=pr`, `code_review=true`, `review_mode=rework`, `auto_resolve_pr_feedback=false`, `auto_merge=true`, `auto_merge_delay_minutes=2`

**Goal:** Verify the full review pipeline: polecat pushes code, refinery reviews and creates PR, optional rework, then auto-merge.

### 2.1. Configure Settings

```bash
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "refinery": {
      "code_review": true,
      "auto_merge": true,
      "auto_resolve_pr_feedback": false,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }' | python3 -c "
import sys, json; d = json.load(sys.stdin); ref = d.get('refinery', {})
print(f'code_review={ref.get(\"code_review\")} review_mode={ref.get(\"review_mode\")} auto_merge={ref.get(\"auto_merge\")}')
"
```

### 2.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a bead for this task on the $RIG_ID rig: Add a new file src/utils/date-helpers.ts with 3 utility functions (formatDate, daysBetween, isLeapYear). Each function should have JSDoc comments. Commit and push when done.\"}"
```

### 2.3. Monitor Until Complete

```bash
for i in $(seq 1 80); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    title = b.get('title', '') or ''
    if 'date' in title.lower() or b.get('type') == 'merge_request':
        marker = ' <-- REWORK' if 'Rework' in title else ''
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:55]}{marker}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle' and am.get('role') != 'mayor':
        hook = str(am.get('current_hook_bead_id') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:5]:
    t = e.get('type', '')
    msg = e.get('message', '')
    if 'date' in msg.lower() or 'pr_' in t or 'rework' in msg.lower() or 'review' in t:
        print(f'  EVT: {t:24s} {msg[:70]}')
" 2>/dev/null
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
beads = d.get('beadSummary', [])
relevant = [b for b in beads if 'date' in str(b.get('title','')).lower()]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== SCENARIO 2 COMPLETE ==="; break; fi
  sleep 15
done
```

### 2.4. Verify

```bash
# Check PR was merged
gh pr list --repo $REPO --state merged --limit 3 --json number,title,mergedAt

# Check for rework beads (if refinery requested changes)
# Look for beads titled "Rework: ..." with parent_bead_id matching the MR bead
MR_BEAD_ID=<mr_bead_id>
curl -s $BASE/debug/towns/$TOWN_ID/beads/$MR_BEAD_ID | python3 -c "
import sys, json
d = json.load(sys.stdin)
rm = d.get('reviewMetadata')
if rm:
    print(f'PR URL: {rm.get(\"pr_url\")}')
deps = d.get('dependencies', [])
for dep in deps:
    print(f'  {dep[\"dependency_type\"]}: {dep[\"depends_on_bead_id\"][:12]}')
"

# Check no stray post-merge comments
PR_NUMBER=<number>
MERGE_TIME=$(gh pr view $PR_NUMBER --repo $REPO --json mergedAt --jq '.mergedAt')
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq ".[] | select(.created_at > \"$MERGE_TIME\") | {created_at, body: (.body[:80])}"
```

### Expected Outcome

- Polecat pushes code and calls `gt_done`
- MR bead created as `open`
- Refinery dispatched, reviews diff, calls `gt_done` (with `pr_url`)
- If refinery requests changes: rework bead created with `parent_bead_id = MR bead`
- If refinery approves: MR bead → `in_progress`, `poll_pr` starts
- Auto-merge fires after ~2 min delay
- No stray post-merge comments

### Expected Timeline

| Step                         | Duration     |
| ---------------------------- | ------------ |
| Mayor slings bead            | ~30s         |
| Polecat works + pushes code  | 2-5 min      |
| Refinery reviews, creates PR | 1-3 min      |
| Rework cycle (if needed)     | 2-5 min      |
| Auto-merge grace period      | 2 min        |
| **Total**                    | **6-15 min** |

---

## Scenario 3: Human Feedback + Auto-Resolve + Auto-Merge

**Settings:** `merge_strategy=pr`, `code_review=false`, `auto_resolve_pr_feedback=true`, `auto_merge=true`, `auto_merge_delay_minutes=2`

**Goal:** Verify the human feedback loop: polecat creates PR, human adds review comment, system detects and resolves it, then auto-merges.

### 3.1. Configure Settings

```bash
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "refinery": {
      "code_review": false,
      "auto_merge": true,
      "auto_resolve_pr_feedback": true,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }' | python3 -c "
import sys, json; d = json.load(sys.stdin); ref = d.get('refinery', {})
print(f'code_review={ref.get(\"code_review\")} auto_resolve={ref.get(\"auto_resolve_pr_feedback\")} auto_merge={ref.get(\"auto_merge\")}')
"
```

### 3.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/towns/$TOWN_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a bead for this task on the $RIG_ID rig: Add a new file src/utils/array-helpers.ts with 3 utility functions (unique, flatten, chunk). Each function should have JSDoc comments and handle edge cases. Commit and push when done.\"}"
```

### 3.3. Wait for PR Creation

Monitor until the PR appears on GitHub:

```bash
for i in $(seq 1 40); do
  PR_EXISTS=$(gh pr list --repo $REPO --state open --json number,headRefName,title \
    --jq '.[] | select(.title | test("array|Array"; "i")) | .number' 2>/dev/null | head -1)
  echo "$(date +%H:%M:%S) PR=$PR_EXISTS"
  if [ -n "$PR_EXISTS" ]; then echo "=== PR #$PR_EXISTS FOUND ==="; break; fi
  sleep 15
done
PR_NUMBER=$PR_EXISTS
```

### 3.4. Add Human Review Comment

Get the diff to find a valid position, then add a review with inline feedback:

```bash
# View diff to find a valid file and position
gh pr diff $PR_NUMBER --repo $REPO | head -30

# Add a review with inline comment (creates a review thread)
gh api repos/$REPO/pulls/$PR_NUMBER/reviews \
  --method POST \
  --input - <<EOF
{
  "event": "REQUEST_CHANGES",
  "body": "The unique function needs input validation.",
  "comments": [
    {
      "path": "src/utils/array-helpers.ts",
      "position": 8,
      "body": "Please add input validation for null and undefined values - throw a TypeError with a descriptive message if the input is not an array."
    }
  ]
}
EOF
```

**Important:** You must use inline comments (with `path` and `position`) to create review threads. The `checkPRFeedback` function detects **unresolved review threads** via GitHub GraphQL, not review state. A `REQUEST_CHANGES` review without inline comments does NOT create detectable threads.

### 3.5. Monitor Feedback Resolution and Auto-Merge

```bash
for i in $(seq 1 80); do
  STATUS=$(curl -s $BASE/debug/towns/$TOWN_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('beadSummary', []):
    title = b.get('title', '') or ''
    if 'array' in title.lower() or 'Address' in title or '#$PR_NUMBER' in title:
        marker = ' <-- FEEDBACK' if 'Address' in title else ''
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:55]}{marker}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle' and am.get('role') != 'mayor':
        hook = str(am.get('current_hook_bead_id') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:5]:
    t = e.get('type', '')
    msg = e.get('message', '')
    if 'array' in msg.lower() or 'Address' in msg or 'feedback' in msg.lower():
        print(f'  EVT: {t:24s} {msg[:70]}')
" 2>/dev/null
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
beads = d.get('beadSummary', [])
relevant = [b for b in beads if 'array' in str(b.get('title','')).lower() or 'Address' in str(b.get('title',''))]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== SCENARIO 3 COMPLETE ==="; break; fi
  sleep 15
done
```

### 3.6. Verify

```bash
# Check PR was merged
gh pr view $PR_NUMBER --repo $REPO --json state,mergedAt,mergedBy

# Verify review thread was resolved
gh api graphql -f query='query {
  repository(owner: "'$(echo $REPO | cut -d/ -f1)'", name: "'$(echo $REPO | cut -d/ -f2)'") {
    pullRequest(number: '$PR_NUMBER') {
      reviewThreads(first: 100) {
        nodes { isResolved, comments(first: 3) { nodes { body, author { login }, createdAt } } }
      }
    }
  }
}'

# Check no stray post-merge comments
MERGE_TIME=$(gh pr view $PR_NUMBER --repo $REPO --json mergedAt --jq '.mergedAt')
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq ".[] | select(.created_at > \"$MERGE_TIME\") | {created_at, body: (.body[:80])}"
```

### Expected Outcome

- Polecat creates PR
- Human adds REQUEST_CHANGES review with inline comment
- `poll_pr` detects unresolved review thread within ~30s
- Feedback bead created: "Address review comments on PR #N"
- Feedback bead has `parent_bead_id` = MR bead
- Polecat dispatched to resolve feedback
- Polecat pushes fix and resolves review thread on GitHub
- Auto-merge fires after ~2 min delay
- PR merged, no post-merge comments

### Expected Timeline

| Step                           | Duration          |
| ------------------------------ | ----------------- |
| Mayor slings bead              | ~30s              |
| Polecat works + creates PR     | 2-5 min           |
| Human adds review comment      | manual            |
| Feedback detected by poll_pr   | ~30s (poll cycle) |
| Polecat resolves feedback      | 1-3 min           |
| Auto-merge grace period        | 2 min             |
| **Total (from human comment)** | **4-6 min**       |

---

## Test A: Single Bead Flow (Full Pipeline)

This is the original comprehensive test that exercises the full pipeline: polecat → refinery review → human feedback → auto-resolve → auto-merge.

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

## Expected Timelines

### Scenario 1 (No Review + Auto-Merge)

| Step                       | Duration    |
| -------------------------- | ----------- |
| Mayor slings bead          | ~30s        |
| Polecat works + creates PR | 2-5 min     |
| Auto-merge grace period    | 2 min       |
| **Total**                  | **5-8 min** |

### Scenario 2 (Refinery Review + Auto-Merge)

| Step                          | Duration     |
| ----------------------------- | ------------ |
| Mayor slings bead             | ~30s         |
| Polecat works + pushes code   | 2-5 min      |
| Refinery reviews + creates PR | 1-3 min      |
| Rework cycle (if needed)      | 2-5 min      |
| Auto-merge grace period       | 2 min        |
| **Total**                     | **6-15 min** |

### Scenario 3 (Human Feedback + Auto-Resolve + Auto-Merge)

| Step                       | Duration     |
| -------------------------- | ------------ |
| Mayor slings bead          | ~30s         |
| Polecat works + creates PR | 2-5 min      |
| Human adds review comment  | manual       |
| Feedback detected          | ~30s         |
| Polecat resolves feedback  | 1-3 min      |
| Auto-merge grace period    | 2 min        |
| **Total (from task sent)** | **8-12 min** |

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

### Refinery Dispatches Despite `code_review=false`

The reconciler's `code_review` bypass (reconciler.ts ~line 1167) only fast-tracks MR beads that already have a `pr_url` in `review_metadata`. When a new MR bead is created, there's a timing window where the MR bead exists but has no `pr_url`, causing the reconciler to dispatch the refinery via Rule 5.

**Root cause:** The polecat calls `review_submitted` which creates the MR bead, but the `pr_url` is set asynchronously. During the gap, the reconciler treats it as a direct-merge MR (no `pr_url`), bypassing the `code_review=false` skip.

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

### Mayor Creates Duplicate Beads

When the mayor is already working (e.g., processing stale triage beads) and receives a new message, it may create duplicate beads for the same task. This leads to duplicate PRs and orphaned beads. Wait for the mayor to be idle before sending new tasks.

### Container Networking (Local Dev)

The wrangler container runtime occasionally fails to route DO `container.fetch()` to the container's port 8080 — `send-message` returns `sessionStatus: "idle"` even though Docker shows the container as healthy. Workarounds:

1. **Have a human start wrangler** via the terminal (not `nohup`). The TTY seems to help with container proxy setup.
2. **Kill all containers and restart wrangler cleanly** — stale proxy state can prevent new connections.
3. **Wait 30-60s after wrangler starts** before sending messages — the container needs time to fully initialize.
4. The `GET /health` endpoint returning 200 does NOT mean the DO-to-container path works. The DO's `container.fetch()` uses a different routing mechanism.

---

## Debug Endpoints

All `/debug/` endpoints are unauthenticated in development. In production, they're protected by Cloudflare Access.

| Method  | Path                                     | Description                                              |
| ------- | ---------------------------------------- | -------------------------------------------------------- |
| `GET`   | `/debug/towns/:townId/status`            | Primary status: agents, beads, alarm, patrol, reconciler |
| `GET`   | `/debug/towns/:townId/config`            | Read town config (dev only)                              |
| `PATCH` | `/debug/towns/:townId/config`            | Update town config (dev only, partial update)            |
| `POST`  | `/debug/towns/:townId/reconcile-dry-run` | Run reconciler without applying actions                  |
| `POST`  | `/debug/towns/:townId/replay-events`     | Replay events from time range                            |
| `GET`   | `/debug/towns/:townId/drain-status`      | Drain flag + nonce                                       |
| `GET`   | `/debug/towns/:townId/nudges`            | Pending agent nudges                                     |
| `POST`  | `/debug/towns/:townId/send-message`      | Send message to mayor (dev only)                         |
| `GET`   | `/debug/towns/:townId/beads/:beadId`     | Full bead details + review metadata + dependencies       |
| `POST`  | `/debug/towns/:townId/graceful-stop`     | Trigger SIGTERM on container (dev only)                  |

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

## E2E Test Results — Round 2 (2026-04-05)

### Summary

| Scenario                         | Config                                               | Result              | PR           | Notes                                                                                      |
| -------------------------------- | ---------------------------------------------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| 1: No review + auto-merge        | `code_review=false`, `auto_merge=true`               | **PASS (with bug)** | #38 MERGED   | Refinery dispatched despite `code_review=false` (bug persists). PR merged after rework.    |
| 2: Refinery review (rework mode) | `code_review=true`, `review_mode=rework`             | **FAIL**            | None created | Polecat pushed branch but never created PR. Refinery stuck in rework-request loop 35+ min. |
| 3: Human feedback + auto-resolve | `code_review=false`, `auto_resolve_pr_feedback=true` | **FAIL**            | None created | Same as Scenario 2: polecat pushed branch but no PR. MR bead stuck at `open`.              |

### Bugs Found

#### Bug 1 (PERSISTS from round 1): Refinery dispatches despite `code_review=false`

**Scenario:** 1
**Severity:** Medium
**Status:** Not fixed — the round 1 fix was insufficient.

When `code_review=false` and `merge_strategy=pr`, the refinery is still dispatched to review MR beads. The reconciler's `code_review` bypass only works for MR beads that already have a `pr_url` in `review_metadata`. When the polecat creates the MR bead via `review_submitted`, the MR bead initially has `pr_url=null`. During this window, the reconciler falls through to the standard dispatch rule and sends the refinery.

In Scenario 1, the refinery happened to create the PR and complete a rework cycle, so the PR eventually merged. But this added ~3 minutes of unnecessary work and the refinery should not have been involved at all.

**Evidence:**

- 19:44:59Z: MR bead created with `pr_url=null`, reconciler action `dispatch_agent: 1`
- 19:45:12Z: refinery `working` hook=8b5d6506
- 19:45:42Z: refinery created rework bead "Rework: Add src/utils/set-helpers.ts..."
- 19:48:02Z: PR #38 merged after rework cycle

**Root cause location:** reconciler.ts, MR bead dispatch rules — the `code_review=false` check requires `pr_url` to be set, but the polecat doesn't pass `pr_url` in `review_submitted`.

#### Bug 2 (NEW): Polecat does not create GitHub PRs

**Scenarios:** 2, 3 (and likely 1 — the refinery created it instead)
**Severity:** Critical — blocks the entire PR-based merge flow
**Status:** New

The polecat pushes branches to GitHub successfully but does NOT call `gh pr create`. The MR bead is created via `review_submitted` with `pr_url=null`. In the bead body, the polecat reports the commit was pushed, but no PR creation is mentioned.

**Evidence:**

- Scenario 2: branch `gt/toast/fa318809` exists on GitHub, 0 PRs associated
- Scenario 3: branch `gt/toast/4464f47b` exists on GitHub, 0 PRs associated
- Scenario 1: branch `gt/toast/38cba536` had PR #38, but that was created by the refinery (not the polecat)

**Impact:** Without a `pr_url`:

- The `code_review=false` fast-track in the reconciler can't proceed to auto-merge
- The refinery (when dispatched) has no PR to review, leading to Bug 3
- Human feedback can't be added because there's no PR to comment on

**Likely cause:** The polecat's system prompt or tooling may have changed. The polecat calls `gt_done` with a branch but not a `pr_url`. Need to verify the polecat's tool definitions include PR creation tooling, and that `merge_strategy=pr` is being communicated to the polecat agent.

#### Bug 3 (NEW): Refinery stuck in rework-request loop

**Scenario:** 2
**Severity:** High
**Status:** New

When `code_review=true` and the refinery is dispatched to an MR bead with `pr_url=null`, the refinery enters a loop where it:

1. Reviews the diff (via git, not via GitHub PR)
2. Calls `gt_request_changes` to create a rework request
3. Continues working instead of unhoking and completing
4. After a delay (~10 min), calls `gt_request_changes` again with duplicate content
5. Creates duplicate rework/escalation beads

**Evidence:**

- 19:50:03Z: MR bead created with `pr_url=null`
- 19:51:00Z: refinery "Code review found gaps in test coverage; preparing rework request"
- 19:51:13Z: First rework request + escalation bead created
- 20:02:01Z: Second rework request + escalation bead created (duplicate)
- 20:12:35Z: Third rework request + escalation bead (scope mismatch)
- 20:25+Z: refinery still `working` on same hook after 35+ minutes

**Impact:** Accumulates orphaned escalation/rework beads. Refinery is stuck indefinitely. GUPP patrol should eventually force-stop but hasn't triggered in the observed window.

#### Bug 4 (NEW): Duplicate rework/escalation beads

**Scenario:** 2
**Severity:** Medium
**Status:** New (related to Bug 3)

The `gt_request_changes` tool call is not idempotent. Each call creates new rework and escalation beads even when the refinery is re-issuing the same request for the same MR bead. After 35 minutes, Scenario 2 accumulated:

- 5 escalation beads (all "Rework requested: missing tests...")
- 5 "Escalation (low)" issue beads
- 3 REWORK_REQUEST message beads

These all remain `open` and clutter the bead queue.

### Detailed Scenario Timelines

#### Scenario 1: code_review=false + auto_merge (PASS with bugs)

```
Config: merge_strategy=pr, code_review=false, auto_resolve_pr_feedback=false,
        auto_merge=true, auto_merge_delay_minutes=2
Task:   "Add src/utils/set-helpers.ts with union, intersection, difference,
         symmetricDifference, isSubset"
```

| Time (UTC) | Event                                                         |
| ---------- | ------------------------------------------------------------- |
| 19:38:42   | Task sent to mayor                                            |
| 19:38:47   | Issue bead created, mayor hooks it                            |
| 19:43:51   | Mayor unhooks, polecat dispatched                             |
| 19:43:56   | Polecat hooks bead, starts implementing                       |
| 19:44:28   | Polecat: "Set helper file added; committing and pushing"      |
| 19:44:43   | Polecat: "Creating pull request"                              |
| 19:44:59   | MR bead created (`pr_url=null`). **BUG: refinery dispatched** |
| 19:45:42   | Refinery requests rework, rework bead created                 |
| 19:45:57   | Polecat dispatched for rework                                 |
| 19:46:58   | Rework bead: refinery calls `gt_done`, `poll_pr` starts       |
| 19:48:02   | **PR #38 merged** by kiloconnect-development bot              |
| 19:48:13   | All beads closed                                              |

**Duration:** ~9.5 min (would be ~5 min without unnecessary refinery rework)
**PR:** #38 on branch `gt/toast/38cba536` — MERGED
**Post-merge comments:** None (clean)

#### Scenario 2: code_review=true + review_mode=rework (FAIL — stuck)

```
Config: merge_strategy=pr, code_review=true, review_mode=rework,
        auto_resolve_pr_feedback=false, auto_merge=true, auto_merge_delay_minutes=2
Task:   "Add src/utils/promise-helpers.ts with delay, retry, timeout,
         allSettledWithErrors, race"
```

| Time (UTC) | Event                                                            |
| ---------- | ---------------------------------------------------------------- |
| 19:49:20   | Task sent to mayor                                               |
| 19:49:35   | Issue bead created, polecat dispatched                           |
| 19:49:44   | Polecat: "Implementing promise helper utilities"                 |
| 19:50:03   | MR bead created (`pr_url=null`). Refinery dispatched (expected). |
| 19:51:00   | Refinery: "Code review found gaps in test coverage"              |
| 19:51:13   | First rework request + escalation beads (2 each)                 |
| 20:02:01   | **Second rework request** (duplicate) — refinery still working   |
| 20:12:35   | Third rework request (scope mismatch)                            |
| 20:25+     | **Refinery still stuck** on MR bead after 35+ min                |

**Duration:** 35+ min (never completed)
**PR:** None created on GitHub
**Branch:** `gt/toast/fa318809` exists on GitHub but has no PR
**Orphaned beads:** 5 escalation + 5 escalation(low) issue + 3 REWORK_REQUEST message

#### Scenario 3: code_review=false + auto_resolve + human feedback (FAIL — stuck)

```
Config: merge_strategy=pr, code_review=false, auto_resolve_pr_feedback=true,
        auto_merge=true, auto_merge_delay_minutes=2
Task:   "Add src/utils/regex-helpers.ts with escapeRegex, isValidRegex,
         matchAll, replaceAll, extractGroups"
```

| Time (UTC) | Event                                            |
| ---------- | ------------------------------------------------ |
| 20:13:09   | Task sent to mayor                               |
| 20:13:25   | Issue bead created, polecat dispatched           |
| 20:14:01   | Polecat: "Implementing regex helper utilities"   |
| 20:14:05   | MR bead created (`pr_url=null`), polecat unhooks |
| 20:14:17   | MR bead status=`open`, no assignee, no dispatch  |
| 20:25+     | **MR bead still `open`** — no one picks it up    |

**Duration:** 10+ min (never completed)
**PR:** None created on GitHub
**Branch:** `gt/toast/4464f47b` exists on GitHub but has no PR
**Human feedback test:** Could not proceed — no PR to add comments to

### Config Commands Used

```bash
BASE=http://localhost:8803
TOWN_ID=a093a551-ff4d-4c36-9274-252df66128fd

# Scenario 1
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{"merge_strategy":"pr","refinery":{"code_review":false,"auto_merge":true,"auto_resolve_pr_feedback":false,"auto_merge_delay_minutes":2,"review_mode":"rework"}}'

# Scenario 2
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{"merge_strategy":"pr","refinery":{"code_review":true,"auto_merge":true,"auto_resolve_pr_feedback":false,"auto_merge_delay_minutes":2,"review_mode":"rework"}}'

# Scenario 3
curl -s -X PATCH $BASE/debug/towns/$TOWN_ID/config \
  -H "Content-Type: application/json" \
  -d '{"merge_strategy":"pr","refinery":{"code_review":false,"auto_merge":true,"auto_resolve_pr_feedback":true,"auto_merge_delay_minutes":2,"review_mode":"rework"}}'
```

### Recommended Fixes (Priority Order)

1. **Bug 2 (Critical): Polecat must create PRs.** When `merge_strategy=pr`, the polecat's `review_submitted` event must include a `pr_url`. Either:
   - Ensure the polecat system prompt instructs PR creation via `gh pr create` before calling `gt_done`
   - Or have the MR bead creation logic (in `review_submitted` handler) create the PR server-side using the branch name and GitHub token

2. **Bug 1 (Medium): Reconciler fast-track for `code_review=false`.** The reconciler's MR bead dispatch logic should not require `pr_url` to honor `code_review=false`. When `code_review=false`, the MR bead should be fast-tracked to `in_progress` regardless of `pr_url` presence.

3. **Bug 3 (High): Refinery should bail when no PR exists.** If the refinery is dispatched to an MR bead with `pr_url=null`, it should either:
   - Create the PR itself (current Scenario 1 behavior, which accidentally worked)
   - Or fail gracefully and unhook with an error message

4. **Bug 4 (Medium): Deduplicate rework requests.** The `gt_request_changes` tool should check if an active rework request already exists for the same MR bead before creating a new one.
