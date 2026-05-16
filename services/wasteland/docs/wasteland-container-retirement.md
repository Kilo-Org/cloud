# Plan: retire the wasteland Cloudflare Container

## Goal

Remove the `WastelandContainerDO` Cloudflare Container, the
`container/control-server` Bun process, and the `wl` CLI shipped
inside it. Replace every remaining container-bound code path with a
worker-side equivalent that talks directly to DoltHub. End state:
`services/wasteland` is a pure Worker — no Docker image, no Bun
runtime, no `wl` binary, no `dolt` CLI.

## Background

We've already swapped all eight wanted-board operations
(`browse`, `claim`, `unclaim`, `done`, `post`, `accept`, `reject`,
`close`) to run via the libwl WASM bundle. See
`services/wasteland/docs/wasm-poc.md` for the migration story.

The container is now used for a small, well-bounded set of
operations:

1. **`wl create`** — bootstrapping a brand-new commons. The only path
   that strictly needs the local `dolt` CLI today.
2. **`wl join`** / `wl init` — the original "fork upstream and
   register a rig" path. Currently invoked from
   `storeCredential` and `containerJoin` after `createUpstream`. The
   container's `selfInit` mostly bypasses this with a
   synthetic-config shortcut, but the code is still wired.
3. **Diagnostic endpoints** — `containerStatus` and
   `containerHealth` proxy `/wl/config` and `/health` from the
   container so the Settings UI can show "container running, joined,
   has token" indicators.
4. **POC mutation routes** that exist only for local validation
   (`/poc/wasm/*`) — these are scaffolding to be removed.

There are also dead-but-still-deployed routes on the container:
the seven mutation endpoints (`/wl/claim`, `/wl/unclaim`, etc.) and
`/wl/browse`. Nothing in the Worker calls them anymore.

A complete inventory of remaining call sites is at the end of this
doc.

## Strategy

The plan is split into three sequential phases, each independently
deployable:

- **Phase 1: Worker-side `wl create`.** Reimplement
  `createUpstream` against DoltHub's REST API. No more
  `/wl/create` container call. After this lands, `wl create` is the
  only thing keeping the `dolt` CLI alive in the container — which
  we no longer need.
- **Phase 2: Replace `containerJoin` / `containerStatus` / store
  side-effects.** The other three remaining container call sites
  (`storeCredential`'s init push, `containerJoin`,
  `containerStatus`) all ultimately do things we now do directly:
  set up DoltHub credentials, probe whether the upstream exists, or
  write a tiny chunk of state. Replace each with a worker-side
  equivalent or remove entirely if it's no longer meaningful.
- **Phase 3: Delete the container.** Drop
  `WastelandContainerDO`, the `container/` directory, the wrangler
  container binding, and the migration entry. Update
  `wasteland.worker.ts` debug routes. Final cleanup.

The phases are designed so that **at the end of Phase 1, the
container could be removed in production with zero user-visible
behavior change** if we wanted to ship it that way. Phase 2 is
about cleaning up code paths that were always going to be retired
along with the container. Phase 3 is the actual deletion.

## Non-goals

- Refactoring libwl or the wasteland Go SDK beyond what's strictly
  required to make `wl create` callable from a Worker. Upstream
  improvements (proper JSON tags on `MutationResult`, etc.) are
  separately tracked in `services/wasteland/docs/wasm-poc.md` and
  are out of scope here.
- Changing the `WastelandDO` (the per-wasteland metadata DO) — only
  the Container DO is being retired.
- Removing the manual-API-token credential path. That stays as the
  production fallback; OAuth is still dev-only.
- Touching the `WastelandRegistryDO`. Untouched.

---

## Phase 1: Worker-side `wl create`

### What `wl create` actually does

Three steps, all currently inside the container:

1. **Initialize a new DoltHub repo.** `wl create` calls
   `dolt init` on a local clone, applies
   `wasteland/schema/commons.sql` via `dolt sql`, commits, then
   `dolt push origin main`. Result: an empty repo on DoltHub
   populated with the wasteland commons schema (the `wanted`,
   `rigs`, `completions`, `stamps` tables and friends).
