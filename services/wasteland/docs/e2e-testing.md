# Wasteland E2E Testing Guide

Step-by-step playbooks for verifying every wasteland flow against a real
DoltHub upstream using the unauthenticated `/debug/*` endpoints exposed by
the wasteland worker.

Companion reference: [`wl-cli-reference.md`](./wl-cli-reference.md).

## Two execution paths

Each flow can be verified through one of two paths:

### Path A: Production code path (via wanted-board ops)

Uses the `POST /debug/wastelands/:id/{post,claim,done,...}` endpoints,
which delegate to the wanted-board ops layer
(`src/wanted-board/wanted-board-ops-sdk.ts`) → `@kilocode/wl-sdk` →
DoltHub. This mirrors exactly what production does.

### Path B: Worker-direct (low-level DoltHub probes)

Uses the `POST /debug/dolthub/{owner}/{db}/{write,pulls}` endpoints,
which fetch directly from the wasteland worker to DoltHub. This validates
**DoltHub state transitions** (branch creation, PR merge, upstream table
updates) without going through the wanted-board ops layer — useful for
diagnosing whether a failure is in the ops layer or upstream of it.

Each flow below is written against **Path B** for reliability and
explicit step-by-step visibility. To run the same flow through Path A,
substitute the `POST /debug/wastelands/:id/{op}` endpoint for the
explicit write+PR+merge steps.

## Prerequisites

**Running services** (both must be up — check with `lsof -iTCP -sTCP:LISTEN -Pn | grep -E ':(8787|8803)'`):

- `services/wasteland` — `pnpm dev` → listens on `:8787`
- `services/gastown` — `pnpm dev` → listens on `:8803`

**Credentials**:

- A **DoltHub token for the upstream owner** — used to merge PRs from the
  maintainer side and to perform worker-direct (Path B) writes. Available
  in the test environment as `$WL_ADMIN_DOLT_TOKEN`. This is different
  from the per-user token stored for a connected town (which goes through
  the encrypted credential flow on the WastelandDO).

**Known IDs** (fill in with your own values):

- `WASTELAND_ID` — the wasteland you are testing (e.g. `63bac39a-11d9-4e4e-8fdb-124d5abeb247`)
- `USER_ID` — the kilo user ID that owns the wasteland, discoverable via
  `GET /debug/wastelands/:WASTELAND_ID/status` (look at `config.owner_user_id`)
- `UPSTREAM` — the DoltHub upstream, e.g. `jrf0110/wl-commons`
  (discoverable via `GET /debug/wastelands/:WASTELAND_ID/status` →
  `config.dolthub_upstream`)
- `RIG_HANDLE` — the rig handle for this town's connection. Stored on
  the wasteland's credential row (`rig_handle` on
  `wasteland_credentials`); the rig handle typically matches the DoltHub
  org. For the **contributor** (posts and claims items).
- `MAINTAINER_RIG` — a separate registered rig that accepts PRs. For
  self-owned upstreams, the upstream owner's rig (e.g. `jrf0110`) is
  registered and used for accept/reject operations. Required because
  `stamps` has a `CHECK (author != subject)` constraint — the rig that
  authors a stamp must not be the rig that is the subject.

## Conventions

Throughout this doc:

- `$WL` = wasteland worker base URL (`http://localhost:8787`)
- `$GT` = gastown worker base URL (`http://localhost:8803`)
- `$TOKEN` = `$WL_ADMIN_DOLT_TOKEN` — a DoltHub API token with write
  access to the upstream. Required for all `/debug/dolthub/*` endpoints
  and for merging PRs from the maintainer side.
- `$UPSTREAM_OWNER` / `$UPSTREAM_DB` = split `$UPSTREAM` on `/`
  (e.g. `jrf0110` / `wl-commons`)

**Timing note**: DoltHub merge operations are **asynchronous**. After
`POST /pulls/:id/merge` returns, the PR state and the upstream `main` may
still show the pre-merge values for 5–30 seconds. Every flow below uses a
**poll-with-timeout** to wait for the merge to land, not a fixed sleep.

## Debug endpoint reference

### Inspection (read-only)

