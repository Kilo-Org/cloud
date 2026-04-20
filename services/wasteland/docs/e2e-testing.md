# Wasteland E2E Testing Guide

Step-by-step playbooks for verifying every wasteland flow against a real
DoltHub upstream using the unauthenticated `/debug/*` endpoints exposed by
the wasteland worker.

Companion reference: [`wl-cli-reference.md`](./wl-cli-reference.md).

## Prerequisites

**Running services** (both must be up — check with `lsof -iTCP -sTCP:LISTEN -Pn | grep -E ':(8787|8803)'`):

- `services/wasteland` — `pnpm dev` → listens on `:8787`
- `services/gastown` — `pnpm dev` → listens on `:8803`

**Credentials**:

- A **DoltHub token for the upstream owner** — used to merge PRs from the maintainer side.
  Stored in environment when running tests: `WASTELAND_DOLT_TOKEN`. (This is different
  from the token stored for the connected town's user, which goes through the
  encrypted credential flow.)

**Known IDs** (fill in with your own values):

- `WASTELAND_ID` — the wasteland you are testing (e.g. `63bac39a-11d9-4e4e-8fdb-124d5abeb247`)
- `USER_ID` — the kilo user ID that owns the wasteland, discoverable via
  `GET /debug/wastelands/:WASTELAND_ID/status` (look at `config.owner_user_id`)
- `UPSTREAM` — the DoltHub upstream, e.g. `jrf0110/wl-commons`
  (discoverable via `GET /debug/wastelands/:WASTELAND_ID/status` →
  `config.dolthub_upstream`)
- `RIG_HANDLE` — the rig handle for this town's connection (via
  `GET /debug/wastelands/:WASTELAND_ID/container/config` → `dolthubOrg`;
  the rig handle typically matches the DoltHub org)

## Conventions

Throughout this doc:

- `$WL` = wasteland worker base URL (`http://localhost:8787`)
- `$GT` = gastown worker base URL (`http://localhost:8803`)
- `$TOKEN` = your DoltHub API token that has write access to the upstream
  (used for merging PRs). Example:
  `dhat.v1.13e7aqbv90p61hh1o8e3jup3318dqg1evi97vjeh2v57r4ok3330`
- `$UPSTREAM_OWNER` / `$UPSTREAM_DB` = split `$UPSTREAM` on `/`
  (e.g. `jrf0110` / `wl-commons`)

**Timing note**: DoltHub merge operations are **asynchronous**. After
`POST /pulls/:id/merge` returns, the PR state and the upstream `main` may
still show the pre-merge values for 5–30 seconds. Every flow below uses a
**poll-with-timeout** to wait for the merge to land, not a fixed sleep.

## Debug endpoint reference

### Inspection (read-only)

