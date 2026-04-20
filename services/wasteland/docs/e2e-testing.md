# Wasteland E2E Testing Guide

Step-by-step playbooks for verifying every wasteland flow against a real
DoltHub upstream using the unauthenticated `/debug/*` endpoints exposed by
the wasteland worker.

Companion reference: [`wl-cli-reference.md`](./wl-cli-reference.md).

## Two execution paths

Each flow can be verified through one of two paths, depending on the
dev environment's container-egress health:

### Path A: Container-driven (production-equivalent)

Uses the `POST /debug/wastelands/:id/{post,claim,done,...}` endpoints,
which delegate to `wanted-board-ops.ts` → the wasteland container → the
`wl` Go binary → DoltHub. This mirrors exactly what production does.

**Known issue (local wrangler dev only)**: the workerd-managed container
in local dev has broken HTTPS egress. TLS handshakes to `www.dolthub.com`
fail with `SSL_ERROR_SYSCALL`. Both `wl` mutations and the container's
Bun `fetch` for browse fail in this environment. In production CF
Containers this works normally. See troubleshooting section at the end.

### Path B: Worker-direct (dev-only simulation)

Uses the `POST /debug/dolthub/{owner}/{db}/{write,pulls}` endpoints,
which fetch directly from the wasteland worker (where TLS works) to
DoltHub. This simulates what `wl` would do — create a branch with DML,
open a PR, wait for merge — but from the worker's TLS-working
environment.

Worker-direct only validates the **DoltHub state transitions** (branch
creation, PR merge, upstream table updates). It does not exercise the
container code path or `wl` CLI. Use it when path A is blocked by the
container-egress issue.

Each flow below is written against **Path B** (worker-direct) for
reliability in dev. To run the same flow through Path A in a healthy
environment, substitute the `POST /debug/wastelands/:id/{op}` endpoint
for the explicit write+PR+merge steps.

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
  the rig handle typically matches the DoltHub org). For the **contributor**
  (posts and claims items).
- `MAINTAINER_RIG` — a separate registered rig that accepts PRs. For
  self-owned upstreams, the upstream owner's rig (e.g. `jrf0110`) is
  registered and used for accept/reject operations. Required because
  `stamps` has a `CHECK (author != subject)` constraint — the rig that
  authors a stamp must not be the rig that is the subject.

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

### Maintainer ops + worker-direct simulation

| Endpoint                                                    | Purpose                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET $WL/debug/dolthub/:owner/:db/pulls?state=open`         | List PRs (client-side filtered by state)                         |
| `GET $WL/debug/dolthub/:owner/:db/pulls/:pullId`            | PR detail                                                        |
| `POST $WL/debug/dolthub/:owner/:db/pulls/:pullId/merge`     | Merge PR (returns immediately; async)                            |
| `PATCH $WL/debug/dolthub/:owner/:db/pulls/:pullId`          | Close `{state:"closed"}` (no merge)                              |
| `GET $WL/debug/dolthub/:owner/:db/sql?q=...`                | Arbitrary SQL read                                               |
| `POST $WL/debug/dolthub/:owner/:db/write/:from/:to?q=<SQL>` | Create branch `:to` from `:from` and run DML                     |
| `POST $WL/debug/dolthub/:owner/:db/pulls`                   | Create PR (body: `{title, description, fromBranch*, toBranch*}`) |

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

## Flow 3: Post a new wanted item (Path B — worker-direct)

### Preconditions

- DoltHub token with write access to the upstream.

### Execution

Generate a unique item ID + branch name, then create a branch with the
`INSERT INTO wanted` DML:

```bash
TS=$(date +%s)
NEW_ID="w-$(openssl rand -hex 5)"
BRANCH="e2e-$NEW_ID"
SQL="INSERT INTO wanted (id, title, description, type, priority, posted_by, status, effort_level, created_at, updated_at) VALUES ('$NEW_ID', 'E2E test $TS', 'test', 'feature', 1, '$RIG_HANDLE', 'open', 'medium', NOW(), NOW())"

curl -s --max-time 30 -X POST \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL")}"
```

Wait a moment for the write to commit:

```bash
sleep 3
# Verify the row is on the branch
curl -s "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?branch=$BRANCH&q=SELECT%20id,status%20FROM%20wanted%20WHERE%20id%20=%20%27$NEW_ID%27" \
  -H "authorization: token $TOKEN" | jq '.rows'