| Endpoint | Purpose |
|---|---|
| `GET $WL/debug/wastelands/:id/status` | Wasteland config, members, connected towns |
| `GET $WL/debug/wastelands/:id/browse-direct?-H Authorization:token ...` | Query upstream wanted via DoltHub SQL API directly |
| `GET $WL/debug/wastelands/:id/browse?userId=...` | Browse through the production wanted-board-ops path |
| `GET $WL/debug/wastelands/:id/auth-probe?userId=...` | Diagnose token auth issues against DoltHub (anon/local/fresh) |
| `GET $WL/debug/registry` | All wastelands in the global registry |
| `GET $GT/debug/towns/:id/wasteland` | Town DO's connected wasteland row |

### Lifecycle mutations (uses stored credential)

| Endpoint | Body |
|---|---|
| `POST $WL/debug/wastelands/:id/post` | `{userId, title, description, priority?, type?}` |
| `POST $WL/debug/wastelands/:id/claim` | `{userId, itemId}` |
| `POST $WL/debug/wastelands/:id/unclaim` | `{userId, itemId}` |
| `POST $WL/debug/wastelands/:id/done` | `{userId, itemId, evidence}` |
| `POST $WL/debug/wastelands/:id/accept` | `{userId, itemId, quality, comment?}` |
| `POST $WL/debug/wastelands/:id/reject` | `{userId, itemId, comment}` |
| `POST $WL/debug/wastelands/:id/close` | `{userId, itemId}` |

### Maintainer ops + worker-direct simulation

| Endpoint | Purpose |
|---|---|
| `GET $WL/debug/dolthub/:owner/:db/pulls?state=open` | List PRs (client-side filtered by state) |
| `GET $WL/debug/dolthub/:owner/:db/pulls/:pullId` | PR detail |
| `POST $WL/debug/dolthub/:owner/:db/pulls/:pullId/merge` | Merge PR (returns immediately; async) |
| `PATCH $WL/debug/dolthub/:owner/:db/pulls/:pullId` | Close `{state:"closed"}` (no merge) |
| `GET $WL/debug/dolthub/:owner/:db/sql?q=...` | Arbitrary SQL read |
| `POST $WL/debug/dolthub/:owner/:db/write/:from/:to?q=<SQL>` | Create branch `:to` from `:from` and run DML |
| `POST $WL/debug/dolthub/:owner/:db/pulls` | Create PR (body: `{title, description, fromBranch*, toBranch*}`) |

All `dolthub` endpoints require `Authorization: token $TOKEN`.

## Common helper functions

```bash
# Env for the rest of this doc
WL=http://localhost:8787
GT=http://localhost:8803
# $WL_ADMIN_DOLT_TOKEN is provided by the test environment — a DoltHub
# API token with write access to $UPSTREAM_OWNER/$UPSTREAM_DB.
TOKEN="$WL_ADMIN_DOLT_TOKEN"
WASTELAND_ID=63bac39a-11d9-4e4e-8fdb-124d5abeb247
UPSTREAM_OWNER=jrf0110
UPSTREAM_DB=wl-commons

# User ID lookup
USER_ID=$(curl -s $WL/debug/wastelands/$WASTELAND_ID/status | jq -r .config.owner_user_id)
# RIG_HANDLE — read from the credential row. With the wasteland Vitest
# DO at hand the easiest lookup is via tRPC (`getCredentialStatus`).
# In a one-off shell, hit auth-probe and copy the rig handle from there:
#   curl -s "$WL/debug/wastelands/$WASTELAND_ID/auth-probe?userId=$USER_ID" \
#     | jq -r .credential.rigHandle
RIG_HANDLE=$(curl -s "$WL/debug/wastelands/$WASTELAND_ID/auth-probe?userId=$USER_ID" \
  | jq -r '.credential.rigHandle // empty')

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

This flow runs automatically when a user joins a wasteland (via the
`joinWasteland` tRPC procedure or the connect dialog). It's documented
here so you understand the expected shape when verifying other flows.

### Preconditions

- Wasteland exists with `dolthub_upstream` configured.
- Credentials have been stored via `storeCredential` tRPC (or the
  onboarding dialog).
- `joinWasteland` has been invoked (creates the user's fork + opens the
  registration PR via the SDK).

### Verification steps

1. **Rig registration PR exists?** (may or may not be merged yet)

   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls" \
     | jq '.pulls[] | select(.title | contains("Register rig: '$RIG_HANDLE'"))'
   ```