| Endpoint                                                                | Purpose                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET $WL/debug/wastelands/:id/status`                                   | Wasteland config, members, connected towns, board size       |
| `GET $WL/debug/wastelands/:id/wanted`                                   | Cached wanted board rows from the Wasteland DO               |
| `GET $WL/debug/wastelands/:id/container/config`                         | Container join status, upstream, dolthubOrg, wl version      |
| `GET $WL/debug/wastelands/:id/container/health`                         | Container heartbeat                                          |
| `GET $WL/debug/wastelands/:id/browse-direct?-H Authorization:token ...` | Query upstream wanted via DoltHub SQL API (bypass container) |
| `GET $WL/debug/wastelands/:id/browse?userId=...`                        | Browse through the production wanted-board-ops path          |
| `GET $WL/debug/registry`                                                | All wastelands in the global registry                        |
| `GET $GT/debug/towns/:id/wasteland`                                     | Town DO's connected wasteland row                            |

### Lifecycle mutations (uses stored credential)

| Endpoint                                | Body                                             |
| --------------------------------------- | ------------------------------------------------ |
| `POST $WL/debug/wastelands/:id/post`    | `{userId, title, description, priority?, type?}` |
| `POST $WL/debug/wastelands/:id/claim`   | `{userId, itemId}`                               |
| `POST $WL/debug/wastelands/:id/unclaim` | `{userId, itemId}`                               |
| `POST $WL/debug/wastelands/:id/done`    | `{userId, itemId, evidence}`                     |
| `POST $WL/debug/wastelands/:id/accept`  | `{userId, itemId, quality, comment?}`            |
| `POST $WL/debug/wastelands/:id/reject`  | `{userId, itemId, comment}`                      |
| `POST $WL/debug/wastelands/:id/close`   | `{userId, itemId}`                               |

### Maintainer ops (uses Authorization token directly)

| Endpoint                                                | Purpose                                  |
| ------------------------------------------------------- | ---------------------------------------- |
| `GET $WL/debug/dolthub/:owner/:db/pulls?state=open`     | List PRs (client-side filtered by state) |
| `GET $WL/debug/dolthub/:owner/:db/pulls/:pullId`        | PR detail                                |
| `POST $WL/debug/dolthub/:owner/:db/pulls/:pullId/merge` | Merge (returns immediately; async)       |
| `PATCH $WL/debug/dolthub/:owner/:db/pulls/:pullId`      | Close `{state:"closed"}` (no merge)      |
| `GET $WL/debug/dolthub/:owner/:db/sql?q=...`            | Arbitrary SQL read                       |

All `dolthub` endpoints require `Authorization: token $TOKEN`.

## Common helper functions

```bash
# Env for the rest of this doc
WL=http://localhost:8787
GT=http://localhost:8803
TOKEN=dhat.v1.YOUR_TOKEN
WASTELAND_ID=63bac39a-11d9-4e4e-8fdb-124d5abeb247
UPSTREAM_OWNER=jrf0110
UPSTREAM_DB=wl-commons

# User ID / rig handle lookup
USER_ID=$(curl -s $WL/debug/wastelands/$WASTELAND_ID/status | jq -r .config.owner_user_id)
RIG_HANDLE=$(curl -s $WL/debug/wastelands/$WASTELAND_ID/container/config | jq -r .dolthubOrg)

# Wait for a PR to be merged (polls up to 60s)
wait_for_pr_merged() {
  local pull_id=$1
  for i in $(seq 1 12); do
    sleep 5
    state=$(curl -s -H "authorization: token $TOKEN" \
      "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$pull_id" | jq -r .state)
    echo "  poll $i: state=$state"
    if [ "$state" = "Merged" ]; then return 0; fi
  done
  echo "  TIMEOUT: PR $pull_id not merged after 60s"
  return 1
}

# Wait for upstream row to match predicate (polls up to 60s)
wait_for_upstream() {
  local item_id=$1 expected_status=$2 expected_claimed_by=$3
  for i in $(seq 1 12); do
    sleep 5
    row=$(curl -s -H "authorization: token $TOKEN" \
      "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20status,%20claimed_by%20FROM%20wanted%20WHERE%20id%20=%20%27$item_id%27" \
      | jq -c '.rows[0]')
    echo "  poll $i: $row"
    actual_status=$(echo "$row" | jq -r .status)
    actual_claimed=$(echo "$row" | jq -r .claimed_by)
    if [ "$actual_status" = "$expected_status" ] && [ "$actual_claimed" = "$expected_claimed_by" ]; then
      return 0
    fi
  done
  echo "  TIMEOUT: upstream state did not converge"
  return 1
}

# Find the most recent open PR from a specific author on a specific branch
find_pr_for_branch() {
  local branch=$1
  curl -s -H "authorization: token $TOKEN" \
    "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
    | jq -r ".pulls[] | select(.state == \"Open\") | .pull_id" | head -1
  # Note: DoltHub `pulls` endpoint does not expose from_branch in list view;
  # call /pulls/:id for each candidate to filter by branch if needed.
}
```

## Flow 1: Join & register (already executed on connect)

This flow runs automatically when a town connects to a wasteland through
the settings UI. It's documented here so you understand the expected
shape when verifying other flows.

### Preconditions

- Wasteland exists with `dolthub_upstream` configured.
- Credentials have been stored via `storeCredential` tRPC (or the
  onboarding dialog).
- Container has been initialized (`wl join` succeeded).

### Verification steps

1. **Container joined?**

   ```bash
   curl -s $WL/debug/wastelands/$WASTELAND_ID/container/config
   # Expect: { joined: true, upstream: "...", hasToken: true, hasJwk: true, ... }
   ```

2. **Rig registration PR exists?** (may or may not be merged yet)

   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
     | jq '.pulls[] | select(.title | contains("Register rig: '$RIG_HANDLE'"))'
   ```