```

Create the PR:

```bash
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] post $NEW_ID\",
    \"description\": \"+ added: id=$NEW_ID, posted_by=$RIG_HANDLE, status=open\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranchOwner\": \"$UPSTREAM_OWNER\",
    \"toBranchDb\": \"$UPSTREAM_DB\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id
# Save the pull_id
```

Merge the PR and wait:

```bash
PULL_ID=... # from above
curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

Item appears on upstream main:

```bash
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,%20title,%20posted_by,%20status%20FROM%20wanted%20WHERE%20id%20=%20%27$NEW_ID%27" \
  | jq '.rows'
```

### Pass criteria

- Branch created (write API returned operation_name)
- PR state → `Merged`
- Upstream main: row exists with `posted_by = $RIG_HANDLE`, `status = "open"`, `claimed_by = null`

## Flow 4: Claim → merge → verify (Path B — worker-direct)

### Preconditions

- An item exists on upstream with `status = "open"` and `claimed_by = null`.
  (Use flow 3 to create one if needed.)

### Execution

Pick an open item:

```bash
ITEM_ID=$(curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id%20FROM%20wanted%20WHERE%20status%20=%20%27open%27%20LIMIT%201" \
  | jq -r '.rows[0].id')
echo "Claiming: $ITEM_ID"
```

Create branch + claim UPDATE:

```bash
BRANCH="e2e-claim-$ITEM_ID"
SQL="UPDATE wanted SET status='claimed', claimed_by='$RIG_HANDLE', updated_at=NOW() WHERE id='$ITEM_ID'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL")}"
sleep 3
```

Create and merge the PR:

```bash
PULL_ID=$(curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] claim $ITEM_ID by $RIG_HANDLE\",
    \"description\": \"~ modified: id=$ITEM_ID, status: open → claimed, claimed_by: → $RIG_HANDLE\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id)

curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

```bash
wait_for_upstream $ITEM_ID claimed $RIG_HANDLE
```

### Pass criteria

- PR state → `Merged`
- Upstream main: `status = "claimed"`, `claimed_by = $RIG_HANDLE`

## Flow 5: Unclaim → verify reverted (Path B — worker-direct)

### Preconditions

- An item is currently `claimed` by `$RIG_HANDLE` on upstream.

### Execution

```bash
BRANCH="e2e-unclaim-$ITEM_ID"
SQL="UPDATE wanted SET status='open', claimed_by=NULL, updated_at=NOW() WHERE id='$ITEM_ID' AND claimed_by='$RIG_HANDLE'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL")}"
sleep 3

PULL_ID=$(curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] unclaim $ITEM_ID\",
    \"description\": \"~ modified: id=$ITEM_ID, status: claimed → open, claimed_by: $RIG_HANDLE → (empty)\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id)

curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

```bash
wait_for_upstream $ITEM_ID open null
```

### Pass criteria

- Upstream main reverts to `status = "open"`, `claimed_by = null`

## Flow 6: Done → in_review + completion row (Path B — worker-direct)

### Preconditions

- Item is in `claimed` state with `claimed_by = $RIG_HANDLE`.

### Execution

`done` is a compound operation:

1. Update `wanted.status = 'in_review'` and `wanted.evidence_url = <url>`
2. Insert a row into `completions`

**IMPORTANT**: DoltHub's write API doesn't reliably execute multi-statement
SQL (`UPDATE ...; INSERT ...;`) in a single call — the operation returns
`Success` but nothing lands on the branch. Split into separate writes
targeting the **same branch**: first write uses `main` as fromBranch to
create the branch, subsequent writes use the new branch as both `from`
and `to` to append to it.

```bash
EVIDENCE_URL="https://github.com/Kilo-Org/cloud/pull/1234"
COMPLETION_ID="c-$(openssl rand -hex 8)"
BRANCH="e2e-done-$ITEM_ID"

# Write 1: create the branch with the UPDATE
SQL1="UPDATE wanted SET status='in_review', evidence_url='$EVIDENCE_URL', updated_at=NOW() WHERE id='$ITEM_ID'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL1")}"
sleep 3

# Write 2: append the completions INSERT on the same branch
SQL2="INSERT INTO completions (id, wanted_id, completed_by, evidence, completed_at) VALUES ('$COMPLETION_ID', '$ITEM_ID', '$RIG_HANDLE', '$EVIDENCE_URL', NOW())"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/$BRANCH/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL2")}"
sleep 3

PULL_ID=$(curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] done $ITEM_ID by $RIG_HANDLE\",
    \"description\": \"~ modified: id=$ITEM_ID, status: claimed → in_review; + added completion $COMPLETION_ID\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id)

curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

```bash
# Wanted is in_review
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,status,evidence_url%20FROM%20wanted%20WHERE%20id%20=%20%27$ITEM_ID%27" \
  | jq '.rows'

