# Admin Mode & Wasteland Creation

Plan, design, and implementation status for unlocking admin capabilities
(direct pushes, accept/reject/stamp, PR management) in the wasteland UI
and for cleanly separating the **join an existing wasteland** flow from
the **create your own** flow.

Companion docs:

- [`wl-cli-reference.md`](./wl-cli-reference.md) — the underlying `wl` CLI semantics
- [`e2e-testing.md`](./e2e-testing.md) — verification playbooks

## Mental model

Two orthogonal concepts drive everything in this area:

1. **Wasteland governance** (owner / maintainer / contributor) — who can
   add members, change config, delete the wasteland. Stored on
   `wasteland_members.role`. This is about the wasteland DO record and
   doesn't touch DoltHub.

2. **Upstream authority** (`is_upstream_admin: boolean`) — whether the
   user's stored DoltHub token has push access to the upstream repo.
   This is what unlocks "admin mode": direct pushes via `wl --direct`,
   PR merge controls, accept/reject/close via `wl accept` (rather than
   only being able to submit fork PRs).

They are independent. A user can:

- Own a wasteland record pointing at `hop/wl-commons` without owning
  that DoltHub repo → owner role, `is_upstream_admin=false`.
- Create a wasteland for a DoltHub repo they own → owner role,
  `is_upstream_admin=true`.
- Be a contributor on a wasteland whose DoltHub repo they also happen
  to own → contributor role, `is_upstream_admin=true` (unusual but
  valid).

We use **explicit user attestation** ("I own this upstream" checkbox)
instead of probing DoltHub for push rights, because:

- DoltHub probing requires an extra API call on every auth event.
- Probing can race with permission changes.
- The user is the source of truth for their own claim. If they're wrong,
  the first direct-push attempt fails loudly with a DoltHub 403.

## Two distinct UI flows

The Connect dialog today conflates "pick an existing wasteland" and
"create a new one". After this work it should become two distinct
entry points from the town settings screen:

- **Join a wasteland** (primary CTA) — pick from existing wastelands
  the user can contribute to (including the Kilo Commons), or paste
  an upstream URL to join one that isn't in their list. Default to
  contributor role. Admin checkbox is off by default.
- **Create your own wasteland** — asks for name + target upstream
  (optionally prefilled from a "fork hop/wl-commons" shortcut).
  Calls `createWasteland` → `storeCredential(isUpstreamAdmin=true)` →
  `createUpstream` (invokes `wl create` on the container) →
  `connectKiloTown`. The user is always owner + admin on the created
  wasteland.

## Architecture summary

```
Browser
  ├── Connect dialog (Join branch)        ─┐
  │                                         │  wasteland tRPC
  └── Connect dialog (Create branch)      ─┤ ──────────────────────►
                                            │
Gastown worker                              │  wasteland worker
  ├── town settings UI                      │    ├── wastelandRouter (tRPC)
  │                                         │    │     storeCredential (isUpstreamAdmin)
  │                                         │    │     setUpstreamAdmin
  │                                         │    │     createUpstream
  │                                         │    │     {claim,unclaim,post,done,accept,reject,close}WantedItem(direct?)
  │                                         │    │
  │  RPC service binding                   │    └── wanted-board-ops
  │  (WastelandRPCEntrypoint) ◄────────────┘          │
  │                                                    │
  │                                                    ▼
Mayor container                                    WastelandContainer (workerd)
  └── tools: gt_wasteland_{browse,claim,post,done}   └── control-server (Bun)
                                                           └── wl CLI
                                                                 │ (--direct when admin)
                                                                 ▼
                                                            DoltHub
```

Where admin mode plugs in:

- Credential row: `is_upstream_admin` column (`0 | 1`).
- `loadContext` in `wanted-board-ops.ts` returns `isUpstreamAdmin`.
- `resolveDirect(requested, isUpstreamAdmin)` gates the `--direct` flag:
  requested && admin → direct, otherwise PR mode.