3. **Merge the registration PR** (maintainer side):

   ```bash
   PULL_ID=... # from step 2
   curl -s -X POST -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
   wait_for_pr_merged $PULL_ID
   ```

4. **Rig appears on upstream main?**
   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20handle%20FROM%20rigs%20WHERE%20handle%20=%20%27$RIG_HANDLE%27"
   # Expect: rows: [{ handle: "$RIG_HANDLE" }]
   ```

### Pass criteria

- Container config reports `joined: true` and `hasJwk: true`
- Registration PR state transitions to `Merged`
- `rigs` table on upstream main contains the rig handle

## Flow 2: Browse (read-only)

### Verification steps

1. **Browse via production path (through container)**:

   ```bash
   curl -s "$WL/debug/wastelands/$WASTELAND_ID/browse?userId=$USER_ID" \
     | jq '.itemCount'
   ```

2. **Browse direct via DoltHub API** (for comparison — should match):
   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/wastelands/$WASTELAND_ID/browse-direct" \
     | jq '.itemCount'
   ```

### Pass criteria

- Both counts are equal.
- Counts match the direct SQL `SELECT COUNT(*) FROM wanted` on upstream main.

### Known issues

- The production path (`/browse`) calls the container; if the container's
  Bun TLS is broken (wrangler dev local issue), this returns
  `DoltHub API fetch failed: unknown certificate verification error`.
  Use `/browse-direct` for verification in that case.

## Flow 3: Post a new wanted item

### Preconditions

- Flow 1 complete (rig is registered upstream).

### Execution

```bash
curl -s -X POST -H "Content-Type: application/json" \
  "$WL/debug/wastelands/$WASTELAND_ID/post" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"title\": \"E2E test: sample wanted item $(date +%s)\",
    \"description\": \"Auto-generated from E2E test flow\",
    \"priority\": \"medium\",
    \"type\": \"feature\"
  }"
```

### Verification

1. **Claim PR exists on upstream**:

   ```bash
   # Find the most recent open PR from this rig
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls?state=open" \
     | jq '.pulls[] | select(.description | contains("added: id=w-"))'
   ```

2. **Merge the PR**:

   ```bash
   PULL_ID=... # from step 1
   curl -s -X POST -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
   wait_for_pr_merged $PULL_ID
   ```

3. **Item appears on upstream main**:
   ```bash
   # Extract the new item ID from the PR description (look for w-...)
   ITEM_ID=... # e.g. w-abc123
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20title,%20posted_by,%20status%20FROM%20wanted%20WHERE%20id%20=%20%27$ITEM_ID%27" \
     | jq '.rows'
   ```

### Pass criteria

- PR created with "added: id=w-..." in the description
- After merge, row exists on upstream main with:
  - `posted_by = $RIG_HANDLE`
  - `status = "open"`
  - `claimed_by = null`

## Flow 4: Claim → merge → verify

### Preconditions

- Flow 1 complete (rig registered).
- At least one item exists on upstream with `status = "open"`.

### Execution

1. **Pick an open item**:

   ```bash
   ITEM_ID=$(curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/wastelands/$WASTELAND_ID/browse-direct" \
     | jq -r '.items[] | select(.status == "open") | .id' | head -1)
   echo "Claiming: $ITEM_ID"
   ```

2. **Claim it**:

   ```bash
   curl -s -X POST -H "Content-Type: application/json" \
     "$WL/debug/wastelands/$WASTELAND_ID/claim" \
     -d "{\"userId\":\"$USER_ID\",\"itemId\":\"$ITEM_ID\"}"
   # Expect: { success: true }
   ```