# Completion exists
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,wanted_id,completed_by,evidence%20FROM%20completions%20WHERE%20wanted_id%20=%20%27$ITEM_ID%27" \
  | jq '.rows'
```

### Pass criteria

- `wanted.status = "in_review"`, `wanted.evidence_url = $EVIDENCE_URL`
- `completions` has a row with `completed_by = $RIG_HANDLE`, `evidence = $EVIDENCE_URL`

## Flow 7: Accept → completed + stamp (Path B — worker-direct)

### Preconditions

- Item is in `in_review` state with a `completions` row.

### Execution

Accept is a compound operation:

1. `wanted.status = 'completed'`
2. Insert a new `stamps` row with `valence`, `confidence`, `context_id = $ITEM_ID`
3. Update the `completions.validated_by` and `stamp_id` to link

```bash
MAINTAINER_RIG="$RIG_HANDLE"  # In self-owned scenario, same rig
STAMP_ID="s-$(openssl rand -hex 8)"
COMPLETION_ID=$(curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id%20FROM%20completions%20WHERE%20wanted_id%20=%20%27$ITEM_ID%27%20LIMIT%201" \
  | jq -r '.rows[0].id')

BRANCH="e2e-accept-$ITEM_ID"

# Write 1 (create branch): UPDATE wanted to completed
SQL1="UPDATE wanted SET status='completed', updated_at=NOW() WHERE id='$ITEM_ID'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL1")}"
sleep 3

# Write 2 (same branch): INSERT stamp
# NOTE: valence must use numeric quality (1-5 scale) per the commons
# convention and MUST satisfy CHECK (author != subject).
SQL2="INSERT INTO stamps (id, author, subject, valence, confidence, context_id, context_type, created_at) VALUES ('$STAMP_ID', '$MAINTAINER_RIG', '$RIG_HANDLE', '{\"quality\":5,\"reliability\":5}', 0.9, '$ITEM_ID', 'wanted', NOW())"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/$BRANCH/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL2")}"
sleep 3

# Write 3 (same branch): UPDATE completions to link to the stamp
SQL3="UPDATE completions SET validated_by='$MAINTAINER_RIG', stamp_id='$STAMP_ID', validated_at=NOW() WHERE id='$COMPLETION_ID'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/$BRANCH/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL3")}"
sleep 3

PULL_ID=$(curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] accept $ITEM_ID with stamp $STAMP_ID\",
    \"description\": \"~ modified: id=$ITEM_ID, status: in_review → completed; + added stamp $STAMP_ID\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id)

curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

```bash
# Wanted is completed
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,status%20FROM%20wanted%20WHERE%20id%20=%20%27$ITEM_ID%27" | jq '.rows'

# Stamp exists
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,subject,author,valence%20FROM%20stamps%20WHERE%20context_id%20=%20%27$ITEM_ID%27" | jq '.rows'

# Completion linked
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20id,validated_by,stamp_id%20FROM%20completions%20WHERE%20wanted_id%20=%20%27$ITEM_ID%27" | jq '.rows'
```

### Pass criteria

- `wanted.status = "completed"`
- `stamps` row exists with `context_id = $ITEM_ID`, `author = $MAINTAINER_RIG`, `subject = $RIG_HANDLE`
- `completions.validated_by = $MAINTAINER_RIG` and `completions.stamp_id = $STAMP_ID`

## Flow 8: Reject → back to claimed (Path B — worker-direct)

### Preconditions

- Item is in `in_review` state.

### Execution

```bash
BRANCH="e2e-reject-$ITEM_ID"

# Write 1 (create branch): UPDATE wanted back to claimed, clear evidence
SQL1="UPDATE wanted SET status='claimed', evidence_url=NULL, updated_at=NOW() WHERE id='$ITEM_ID'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL1")}"
sleep 3

# Write 2 (same branch): DELETE the completion
SQL2="DELETE FROM completions WHERE wanted_id='$ITEM_ID'"
curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/$BRANCH/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL2")}"
sleep 3

PULL_ID=$(curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] reject $ITEM_ID\",
    \"description\": \"~ modified: id=$ITEM_ID, status: in_review → claimed; - removed completion\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id)

curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

```bash
wait_for_upstream $ITEM_ID claimed $RIG_HANDLE
# No stamp
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20COUNT(*)%20FROM%20stamps%20WHERE%20context_id%20=%20%27$ITEM_ID%27" \
  | jq '.rows'