- Container `withDirect(subcommand, rest, direct)` prepends `--direct`
  to the wl invocation when gated.

## What landed in this session

Six commits on `wasteland-staging-v3`, in order:

| Commit      | Scope                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `65710fb2c` | **Fix**: DoltHub timestamp parsing + default sort. `parseDoltDate()` treats tz-less values as UTC; sort defaults to "last activity desc" (max of `updated_at`, `created_at`).                                                                                                                                                                                  |
| `8ef0981bf` | **Admin schema**: `is_upstream_admin` column on `wasteland_credentials` with idempotent `ALTER TABLE` migration. Threaded through `storeCredential` + new `setUpstreamAdmin` tRPC procedure. Extended `WastelandCredentialStatusOutput` with the flag.                                                                                                         |
| `25b3e7877` | **Admin UI — minimal**: "I own this upstream" checkbox on the credentials step of the Connect dialog. Amber "Admin" badge + toggle row in the connected-state settings card. Also added `WantedBoardRowOutput` Zod schema and a wasteland `tsconfig.types.json` so the web app gets the full row type (no more `Record<string, unknown>` in the UI).           |
| `590bf166d` | **Direct-mode plumbing**: `direct?: boolean` threaded through tRPC → ops → container → `wl` CLI. `resolveDirect` gate in `wanted-board-ops`. `withDirect` helper in the control server. New tRPC procedures: `unclaimWantedItem`, `acceptWantedItem`, `rejectWantedItem`, `closeWantedItem`. Mirrored on `WastelandRPCEntrypoint` for the gastown mayor tools. |
| `de821f58c` | **createUpstream**: `POST /wl/create` container endpoint + `createUpstream` tRPC procedure. Requires owner access + `is_upstream_admin=true`. Invokes `wl create <org/db>` with `--name/--display-name/--handle/--email`. Auto-registers the caller as `role='owner', trust_level=3` in `wasteland_members` on `createWasteland`.                              |

### Concrete changes by layer

**Schema / DO (backend)**

- `services/wasteland/src/db/tables/wasteland-credentials.table.ts`:
  - Added `is_upstream_admin` column (integer in SQLite, boolean in
    TypeScript via a Zod coercion).
  - `migrateAddIsUpstreamAdmin()` inspects `PRAGMA table_info` and runs
    the `ALTER TABLE` only when the column is missing, so existing DOs
    pick it up on next init without a migrations system.
- `services/wasteland/src/dos/wasteland/credentials.ts`:
  - `storeCredential` now accepts an input object with
    `isUpstreamAdmin?: boolean` (breaking signature change — inline
    params replaced with a single object).
  - New `setIsUpstreamAdmin(sql, wastelandId, userId, value)` helper.

**tRPC (backend)**

- `services/wasteland/src/trpc/router.ts`:
  - `storeCredential` — new optional `isUpstreamAdmin` field.
  - `getCredentialStatus` — returns the flag.
  - `setUpstreamAdmin` — new mutation for toggling post-connect.
  - `createWasteland` — now calls `stub.addMember(userId, 'owner', 3)`
    so creators have a real member row.
  - `createUpstream` — new mutation gated on admin; invokes `wl create`
    in the container; persists the resulting upstream on the config.
  - `claim/unclaim/post/done/accept/reject/closeWantedItem` — each now
    accepts `direct?: boolean`; defaulted to false; silently downgraded
    when caller is not upstream admin.
- `services/wasteland/src/trpc/schemas.ts`:
  - `WastelandCredentialStatusOutput` gained `is_upstream_admin`.
  - New `WantedBoardRowOutput` schema (used as `.output()` on
    `browseWantedBoard`) so the web type is strongly shaped.

**Ops module (backend)**

- `services/wasteland/src/wanted-board/wanted-board-ops.ts`:
  - `loadContext` returns `isUpstreamAdmin`.
  - `resolveDirect(requested, isUpstreamAdmin)` — silent downgrade.
  - Added exports: `unclaimWantedItem`, `acceptWantedItem`,
    `rejectWantedItem`, `closeWantedItem`.
  - Expanded `ContainerPath` union.