2. **Merge the registration PR** (maintainer side):

   ```bash
   PULL_ID=... # from step 1
   curl -s -X POST -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/pulls/$PULL_ID/merge"
   wait_for_pr_merged $PULL_ID
   ```

3. **Rig appears on upstream main?**
   ```bash
   curl -s -H "authorization: token $TOKEN" \
     "$WL/debug/dolthub/$UPSTREAM_OWNER/$UPSTREAM_DB/sql?q=SELECT%20handle%20FROM%20rigs%20WHERE%20handle%20=%20%27$RIG_HANDLE%27"
   # Expect: rows: [{ handle: "$RIG_HANDLE" }]
   ```

### Pass criteria

- Registration PR state transitions to `Merged`
- `rigs` table on upstream main contains the rig handle

## Flow 2: Browse (read-only)

### Verification steps

1. **Browse via production path (through wanted-board ops + SDK)**:

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

| Symptom | Likely cause | Fix |
|---|---|---|
| `claim` / `post` returns `rig not found` | Registration PR not merged yet | Merge flow 1's PR first |
| DoltHub write returns `Success` but nothing lands on branch | Multi-statement SQL silently skipped, OR check constraint violation (e.g. `stamps.author != subject`) | Split into separate writes per statement; verify against `SHOW CREATE TABLE <t>` check constraints |
| PR state stuck on `Open` after merge call | DoltHub async processing | Wait 5–30s; use `wait_for_pr_merged` |
| `cannot merge pull that is not open` | PR already merged or closed | Check current state; pick a different PR |
| `stamps` INSERT succeeds but doesn't commit | Violating `CHECK (author != subject)` constraint | Ensure `author` and `subject` are different rig handles |
| Browse / claim returns `no such repository` | Token lacks access to upstream repo | Use `/auth-probe` to compare anon / local / fresh-token paths and identify which credential fails |

## Schema constraints

Discovered during E2E verification. Check `SHOW CREATE TABLE <t>` on upstream main for the authoritative list.

| Table | Constraint | Implication for tests |
|---|---|---|
| `stamps` | `CHECK (author != subject)` | Contributor and maintainer must be different rigs |
| `stamps` | `valence` is NOT NULL JSON | Must provide valid JSON object (can use MySQL `JSON_OBJECT(...)`) |
| `wanted` | (PK: id) | Use unique `w-<hex>` IDs per item |
| `completions` | (PK: id) | Use unique `c-<hex>` IDs |
| `rigs` | (PK: handle) | Register each rig before it can appear as `author`/`subject` on a stamp |

## Verification Results

Status of each flow after the E2E verification run on 2026-04-20.