```

### Pass criteria

- Upstream: `status = "claimed"`, `claimed_by = $RIG_HANDLE` (unchanged)
- No `stamps` row for this item

## Flow 9: Close → completed without stamp (Path B — worker-direct)

### Preconditions

- Item is in `in_review` state (fresh from flow 6).

### Execution

```bash
BRANCH="e2e-close-$ITEM_ID"
SQL="UPDATE wanted SET status='completed', updated_at=NOW() WHERE id='$ITEM_ID'"

curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/write/main/$BRANCH" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{\"q\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SQL")}"
sleep 3

PULL_ID=$(curl -s -X POST "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
  -H "authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[e2e] close $ITEM_ID (no stamp)\",
    \"description\": \"~ modified: id=$ITEM_ID, status: in_review → completed (no stamp)\",
    \"fromBranchOwner\": \"$UPSTREAM_OWNER\",
    \"fromBranchDb\": \"$UPSTREAM_DB\",
    \"fromBranch\": \"$BRANCH\",
    \"toBranch\": \"main\"
  }" | jq -r .pull_id)

curl -s -X POST -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
wait_for_pr_merged $PULL_ID
```

### Verification

```bash
wait_for_upstream $ITEM_ID completed $RIG_HANDLE
curl -s -H "authorization: token $TOKEN" \
  "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20COUNT(*)%20FROM%20stamps%20WHERE%20context_id%20=%20%27$ITEM_ID%27" \
  | jq '.rows'
```

### Pass criteria

- `wanted.status = "completed"`
- No `stamps` row for this item

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

| Symptom                                                      | Likely cause                                                                                                                     | Fix                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Browse query failed: unknown certificate ...`               | Container Bun TLS broken in local dev                                                                                            | Use `/browse-direct` instead                                                                      |
| `wl claim failed: push failed`                               | Dolt JWK missing or mismatched                                                                                                   | Reconnect via onboarding dialog with correct JWK                                                  |
| `wl claim failed: rig not found`                             | Registration PR not merged yet                                                                                                   | Merge flow 1's PR first                                                                           |
| `wl post failed: EOF` or all container writes fail           | workerd container HTTPS egress broken in local dev                                                                               | Use Path B (worker-direct) flows instead                                                          |
| DoltHub write returns `Success` but nothing lands on branch  | Multi-statement SQL silently skipped, OR check constraint violation (e.g. `stamps.author != subject`)                            | Split into separate writes per statement; verify against `SHOW CREATE TABLE <t>` check constraints |
| PR state stuck on `Open` after merge call                    | DoltHub async processing                                                                                                         | Wait 5–30s; use `wait_for_pr_merged`                                                              |
| `cannot merge pull that is not open`                         | PR already merged or closed                                                                                                      | Check current state; pick a different PR                                                          |
| Container not responding (`[not connected]`)                 | Wrangler dev registry missed the binding                                                                                         | Restart gastown wrangler dev; check binding shows `wasteland-dev#WastelandRPCEntrypoint`          |
| `stamps` INSERT succeeds but doesn't commit                  | Violating `CHECK (author != subject)` constraint                                                                                 | Ensure `author` and `subject` are different rig handles                                           |

## Schema constraints

Discovered during E2E verification. Check `SHOW CREATE TABLE <t>` on upstream main for the authoritative list.

| Table         | Constraint                  | Implication for tests                                                   |
| ------------- | --------------------------- | ----------------------------------------------------------------------- |
| `stamps`      | `CHECK (author != subject)` | Contributor and maintainer must be different rigs                       |
| `stamps`      | `valence` is NOT NULL JSON  | Must provide valid JSON object (can use MySQL `JSON_OBJECT(...)`)        |
| `wanted`      | (PK: id)                    | Use unique `w-<hex>` IDs per item                                       |
| `completions` | (PK: id)                    | Use unique `c-<hex>` IDs                                                |
| `rigs`        | (PK: handle)                | Register each rig before it can appear as `author`/`subject` on a stamp |