**RPC entrypoint (backend, for gastown)**

- `services/wasteland/src/wasteland-rpc.entrypoint.ts`:
  - All seven wanted-board methods now accept optional `direct`.
  - New methods: `unclaimWantedItem`, `acceptWantedItem`,
    `rejectWantedItem`, `closeWantedItem`.

**Container control server (backend)**

- `services/wasteland/container/control-server/server.ts`:
  - `withDirect(subcommand, rest, direct)` helper that prepends
    `--direct` when flagged. Cobra accepts the flag either before or
    after positionals; we standardize on prefix form.
  - `/wl/{claim,unclaim,post,done,accept,reject,close}` now accept
    `direct` in the body.
  - `/wl/create` new endpoint calling `wl create <org/db>` with 5-min
    timeout (DoltHub repo creation + initial push is slow).

**UI (frontend)**

- `apps/web/src/app/(app)/gastown/[townId]/settings/WastelandSettingsSection.tsx`:
  - Credentials step of the Connect dialog: "I own this upstream"
    checkbox wired to `storeCredential`'s new `isUpstreamAdmin` field.
    The post-connect toggle lives on the wasteland settings page, not
    here — this page only shows connection status.
- `apps/web/src/app/(app)/wasteland/[wastelandId]/settings/SettingsClient.tsx`:
  - DoltHub Connection section: amber "Admin" badge next to the
    connected label, plus an inline "I own this upstream (admin mode)"
    toggle row that calls `setUpstreamAdmin` on change.
- `apps/web/src/app/(app)/wasteland/[wastelandId]/wanted/WantedBoardClient.tsx`:
  - `parseDoltDate()` helper (UTC-assumption fallback).
  - Sort default changed from `priority` (no-op because
    `Number('medium') === NaN`) to `activity` (max of `updated_at`,
    `created_at`).
  - Fallback string coercion on nullable `type`/`priority` when
    indexing color maps.
- `apps/web/src/lib/wasteland/types/{router,schemas,init}.d.ts` —
  regenerated from the service via the new
  `services/wasteland/tsconfig.types.json`.

## What's still open

Three remaining work items, all UI-heavy. Backend plumbing for each is
already in place, but do keep an eye out for potentially missing backend plumbing or incorrect implementations. It's your job to verify that the UI works and that includes making backend changes as necessary.

### Status (this session)

All three workstreams below have landed behind the existing
`is_upstream_admin` gate (no separate feature flag). New backend tRPC
procedures added:

- `listPendingPRs` / `mergeUpstreamPR` / `closeUpstreamPR` — DoltHub PR
  management via the stored admin credential.
- `verifyUpstreamAdmin` — probes DoltHub write access with a no-op
  scratch-branch write.
- `listUpstreamRigs` / `setUpstreamRigTrust` — reads the upstream `rigs`
  table and writes trust-level changes via the DoltHub write API.

These live in `src/trpc/router.ts` and share a small `dolthub-api.util.ts`
client. Frontend types regenerated via `tsconfig.types.json` and copied
into `apps/web/src/lib/wasteland/types/`.

### WS-Admin 7 — Split Connect dialog into Join + Create

**File**: `apps/web/src/app/(app)/gastown/[townId]/settings/WastelandSettingsSection.tsx`

Today the dialog has a `select → credentials → identity → connecting → success`
linear flow. The "Create new" button at the bottom of select just bypasses
the list and creates a new wasteland pointed at `upstreamInput` — it's
implicitly the "create your own" path but not distinguished clearly.

**Proposed shape**:

```
                     ┌──────── Connect ────────┐
                     │                          │
                     │  [Join a wasteland]     │  ← primary CTA
                     │  [Create your own]      │  ← secondary
                     │                          │
                     └──────────────────────────┘
                        │                    │
                        ▼                    ▼
                  Join branch         Create branch
                  ───────────         ─────────────
              select wasteland       name + upstream
                     │                      │
                     ▼                      ▼
                credentials          credentials (admin=true implicit)
                     │                      │
                     ▼                      ▼
                identity             identity
                     │                      │
                     ▼                      ▼
                connecting           connecting
                 (join + connect)     (create + store + createUpstream + connect)
                     │                      │
                     ▼                      ▼
                  success              success
```