| Flow | Status | Notes |
|---|---|---|
| 1 — Join & register | ✅ Verified (manual) | Registration PR #1 was manually merged; `jfawcett` appears in `jrf0110/wl-commons.rigs` on main. Maintainer rig `jrf0110` also registered via PR #7 during E2E setup. |
| 2 — Browse | ✅ Verified via sub-agent | `/debug/wastelands/:id/browse` fails in local dev due to container TLS egress issue; `/debug/wastelands/:id/browse-direct` returned 54 items matching `SELECT COUNT(*) FROM wanted`. |
| 3 — Post | ✅ Verified via sub-agent (PR #8) | Item `w-870be07fbc` landed on upstream main with `posted_by=jfawcett, status=open`. Path A (container-driven) fails in local dev due to `wl post` getting `EOF` from DoltHub write API; Path B (worker-direct) succeeded. |
| 4 — Claim | ✅ Verified via sub-agent (PR #9) | Item `w-870be07fbc` → `claimed, claimed_by=jfawcett`. Also separately via PR #5 earlier. |
| 5 — Unclaim | ✅ Verified via sub-agent (PR #14) | Fresh item `w-68aa4ab1dd`: open → claimed → open with `claimed_by=null`. |
| 6 — Done | ✅ Verified via sub-agent (PR #10) | Item `w-870be07fbc` → `in_review` with `evidence_url` set; completion `c-58cd6cc527b5bf3b` inserted. Required split writes (multi-statement SQL silently drops rows). |
| 7 — Accept + stamp | ✅ Verified via sub-agent (PR #11) | Item `w-870be07fbc` → `completed`. Stamp `s-35e8a923fe63c8cd` created with `author=jrf0110, subject=jfawcett` (CHECK `author != subject` satisfied); completion linked via `validated_by=jrf0110, stamp_id=s-35e8a923...`. Required 3 split writes on a single branch. |
| 8 — Reject | ✅ Verified via sub-agent (PR #18) | Fresh item `w-d2cf6acf6a`: open → claimed → in_review → claimed (reject). Final state: `status=claimed, evidence_url=null`, no completion, no stamp. |
| 9 — Close | ✅ Verified via sub-agent (PR #22) | Fresh item `w-89e6720ca4`: open → claimed → in_review → completed (close with no stamp). Final state: `status=completed`, no stamp. |
| 10 — Disconnect | Not yet executed | Requires manually invoking the `disconnectTownFromWasteland` tRPC. Lower priority since town disconnect is strictly a gastown operation and doesn't touch upstream data. |

### PR history (all merged on jrf0110/wl-commons)

| PR | Flow | Item ID |
|---|---|---|
| 4 | post (smoke; jrf0110) | `w-0e5abc1976` |
| 5 | claim | `w-0e5abc1976` |
| 6 | done | `w-0e5abc1976` |
| 7 | register rig: jrf0110 | — |
| 8 | post (jfawcett lifecycle) | `w-870be07fbc` |
| 9 | claim | `w-870be07fbc` |
| 10 | done | `w-870be07fbc` |
| 11 | accept | `w-870be07fbc` |
| 12 | post (flow 5) | `w-68aa4ab1dd` |
| 13 | claim | `w-68aa4ab1dd` |
| 14 | unclaim | `w-68aa4ab1dd` |
| 15 | post (flow 8) | `w-d2cf6acf6a` |
| 16 | claim | `w-d2cf6acf6a` |
| 17 | done | `w-d2cf6acf6a` |
| 18 | reject | `w-d2cf6acf6a` |
| 19 | post (flow 9) | `w-89e6720ca4` |
| 20 | claim | `w-89e6720ca4` |
| 21 | done | `w-89e6720ca4` |
| 22 | close | `w-89e6720ca4` |

### Findings that drove doc updates

1. **Path B (worker-direct) is retained for low-level upstream debugging.** The wanted-board ops layer now talks to DoltHub directly via `@kilocode/wl-sdk` (no container in between), so Path A and Path B differ mainly in whether the ops layer is exercised. Path B remains the simplest tool for diagnosing whether a failure originates in the ops/SDK layer or in DoltHub itself.

2. **DoltHub's write API silently drops multi-statement SQL.** Calls like `UPDATE ...; INSERT ...;` return `Success` at submission but nothing lands on the branch. Each statement must be its own write call. Subsequent writes to the same branch use `write/{branch}/{branch}` (fromBranch == toBranch) rather than `write/main/{branch}`.

3. **The `stamps` table has `CHECK (author != subject)`.** This was invisible to `DESCRIBE` but visible via `SHOW CREATE TABLE stamps`. The check fails silently (no error returned; the write just doesn't commit). Any stamp INSERT must use distinct rigs for author and subject.

4. **stamps.valence convention**: existing rows use numeric 1-5 scale like `{"quality":5,"reliability":5}`. The column is JSON-typed; string values like `{"quality":"good"}` are syntactically valid JSON but may not match consumer expectations.

5. **DoltHub's `pulls?state=open` filter is ignored server-side** — the endpoint returns all PRs regardless of state. The worker debug endpoint filters client-side on `state` to compensate.

6. **Merge is asynchronous with variable latency.** Typical merge latency observed in verification runs: 5–15s (1–3 poll iterations at 5s each). No merge exceeded 60s in any successful run. Use `wait_for_pr_merged` with a 60s timeout.

7. **Rate limit / outage sensitivity**: after ~30 minutes of aggressive E2E testing (roughly 5 PRs + 20 writes + 40 reads), DoltHub began returning connection timeouts from our IP. Back off aggressively if you see consistent 000 / timeout responses — wait 5-10 minutes before resuming.