3. **Find & merge the resulting PR**:

   ```bash
   # The PR branch will be wl/$RIG_HANDLE/$ITEM_ID.
   # Find it by walking open PRs and inspecting details.
   PULL_ID=$(curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls?state=open" \
     | jq -r --arg id "$ITEM_ID" '.pulls[] | select(.description | contains($id)) | .pull_id' | head -1)

   curl -s -X POST -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
   wait_for_pr_merged $PULL_ID
   ```

4. **Verify upstream state**:
   ```bash
   wait_for_upstream $ITEM_ID claimed $RIG_HANDLE
   ```

### Pass criteria

- Claim PR state → `Merged`
- Upstream main: `status = "claimed"`, `claimed_by = $RIG_HANDLE`

## Flow 5: Claim → unclaim → verify reverted

### Preconditions

- Flow 4 complete OR an item already claimed by `$RIG_HANDLE` upstream.

### Execution

```bash
# ITEM_ID is an item currently claimed by $RIG_HANDLE on upstream
curl -s -X POST -H "Content-Type: application/json" \
  "$WL/debug/wastelands/$WASTELAND_ID/unclaim" \
  -d "{\"userId\":\"$USER_ID\",\"itemId\":\"$ITEM_ID\"}"
```

### Verification

1. Find the unclaim PR (description contains `status: claimed → open` and
   `claimed_by: $RIG_HANDLE → (empty)`).
2. Merge it.
3. Poll: `wait_for_upstream $ITEM_ID open null`.

### Pass criteria

- Upstream main reverts to `status = "open"`, `claimed_by = null`.

## Flow 6: Claim → done → verify in_review

### Preconditions

- Flow 4 complete for an item; item is in `claimed` state on upstream.

### Execution

```bash
EVIDENCE_URL="https://github.com/Kilo-Org/cloud/pull/1234"
curl -s -X POST -H "Content-Type: application/json" \
  "$WL/debug/wastelands/$WASTELAND_ID/done" \
  -d "{
    \"userId\":\"$USER_ID\",
    \"itemId\":\"$ITEM_ID\",
    \"evidence\":\"$EVIDENCE_URL\"
  }"
```

### Verification

1. Find + merge the done PR (description mentions `status: claimed → in_review`
   and references a new row in `completions`).
2. Verify on upstream:
   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20status,%20evidence_url%20FROM%20wanted%20WHERE%20id%20=%20%27$ITEM_ID%27"
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20wanted_id,%20completed_by,%20evidence%20FROM%20completions%20WHERE%20wanted_id%20=%20%27$ITEM_ID%27"
   ```

### Pass criteria

- Upstream `wanted.status = "in_review"`, `wanted.evidence_url` set
- Upstream `completions` has a row with `completed_by = $RIG_HANDLE`, `evidence = <url>`

## Flow 7: Accept (maintainer) → completed + stamp

### Preconditions

- Flow 6 complete; item is in `in_review` state upstream with a completion row.
- The accept operation is called by the **maintainer** (upstream owner's rig).
  For a single-rig testing scenario where the user owns both sides, this still
  works: `wl accept-upstream` is what a maintainer uses to accept a fork's submission.

### Execution (self-accept — same user owns upstream and is accepting)

```bash
# For a self-owned upstream, "accept" creates a PR that updates the item
# to status=completed and inserts a stamp row.
curl -s -X POST -H "Content-Type: application/json" \
  "$WL/debug/wastelands/$WASTELAND_ID/accept" \
  -d "{
    \"userId\":\"$USER_ID\",
    \"itemId\":\"$ITEM_ID\",
    \"quality\":\"good\"
  }"
```

### Verification

1. Merge the resulting PR.
2. Verify on upstream:
   ```bash
   # Item should be completed
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20status%20FROM%20wanted%20WHERE%20id%20=%20%27$ITEM_ID%27"
   # Stamp should exist
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20subject,%20author%20FROM%20stamps%20WHERE%20context_id%20=%20%27$ITEM_ID%27"
   ```

### Pass criteria

- `wanted.status = "completed"`
- `stamps` has a row with `context_id = $ITEM_ID`, `author = $RIG_HANDLE`
- `completions.validated_by = $RIG_HANDLE` and `stamp_id` links to the new stamp

## Flow 8: Reject (maintainer) → back to claimed

### Preconditions

- Item is in `in_review` state.

### Execution

```bash
curl -s -X POST -H "Content-Type: application/json" \
  "$WL/debug/wastelands/$WASTELAND_ID/reject" \
  -d "{
    \"userId\":\"$USER_ID\",
    \"itemId\":\"$ITEM_ID\",
    \"comment\":\"Please add more tests.\"
  }"