**Implementation notes**:

- Replace the `Step` union `'select' | 'credentials' | 'identity' | 'connecting' | 'success'`
  with `'intent' | 'select' | 'new-details' | 'credentials' | 'identity' | 'connecting' | 'success'`.
- `'intent'` is the new starting step; sets `mode: 'join' | 'create'`.
- `'new-details'` is only for Create mode — collects wasteland name +
  upstream (default: `${dolthubOrg}/wl-commons` prefilled once user
  types an org in credentials).
- Credentials step in Create mode pre-checks the admin box (user
  creating their own upstream by definition has push rights) but leaves
  it toggleable.
- `handleConnect` branches on `mode`:
  - Join: `createWasteland(..., dolthubUpstream)` if not preselected,
    then `storeCredential`, then `connectKiloTown`, then
    `connectTownToWasteland` (current behavior).
  - Create: `createWasteland(name, ownerType, dolthubUpstream)`, then
    `storeCredential({isUpstreamAdmin: true})`, then `createUpstream`
    (runs `wl create` in the container), then `connectKiloTown`
    (persists the town↔wasteland mapping on the wasteland DO; no-ops on
    the member add because `createWasteland` already registered the
    caller as owner), then `connectTownToWasteland` (persists the
    mapping on the Town DO). Both `connectKiloTown` and
    `connectTownToWasteland` are required because each writes to a
    different DO.
- The Join branch's "Create new" fallback button can be dropped — it's
  redundant once the intent step exists.
- Success copy differs: Join says "Connected to X"; Create says
  "Your wasteland is live at X. You can invite contributors from
  settings."

**Acceptance**:

1. Intent step picks branch; Back returns to intent.
2. Join branch behaves identically to today's flow minus the
   accidental "Create new" shortcut.
3. Create branch successfully runs `wl create`, lands a new DoltHub
   repo, connects the town, and the user shows as owner + admin in
   settings.
4. Only one tRPC client instance is held across branches — don't
   recreate on step transitions.

### WS-Admin 6 — Admin actions on the wanted board

**File**: `apps/web/src/app/(app)/wasteland/[wastelandId]/wanted/WantedBoardClient.tsx`

Today the board supports claim + done via the dialogs. Admins should
additionally see accept / reject / close buttons on items in the
appropriate states, plus a "Merge directly" toggle on action dialogs.

**Proposed changes**:

1. **Query credential status once** at the top of the client:

   ```ts
   const credQuery = useQuery(trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId }));
   const isAdmin = credQuery.data?.is_upstream_admin ?? false;
   ```

