# libwl WASM in the wasteland service

All eight wanted-board operations (`browse`, `claim`, `unclaim`,
`done`, `post`, `accept`, `reject`, `close`) now run inside the
Worker via the libwl WASM bundle. They call DoltHub's REST and
GraphQL APIs directly through Go's `net/http` (which on
`GOOS=js GOARCH=wasm` uses `globalThis.fetch`). The Cloudflare
Container is no longer dispatched to from the Worker for any of
these ops.

The container itself still exists (the WastelandContainerDO binding,
the Dockerfile, the Bun control server) because `wl create` —
bootstrapping a brand-new commons — still requires the local `dolt`
CLI. That's the only remaining container-bound call. Once `wl create`
is either rewritten worker-side or moved to a separate single-purpose
container, the WastelandContainerDO can be retired entirely.

## Files

```
src/wasm/
  libwl.wasm           ← Go-compiled wanted-board SDK (~12 MB raw, ~3.2 MB gzipped).
                          Source: wasteland/wlwasm/, built with `make wasm-spike`.
  wasm_exec.js         ← Go's standard syscall/js glue. Sets globalThis.Go.
                          Source: $GOROOT/lib/wasm/wasm_exec.js (Go 1.26.0).
  wasm.d.ts            ← Ambient module declarations for `.wasm` and the IIFE.
  libwl-runner.ts      ← TypeScript runtime: instantiates the Go runtime,
                          captures registered globals, exposes `callLibwl`.
src/wanted-board/
  wanted-board-ops.ts  ← All eight ops dispatch via `callLibwl(...)`.
                          `loadContext` resolves a fresh DoltHub token,
                          rig handle, and DoltHub username (used as the
                          fork-org for libwl writes).
src/util/
  dolthub-token.util.ts
                       ← Calls apps/web's internal token endpoint to get a
                          fresh DoltHub OAuth access token for a given user.
                          Falls back gracefully on transient web failures.
src/handlers/
  wasm-browse.handler.ts
                       ← `/poc/wasm/...` debug helpers for unauth'd
                          local validation of all eight ops. Production
                          tRPC + RPC paths use `wantedBoard.*` directly
                          and pick up the wasm implementation
                          automatically.
```

## How a browse request flows

```
Client
  │  GET /trpc/wasteland.browseWantedBoard?…
  ▼
Worker (Hono + tRPC)
  │
  ▼
wantedBoard.browseWantedBoard(env, wastelandId, userId)
  │
  ├─► loadContext(env, wastelandId, userId)
  │     │
  │     ├─► WastelandDO.getConfig            (KV/SQL via DO stub)
  │     ├─► fetchFreshDoltHubToken(env, …)   (HTTP POST to apps/web)
  │     │       └─► apps/web getValidDoltHubToken
  │     │             └─► refreshDoltHubAccessToken if expires_at < now
  │     └─► WastelandDO.getCredential        (fallback if web is unreachable
  │                                          OR for users using manual API tokens
  │                                          OR in production where OAuth is dev-only)
  │
  └─► callLibwl('wlBrowse', { upstream, dolthub_token, user_id, rig_handle, direct })
        │
        ├─► new Go() + WebAssembly.instantiate(libwl.wasm, importObject)
        ├─► register() runs inside Go's main → globalThis.wlBrowse becomes a JS function
        ├─► JS calls globalThis.wlBrowse(JSON.stringify(input))
        │     │
        │     ▼ Go side, on a fresh goroutine
        │   sdk.Client.Browse(filter)
        │     └─► RemoteDB.Query(...) → fetch("https://www.dolthub.com/api/v1alpha1/...")
        │
        └─► Promise resolves with a JSON envelope { ok, data }
              └─► return parsed.items
```

## Credential model

Two paths feed `loadContext`:

1. **Fresh OAuth token from apps/web** (preferred). Wasteland POSTs to
   `${KILO_INTERNAL_API_URL}/api/internal/integrations/dolthub/token`
   with the user's id and the shared `INTERNAL_API_SECRET`. Apps/web
   runs `getValidDoltHubToken`, which transparently refreshes via
   `refresh_token` if the access token has expired. This is the
   dev-only OAuth path — DoltHub OAuth is an internal Kilo dev
   integration.