```

### Verification

1. Merge PR.
2. `wait_for_upstream $ITEM_ID claimed $RIG_HANDLE`.

### Pass criteria

- Upstream: `status = "claimed"`, `claimed_by = $RIG_HANDLE` (unchanged).
- No stamp was issued.

## Flow 9: Close (no stamp) → completed without stamp

### Preconditions

- Item is in `in_review` state.

### Execution

```bash
curl -s -X POST -H "Content-Type: application/json" \
  "$WL/debug/wastelands/$WASTELAND_ID/close" \
  -d "{\"userId\":\"$USER_ID\",\"itemId\":\"$ITEM_ID\"}"
```

### Verification

1. Merge PR.
2. `wait_for_upstream $ITEM_ID completed $RIG_HANDLE`.
3. Verify no stamp was issued:
   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20COUNT(*)%20FROM%20stamps%20WHERE%20context_id%20=%20%27$ITEM_ID%27"
   # Expect: count = 0
   ```

### Pass criteria

- `wanted.status = "completed"`
- `stamps` has no row for this item

## Flow 10: Disconnect town → state cleared in gastown, credential intact in wasteland

### Preconditions

- Town connected to wasteland via gastown UI (visible in
  `/debug/wastelands/:id/status` → `connectedTowns`).

### Execution

(Via gastown tRPC — can also be driven from the UI, but for scripted testing
use the tRPC `disconnectTownFromWasteland` or gastown debug if exposed.)

### Verification

```bash
curl -s $GT/debug/towns/$TOWN_ID/wasteland
# Expect: { connection: null }
curl -s $WL/debug/wastelands/$WASTELAND_ID/status \
  | jq '.connectedTowns'
# Expect: []
```

## Execution template for sub-agents

When running a flow autonomously, use this pattern:

1. **Read the current state** via debug `/status` and `/browse-direct`.
2. **Pick a unique test subject**: a fresh item ID (for post) or an item
   currently in the right state (for claim/done/accept).
3. **Execute the mutation** via `POST /debug/wastelands/:id/<op>`.
4. **List open PRs** and find the one matching your mutation (by item ID in
   description).
5. **Merge** (or PATCH close, if testing rejection), then
   `wait_for_pr_merged`.
6. **Verify upstream** state matches the expected post-merge state.
7. **Cleanup** (optional): if the item was part of your test, run a closing
   mutation to return it to a reusable state.

## Test data hygiene

Flows 4–9 mutate a single test item through the full lifecycle. To avoid
interfering with each other's runs, each flow should:

1. Start by calling `/browse-direct` and selecting an item in the required
   starting state.
2. Prefer `post` (flow 3) to create a fresh item before running a full
   lifecycle chain (3 → 4 → 6 → 7/8/9).
3. Record the item IDs touched in a log file so cleanup runs can revert any
   half-completed mutations.

## When flows fail

Most failures fall into these buckets:

| Symptom                                        | Likely cause                             | Fix                                                                                      |
| ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Browse query failed: unknown certificate ...` | Container Bun TLS broken in local dev    | Use `/browse-direct` instead                                                             |
| `wl claim failed: push failed`                 | Dolt JWK missing or mismatched           | Reconnect via onboarding dialog with correct JWK                                         |
| `wl claim failed: rig not found`               | Registration PR not merged yet           | Merge flow 1's PR first                                                                  |
| PR state stuck on `Open` after merge call      | DoltHub async processing                 | Wait 5–30s; use `wait_for_pr_merged`                                                     |
| `cannot merge pull that is not open`           | PR already merged or closed              | Check current state; pick a different PR                                                 |
| Container not responding (`[not connected]`)   | Wrangler dev registry missed the binding | Restart gastown wrangler dev; check binding shows `wasteland-dev#WastelandRPCEntrypoint` |