2. **Admin-only buttons** on item cards and the detail panel, gated by
   `isAdmin && item.status === 'in_review'` (for accept/reject/close)
   and `isAdmin && item.status === 'claimed'` (for unclaim — also
   available to the claimer themselves today, but admins can unclaim
   others' claims).

3. **New dialogs**:
   - `<AcceptDialog item={item}>` — collects `quality` (1-5 enum),
     optional `comment`, and a "Merge directly" checkbox (defaults to
     false, only shown for admins). On submit calls
     `trpc.wasteland.acceptWantedItem.mutate({ direct })`.
   - `<RejectDialog item={item}>` — required `comment`, direct toggle,
     calls `rejectWantedItem`.
   - `<CloseDialog item={item}>` — confirm-only, direct toggle, calls
     `closeWantedItem`.
   - `<UnclaimButton item={item}>` — no dialog, just a confirm prompt.
     Calls `unclaimWantedItem`.

4. **Optimistic state overlay** (ties to the earlier "pending" state
   discussion): when a mutation is in flight, show the item in its
   expected post-mutation state with a subtle indicator ("pending
   merge" text, reduced opacity). Persist the optimistic entry in
   `pending_claims` (we agreed on Option C earlier but deferred
   building it). For this WS, the simplest landing is **toast-only
   feedback** (no persistence) and defer the full `pending_claims` DO
   table to a follow-up ticket.

5. **Merge button for PRs directly from the board**: in admin mode,
   items currently in `claimed` or `in_review` with an outstanding PR
   (detected via `findUpstreamPRForItem`) get a "Merge PR #N" button
   that calls the existing worker-direct `POST /dolthub/.../merge` —
   actually we should **not** use the `/debug` endpoints for this;
   instead add a new `mergeUpstreamPR` tRPC mutation that wraps the
   same DoltHub call with proper auth.

**New backend work needed**:

- `mergeUpstreamPR(wastelandId, pullId)` tRPC mutation — authorized on
  `requireOwnerAccess`. Uses the stored credential to call the DoltHub
  merge API. Returns `{ status: 'merging' | 'merged', pullId }`.
- `listPendingPRs(wastelandId)` tRPC query — lists open PRs on the
  upstream, cross-referenced against the wanted board so the UI can
  show "PR #12 is pending for item w-abc". Output schema:
  `{ items: Array<{ pull_id, item_id, title, from_branch, state }> }`.

**Acceptance**:

1. Contributor (admin=false) sees no accept/reject/close controls.
2. Admin sees accept/reject/close on `in_review` items; unclaim on
   `claimed` items (including others').
3. Each action dialog has a "Merge directly" toggle; when checked
   passes `direct: true` to the mutation; when unchecked, the mutation
   creates a PR as today. Admin mode defaults direct to OFF to preserve
   audit trail (our Q3 decision).
4. Merge PR button hits the new `mergeUpstreamPR` tRPC mutation, not
   a `/debug` endpoint.
5. All mutations invalidate the browse query on success.

### WS-Admin 5 — Admin settings section

**File**: `apps/web/src/app/(app)/wasteland/[wastelandId]/settings/SettingsClient.tsx`
(primary wasteland settings, not the gastown town settings)

**Proposed additions**, visible only when `isAdmin`:

1. **Pending PRs list**:
   - Table: PR title, item ID, state, age, contributor rig.
   - Per-row actions: View on DoltHub (link), Merge, Close (no merge).
   - Backed by the new `listPendingPRs` + `mergeUpstreamPR` mutations
     from WS-Admin 6.

2. **Upstream connectivity test**:
   - Button: "Test admin access". Calls a new
     `verifyUpstreamAdmin` tRPC query that attempts a no-op write
     against the upstream via the DoltHub API
     (e.g. `write/main/test-{random}` with a `SELECT 1`). Returns
     `{ hasWriteAccess: boolean, error?: string }`. If
     `hasWriteAccess=false`, shows guidance to fix the token/org
     config or un-check the admin box.

3. **Rig management**:
   - List of rigs registered on upstream (from `rigs` table).
   - Per-rig: display name, trust level, last seen, registered at.
   - For owners: per-rig "Change trust level" dropdown backed by a
     direct-write against the upstream `rigs` table.
   - This is the only currently-reasonable way to elevate or demote
     contributors because `wl` doesn't expose a CLI command for it.

4. **Delete wasteland**:
   - Existing Delete section keeps its danger styling. In admin mode,
     append a warning: "This does NOT delete the upstream DoltHub
     repository. To fully decommission, also archive or delete
     `<owner>/<db>` on DoltHub."

**Acceptance**:

1. Non-admin sees none of the admin controls in settings.
2. Admin with a valid token sees all admin controls + a green
   "Admin access verified" badge after running the test.
3. Admin with an invalid/expired token sees a red
   "Admin access check failed" banner with a "Re-enter credential"
   link that opens the Connect dialog in Edit mode.

## Sequencing

These three workstreams are independent enough to parallelize, but in
practice the sensible order is:

1. **WS-Admin 6 first** — it's the most user-visible affordance and
   forces the `mergeUpstreamPR` / `listPendingPRs` tRPC work that
   WS-Admin 5 also needs. Ship it as a feature flag at first so
   non-admins aren't affected by any regressions.

2. **WS-Admin 5 second** — once `listPendingPRs` / `verifyUpstreamAdmin`
   exist, the admin settings section is mostly layout.

3. **WS-Admin 7 last** — the Join/Create split is invasive to an
   already-working flow, and we'd rather have admin affordances
   validated against a real admin-connected wasteland before reshaping
   the entry point. Create flow can then be confidently built knowing
   the admin experience downstream works.

Each workstream should ship as **one commit**, feature-flagged if
necessary (e.g. `WASTELAND_ADMIN_UI_ENABLED` behind a user attribute
check, or just gated on `is_upstream_admin=true` at the component level
which is effectively the same).

## Testing plan

All three workstreams need to be covered by the existing Path B
worker-direct E2E playbooks in [`e2e-testing.md`](./e2e-testing.md),
plus these additions:

1. **Admin toggle round-trip** (manual):
   - Connect a town with admin=false. Verify no admin controls.
   - Toggle admin=true in settings. Verify admin controls appear.
   - Re-load page. Verify state persists.
   - Toggle admin=false. Verify admin controls disappear.

2. **Direct mode verification** (Path A — requires working container
   egress, so likely prod-only):
   - Admin posts a wanted item with `direct=true`.
   - Container logs should show `"wl post: direct=true"`.
   - No PR should be created on upstream.
   - Item should land directly on upstream main.

3. **Create your own** (full E2E):
   - Complete the Create branch of the Connect dialog with a fresh
     upstream name (e.g. `<user>/e2e-test-$(date +%s)`).
   - Verify the DoltHub repo exists.
   - Verify `rigs` table has one row (the creator) on the new repo's
     main branch.
   - Verify wasteland_config, wasteland_members, and
     wasteland_credentials all have the expected rows.
   - Verify the Admin badge shows in town settings.
   - Post a wanted item, accept it, verify the stamp lands — the
     creator-admin should be able to author stamps on their own rig
     because `wl create` registers them as a rig, but the
     `CHECK (author != subject)` constraint still applies so
     self-acceptance is impossible.

## Known gotchas (carry-overs from prior work)

Documented at length in `e2e-testing.md`; quick recap:

- **Container HTTPS egress is broken in local wrangler dev.** Admin
  mode E2E tests must use production CF Containers, not local dev,
  because `wl` on the local container can't reach DoltHub.
- **DoltHub silently drops multi-statement SQL.** If we ever add a
  worker-side direct-write path (e.g. for rig trust-level changes in
  WS-Admin 5), each statement must be its own `POST /write` call on
  the same branch.
- **`stamps.author != subject` constraint.** The admin UI must not
  offer "Accept your own contribution" actions — the stamp would
  silently not commit.
- **DoltHub merge is async.** Any admin-merge UI must poll
  `GET /pulls/:id` after `POST /merge` and display an intermediate
  state until `state === 'Merged'`.

## Open design questions

None blocking. Things we might revisit after landing the above:

- **Per-wasteland admin delegation**. Right now `is_upstream_admin` is
  a per-user-per-wasteland credential attribute. If a wasteland owner
  wants to delegate admin rights to another member, they'd need to
  tell that member to check their own box. A future iteration could
  centrally store which members have admin rights, and have the
  `is_upstream_admin` flag be a DoltHub-auth check rather than
  self-attestation. Out of scope for this POC.
- **Review queue UX**. `wl pending` enumerates open PRs for an item.
  We could turn the item detail panel into a mini review queue,
  showing "3 open PRs pending on this item" with branch diffs inline.
  Defer until we have real multi-rig usage.
- **Optimistic state persistence** (the "pending" state discussion we
  tabled). Once admin actions land and users start seeing claim/done
  mutations in flight, the case for a `pending_mutations` DO table
  that survives refreshes gets stronger. Revisit in a focused ticket.