2. **Locally encrypted credential** (fallback). The user's DoltHub API
   token (manually pasted into the wasteland Settings dialog) is
   encrypted with `WASTELAND_ENCRYPTION_KEY` and stored in the
   WastelandDO's `wasteland_credentials` table. This is the production
   path — DoltHub's manual API tokens are long-lived and don't need
   refresh. Also serves as a fallback when apps/web is unreachable.

Apps/web's token endpoint is gated by the shared `INTERNAL_API_SECRET`
header (`X-Internal-Secret`), the same convention used elsewhere in
the cloud monorepo (e.g. `/api/internal/triage/post-comment`,
`/api/internal/auto-fix/...`).

In dev, both apps/web and the wasteland service must have the same
`INTERNAL_API_SECRET` value:

- **apps/web** reads it from `cloud/.env.local` (`INTERNAL_API_SECRET=...`).
- **wasteland** reads it from the local Cloudflare Secrets Store under
  `INTERNAL_API_SECRET_PROD` in store `342a86d9e3a94da698e82d0c6e2a36f0`.
  Create it once locally with:
  ```bash
  cd cloud/services/wasteland
  echo "$(grep '^INTERNAL_API_SECRET=' ../../.env.local | cut -d= -f2- | tr -d '\"')" \
    | pnpm exec wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 \
        --name INTERNAL_API_SECRET_PROD --scopes workers
  ```
  In production the binding pulls from the same name in the remote
  store. The remote secret already exists; only the local mirror needs
  bootstrapping per dev environment.

## How the wasm runtime is loaded

1. **Module bundling.** Wrangler bundles `*.wasm` imports as
   `WebAssembly.Module` by default — see
   <https://developers.cloudflare.com/workers/wrangler/bundling/#including-non-javascript-modules>.
   No rule changes needed in `wrangler.jsonc`.
2. **Glue script.** `wasm_exec.js` is a Go-supplied IIFE that sets
   `globalThis.Go`. Importing it for side effect installs the
   constructor.
3. **Per-call instantiation.** For each request we
   `new Go()` and `WebAssembly.instantiate(libwlModule, go.importObject)`.
   We kick off `go.run(instance)` without awaiting it (the wasm's
   `main()` blocks on `select{}`), let the microtask queue drain so
   `register()` runs, then capture the requested global (e.g.
   `globalThis.wlBrowse`) and invoke it.
4. **Promise bridge.** `wasteland/wlwasm/js_bridge.go` registers each
   op as a function that returns a JS Promise. The op spawns a Go
   goroutine to do the work (so the JS event loop is not blocked) and
   resolves the Promise from the goroutine. Returning a sync value
   would deadlock the Go runtime as soon as it tried to call `fetch`
   (per `syscall/js` docs).
5. **Wire format.** Input goes in as a JSON string, output comes back
   as a JSON envelope `{ ok: true, data } | { ok: false, error }`.

## Concurrency caveat

The Go runtime registers its bridge functions on `globalThis`. Two
concurrent calls on the same isolate would race. The runner
(`libwl-runner.ts`) serializes through `runQueue` for now. Production
options:

- **Option A (preferred):** change `wasteland/wlwasm/js_bridge.go` to
  attach the functions to a per-instance object (`go.exports.wlBrowse`)
  instead of `globalThis`, so each instance has its own namespace.
- **Option B:** keep one long-lived Go runtime instance per isolate
  with an internal queue. Cheaper per-request because we avoid
  re-instantiation, but adds memory pressure and an external work-queue
  protocol.

Either is fine; not blocking for the swap because production traffic
on a single isolate per-wasteland is naturally serialized via the
WastelandDO already.

## Bundle size

| Metric                  |      Bytes | Workers limit              |
| ----------------------- | ---------: | -------------------------- |
| libwl.wasm raw          | 12,505,176 | n/a                        |
| libwl.wasm gzipped (-9) |  3,217,896 | 10 MB paid plan compressed |
| wasm_exec.js            |     16,992 | n/a                        |

Compressed, we're at ~32% of the paid-plan limit. Comfortable headroom
for adding the seven mutations and the existing TypeScript/Sentry/Hono
surface.

## Updating `libwl.wasm`

Until we set up a CI pipeline, the artifact is updated by hand:

```bash
cd /path/to/wasteland   # the standalone wasteland repo
make wasm-spike         # builds bin/libwl.wasm
cp bin/libwl.wasm /path/to/cloud/services/wasteland/src/wasm/libwl.wasm
```

If the Go version on the build machine changes, also refresh
`wasm_exec.js` (Go ships it at `$GOROOT/lib/wasm/wasm_exec.js`).

## Local verification

The `/poc/wasm/...` routes give an unauthenticated path for local
testing (the production tRPC path requires a Kilo JWT):

```bash
# Find a userId with a stored DoltHub credential.
curl -sS "http://localhost:8787/poc/wasm/wastelands/<wastelandId>/members"

# Browse.
curl -sS "http://localhost:8787/poc/wasm/wastelands/<wastelandId>/browse?userId=<uid>"

# Mutations (all POST + JSON body).
curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/post" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","title":"…","description":"…","priority":"low","type":"other"}'

curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/claim" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","itemId":"w-…"}'

curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/unclaim" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","itemId":"w-…"}'

curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/done" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","itemId":"w-…","evidence":"https://…"}'

curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/accept" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","itemId":"w-…","quality":"good"}'

curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/reject" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","itemId":"w-…","reason":"…"}'

curl -sS "http://localhost:8787/poc/wasm/wastelands/<wid>/close" \
  -X POST -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","itemId":"w-…"}'
```

These `/poc/wasm/*` routes are temporary; remove them once the wasm
path has been observed in production for the rollout window.

### Workflow notes

- **`accept` requires the upstream main to have a completion record.**
  In PR mode, `done` writes a completion to a branch but the row is
  only visible on `main` after the PR is merged. If you `accept`
  without merging the prior `done` PR, libwl returns
  "no completion found for wanted item" — that's a workflow constraint
  of the federation protocol, not a wasm bug. Use `reject` or `close`
  to bail out of an in-review state when you don't have merge access.
- **`pr_url` may be empty even on success.** When libwl returns an
  idempotent no-op (e.g. claiming an item that's already claimed on
  the user's branch), there's no new PR to surface. The schema
  coalesces empty string to `null` for the consumer.

## What's next

- Rip out the WastelandContainerDO once `wl create` (the only
  remaining container-bound call) is migrated. Either rewrite it
  worker-side using DoltHub's write API + GraphQL, or keep a tiny
  single-purpose container for that one operation. The container's
  `/wl/browse` and the seven `/wl/*` mutation endpoints are now dead
  code from the Worker's perspective.
- Decide on the per-request wasm instantiation cost vs. a long-lived
  isolate-wide instance. The current cold-start hit is ~100-200 ms;
  warm calls are dominated by DoltHub round trip (mutations land
  around 2-5 s because they do a write + a PR creation; browse is
  around 200-500 ms).
- Tighten the libwl response schemas. They're currently loose
  (`passthrough()`) and tolerant of either Go-default capitalized
  field names (`Items`, `Detail.PRURL`) or lowercase. The proper fix
  is upstream: add `json:"…"` tags to `sdk.BrowseResult`,
  `sdk.MutationResult`, and `sdk.DetailResult` in the wasteland repo.
- Convert workarounds to upstream fixes:
  - `priority: -1` for browse — the wasm should treat missing as the
    "unset" sentinel rather than the TS caller having to know.
  - PR mode default `view: 'all'` for browse — should match the
    container's previous "show everything" behavior or have a clearly
    documented per-call override.
  - Quality int mapping — duplicated in wasteland-ops (`QUALITY_TO_INT`)
    and the container's control server. The wasm could accept the
    string enum directly to avoid drift.

## Open questions

- **Memory.** Each `new Go()` allocates a ~16 MB linear memory by
  default. With per-request instantiation we burn that for the call
  duration only; with a long-lived instance the isolate keeps it
  resident. Need to measure real usage under load.
- **Error mapping.** `browseWantedBoard` translates libwl errors to
  `WantedBoardOpError('UPSTREAM_ERROR')`. The wasm path surfaces more
  detail than the container did (e.g. "OAuth access token not found"
  came through cleanly during dev). We should preserve that
  distinction when migrating mutations.
- **Observability.** No Analytics Engine event yet that distinguishes
  wasm vs container. Add one once the swap is in production so
  Grafana can compare durations side by side.