2. **Register the creator as the first rig.** Inserts a row into
   the `rigs` table (`handle`, `display_name`, `dolthub_org`,
   `owner_email`, `gt_version`, `trust_level=3`, etc.). See
   `wasteland/internal/federation/federation.go:RegisterRig`.
3. **Persist local state.** Writes a synthetic XDG config so the
   container's `selfInit` doesn't try to re-init on the next boot.
   This step is container-internal bookkeeping and goes away with
   the container.

### Approach

The DoltHub REST API supports both pieces directly:

- **Repo creation.** `POST https://www.dolthub.com/api/v1alpha1/{owner}/{db}` with the
  user's OAuth token creates a new database. (Verify exact path
  during implementation; DoltHub's API docs have this under
  "create database".) If DoltHub doesn't expose programmatic
  database creation, fall back to having the user create the empty
  repo on dolthub.com first and only run steps 2-3 from the
  worker — document this in the UI.
- **Schema + initial rig.** The DoltHub write API
  (`POST /{owner}/{db}/write/{from}/{to}?q={sql}`) can apply the
  schema and initial `rigs` insert as DML. Multiple statements
  must be sent as separate calls (see `RemoteDB.Exec` in the
  wasteland Go SDK for the same sequencing pattern). For the
  schema, ship `wasteland/schema/commons.sql` as an ESM string
  import in the cloud monorepo and split it on `;` boundaries.

### Tasks

1. **Verify DoltHub creation API.** Spike-test
   `POST /api/v1alpha1/{owner}/{db}` with an OAuth token against a
   throwaway repo name. Document the request shape and minimum
   token scopes. If the API requires UI interaction (no programmatic
   creation), we go with the "user creates empty repo first" model.
   Decide before starting (2)-(5).
2. **Land `commons.sql` as a TS asset.** Copy
   `wasteland/schema/commons.sql` to
   `cloud/services/wasteland/src/commons-schema.sql` and import as
   a string. Do not pull from the wasteland repo at build time —
   the cloud repo doesn't have access to that path during deploy.
   Pin the schema version in a comment so we know when it drifts.
3. **Write `services/wasteland/src/upstream-bootstrap/`**:
   - `create-upstream.ts` — the orchestration:
     - call DoltHub create-repo (or assume it exists)
     - apply `commons.sql` via DoltHub write API, statement by
       statement, polling each operation
     - apply the initial `RegisterRig` DML using the same shape
       as `wasteland/internal/federation/federation.go:RegisterRig`
     - return success/failure
   - `dolthub-write.ts` — small typed wrapper around the write
     API. Mirror the polling logic in
     `wasteland/internal/backend/remote.go:execOne` /
     `pollOperation`. Handles the async `operation_name` flow.
   - `commons-schema.sql` — the static schema asset.
4. **Replace `createUpstream` in `trpc/router.ts`.**
   - Remove the `getWastelandContainerStub` + `container.fetch('/wl/create')` block.
   - Replace `decryptToken(...)` with `loadAdminContext(...)` to
     get a fresh OAuth token (fall back to local if the OAuth
     endpoint is unreachable).
   - Call the new `createUpstream` from `upstream-bootstrap/`.
   - Keep `requireOwnerAccess`, the admin gate, the
     `updateConfig`, and the metering call exactly as they are.
5. **Drop the side effects in `storeCredential`**.
   `storeCredential` currently pushes `DOLTHUB_TOKEN`, `DOLTHUB_ORG`,
   and (when the upstream exists) `WL_UPSTREAM` into the container
   env, then optionally calls `/wl/init`. None of that is needed by
   the wasm path. Strip lines 695-734 (the `if (config.owner_user_id === ctx.userId)` block)
   entirely, leaving just the encryption + DO `storeCredential` call.
   Verify by smoke-testing storeCredential against a fresh wasteland.
6. **Delete `containerJoin` from the tRPC router.** Once
   `storeCredential` no longer drives container init, this
   procedure has no callers. Confirm via grep across `cloud/apps/web/`
   and remove. If a UI somewhere still calls it, replace with a
   no-op that just returns `{ success: true }` for one release
   cycle so older clients don't 404.
7. **Tests.**
   - Unit: schema parser splits statements correctly (semicolons
     inside string literals shouldn't split). Reuse or copy the
     pattern from `wasteland/internal/commons` if there's one.
   - Integration: `cloud/services/wasteland/test/`-level test that
     stubs `fetch` and asserts the right write-API calls happen in
     the right order. We do **not** need a live-DoltHub test for
     the merge — manual smoke test against a real test repo is
     sufficient.

### Phase 1 acceptance

- Creating a new wasteland end-to-end (UI → `createUpstream`)
  succeeds and produces a populated DoltHub repo with the
  creator's rig row.
- `getWastelandContainerStub` is no longer imported by `trpc/router.ts`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` clean in `services/wasteland`.

---

## Phase 2: Replace remaining container call sites

### `containerStatus` (`trpc/router.ts:833-877`)

Currently fetches `/wl/config` from the container, which returns
`{ joined, upstream, dolthubOrg, hasToken, hasJwk, doltCredPubKey, wlVersion, uptime, lastOperation }`.
The Settings UI uses this for "is the container set up correctly?"
indicators.

In the wasm world there is no container to be "joined" or to have
"uptime". The semantically meaningful fields collapse to:

- `upstream`: from `WastelandDO.getConfig().dolthub_upstream`
- `dolthubOrg`: from the local credential row's `dolthub_org`
- `hasToken`: from the local credential row + a probe of the
  fresh-token endpoint
- everything else: dead

**Tasks:**

1. Replace `containerStatus` with a procedure that returns the
   above derived shape. Mark the legacy fields as deprecated in the
   output schema (return constant values: `joined: true`,
   `wlVersion: 'wasm'`, `uptime: 0`, `lastOperation: null`,
   `hasJwk: false`, `doltCredPubKey: null`) so existing UI keeps
   rendering without changes.
2. Audit `cloud/apps/web/` for the UI that consumes
   `containerStatus`. If any field is shown that no longer makes
   sense (e.g. "container uptime: 47 minutes"), update the UI to
   omit it or replace with a more honest indicator.
3. Optional follow-up: once the UI stops reading the deprecated
   fields, remove them from the procedure's output schema. Don't
   block the container retirement on this.

### `containerHealth` debug route (`wasteland.worker.ts:171-177`)

Used by ops to spot container issues. Goes away with the container.
Replace with a no-op that returns `{ status: 'no container' }` for
one release cycle, then drop entirely.

### `containerConfig` debug route (`wasteland.worker.ts:163-169`)

Same — replace with a 410 Gone or a synthetic
`getConfig()`-derived response.

### `debugCallContainer` (`wasteland.worker.ts:423-458`)

Used by the seven `/debug/wastelands/:id/{unclaim,accept,reject,close,...}`
HTTP debug endpoints. Now that `wantedBoard.*` runs the wasm path,
these routes can call those functions directly instead of proxying
to the container. Mirror what we did in `wasm-browse.handler.ts`'s
POC routes.

**Tasks:**

1. Rewrite each `/debug/wastelands/:id/{op}` route in
   `wasteland.worker.ts` to call the corresponding
   `wantedBoard.*` function. The shape changes are minor — body
   parsing stays the same; only the dispatch changes.
2. Delete `debugCallContainer`.

### POC routes (`/poc/wasm/*`)

The POC routes added during the migration (browse/mutations under
`/poc/wasm/wastelands/:id/...`) duplicate what the existing
`/debug/wastelands/:id/...` routes will do once Phase 2 is done.
Delete them once the debug routes are migrated. They were only
ever useful because the debug routes still went through the
container.

### `WastelandContainerDO.setEnvVar` / `deleteEnvVar`

After Phase 1.5 (storeCredential cleanup), the only remaining
`setEnvVar` callsite is in `updateWastelandConfig`
(`trpc/router.ts:626-632`), which keeps `WL_UPSTREAM` in sync with
the wasteland config. With no container, no env var to sync. Drop
the entire `if (input.dolthubUpstream !== undefined) { ... }`
block.

### Phase 2 acceptance

- Zero remaining `getWastelandContainerStub` imports outside
  `dos/WastelandContainer.do.ts` itself.
- All `/debug/wastelands/:id/*` routes work without a container
  running.
- Settings UI renders the same "is your DoltHub credential
  configured" indicators using `containerStatus` (now synthetic).

---

## Phase 3: Delete the container

After Phases 1-2, the container is functionally dead — the Worker
no longer calls it, no UI relies on it being live. This phase is
the actual deletion plus cleanup.

### Tasks

1. **Drop the wrangler binding.** Remove the
   `WASTELAND_CONTAINER` durable_object binding from
   `wrangler.jsonc` (top level + `env.dev`). Remove the
   `containers` block (top level + `env.dev`).
2. **Add the migration that deletes the DO class.**
   ```jsonc
   {
     "tag": "v3",
     "deleted_classes": ["WastelandContainerDO"],
   }
   ```
   Append to the `migrations` array. **Do not delete the v1 entry**
   that originally created the class — Cloudflare needs the full
   migration history. See
   <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-durable-object-classes>
   for the exact ritual.
3. **Delete source files:**
   - `src/dos/WastelandContainer.do.ts`
   - `src/dos/WastelandContainerDO.stub.ts`
   - The entire `container/` directory (Dockerfile,
     Dockerfile.dev, `control-server/`).
4. **Strip remaining types.** Run `pnpm types` (regenerates
   `worker-configuration.d.ts`). Restore the manual
   `SENTRY_DSN?` / `SENTRY_RELEASE?` lines that wrangler types
   strips on regen — same dance we've done before.
5. **Strip the `WastelandContainerDO` export from
   `wasteland.worker.ts`.**
6. **Update docs.**
   - `services/wasteland/docs/wasm-poc.md`: rename to
     `wasm-architecture.md`, remove "POC" framing, document the
     Worker-only architecture as the steady state.
   - `services/wasteland/MONITORING.md`: drop alerts that
     reference `container.start`, `container.cold_start`, etc.
     Keep DoltHub-API-error alerts, latency alerts, etc.
   - `services/wasteland/AGENTS.md`: no expected changes — it's
     about file-naming conventions, not architecture.
7. **Drop unused dependencies.** Remove `@cloudflare/containers`
   from `package.json`. Check whether anything still imports it
   first; if so, that's a Phase 2 leftover to fix.
8. **Drop env vars that only the container used.**
   `KILO_API_URL` was for the Container's worker→host bridge.
   The Worker uses `KILO_INTERNAL_API_URL` directly. Either:
   - delete `KILO_API_URL` from `wrangler.jsonc`, OR
   - keep it as an alias if any UI or analytics expects it.
     Audit and decide.
9. **Run `pnpm validate`** in the cloud monorepo.

### Phase 3 acceptance

- `wrangler deploy --env dev` succeeds without a Docker daemon
  running.
- `services/wasteland` has no Docker references in its tree.
- `wrangler.jsonc` is shorter; `worker-configuration.d.ts` no
  longer mentions `WastelandContainer`.
- All eight wanted-board ops still work in dev (smoke test:
  browse + post + claim + unclaim).
- `createUpstream` works in dev (smoke test: create a fresh test
  wasteland, see the rig row land on DoltHub).

---

## Risks and mitigations

| Risk                                                                                                              | Mitigation                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DoltHub doesn't expose programmatic database creation.                                                            | Phase 1 task (1) verifies this up-front. If absent, switch to "user creates empty repo first" UX with a clearly-worded prompt in the Settings UI. The rig-registration DML still runs from the Worker.                            |
| `commons.sql` schema drifts between cloud copy and the wasteland repo.                                            | Pin the schema version in a header comment. Add a CI check (or doc note) that flags when `wasteland/schema/commons.sql` changes hash. Manual sync is fine for the cadence we've seen.                                             |
| The DoltHub write API's polling loop behaves differently from `RemoteDB.Exec`'s expectations.                     | Mirror the polling logic verbatim from `wasteland/internal/backend/remote.go:pollOperation`. If anything diverges, pin to that file's commit hash and copy as-is.                                                                 |
| Some UI or external consumer still calls `containerStatus` or `containerJoin` with hard-coded shape expectations. | Phase 2 keeps the procedure shapes intact (synthetic field values) for one release cycle before pruning.                                                                                                                          |
| Migration `v3` (delete-DO-class) needs all live wasteland container DOs to have no in-flight requests.            | Cloudflare handles this gracefully — the DO is deleted next time it would have been reactivated. No data loss because the Container DO didn't store any persistent state we care about (env vars are ephemeral and re-derivable). |
| Rolling back is hard once the migration is shipped.                                                               | Deploy Phase 3 to dev first. Bake for at least 24h. Only then deploy to prod. If we have to roll back, redeploying the old code with a `restored_classes` migration brings the class back.                                        |

## Inventory: all remaining container references at the time of this writing

Use this as a checklist when working through the phases. Last
audited `services/wasteland/src/` only — the container's own code
under `services/wasteland/container/` is implicitly all going away.

```
src/dos/WastelandContainer.do.ts                     ← DO impl, deleted in Phase 3
src/dos/WastelandContainerDO.stub.ts                 ← shim, deleted in Phase 3

src/wasteland.worker.ts:
  L20  import { getWastelandContainerStub }
  L165 /debug/wastelands/:id/container/config         ← Phase 2: rip out or stub
  L173 /debug/wastelands/:id/container/health         ← Phase 2: rip out or stub
  L430 dynamic import inside debugCallContainer       ← Phase 2: delete with debugCallContainer
  L448 container.fetch in debugCallContainer
  L460 /debug/.../unclaim       (uses debugCallContainer)
  L478 /debug/.../accept        (uses debugCallContainer)
  L496 /debug/.../reject        (uses debugCallContainer)
  L508 /debug/.../close         (uses debugCallContainer)
  + the seven /poc/wasm/.../{op} routes                ← Phase 2: delete

src/trpc/router.ts:
  L12  import { getWastelandContainerStub }
  L340 createUpstream                                  ← Phase 1: replace with worker-side
  L627 updateWastelandConfig setEnvVar(WL_UPSTREAM)    ← Phase 2: delete the if block
  L696 storeCredential setEnvVar(DOLTHUB_TOKEN/ORG)    ← Phase 1: delete the if block (lines ~695-734)
  L851 containerStatus                                 ← Phase 2: replace with synthetic
  L912 containerJoin                                   ← Phase 1: delete (orphaned after storeCredential cleanup)
```

The `wasteland-rpc.entrypoint.ts` does not touch the container at
all — it's safe to ignore for this work.

## How to start

1. Read `services/wasteland/docs/wasm-poc.md` end-to-end. The
   credential resolution model (`loadContext`/`loadAdminContext`
   with the OAuth-fresh-token-first pattern) is the same one to
   follow for `createUpstream`.
2. Read `wasteland/internal/backend/remote.go` —
   specifically `Exec`, `execOne`, and `pollOperation`. That's the
   reference implementation for the DoltHub write API's async
   model that Phase 1 needs to mirror.
3. Read `wasteland/internal/federation/federation.go` lines
   353-433 (`Service.Create`) and the `RegisterRig` SQL. That's
   the order of operations we're reproducing worker-side.
4. Branch off `main`. Phase 1, then Phase 2, then Phase 3 — one
   PR per phase. Don't bundle.
5. After each phase, run a manual smoke test against the live dev
   environment (the wasteland service deployed at
   `wasteland.kiloapps.io` for a dev account) before opening a
   PR.

When done, hand off with: PR links, smoke-test results (which
wasteland was created/claimed/etc. as proof), and any deviations
from this plan called out in the PR descriptions.
