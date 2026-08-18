# Session-ingest token revocation handoff

## Objective

Fix a GDPR deletion release blocker in `services/session-ingest`: ordinary Kilo JWTs remain usable after a user is blocked and their API token pepper is rotated. The fix must prevent a deleted user from recreating CLI v2 data without adding a PostgreSQL lookup to every session-ingest request.

Do not weaken the separate deletion-token flow. A purpose-bound deletion token must continue to work for the exact leaf-session delete operation after the user has been blocked, and nowhere else.

## Confirmed production constraint

Cloudflare currently reports approximately **135.1 requests/second** for the `session-ingest` Worker.

An authoritative PostgreSQL lookup in global authentication middleware would therefore add roughly:

- 135 database queries per second;
- 11.7 million database queries per day.

That approach is not acceptable, even through Hyperdrive. The high-volume ingest path must not query PostgreSQL once per request merely to validate account revocation state.

## Current behavior

The relevant middleware is:

- `services/session-ingest/src/middleware/kilo-jwt-auth.ts`

For each request it currently:

1. Extracts the bearer token, or the WebSocket query token.
2. Verifies the JWT signature, expiry, schema, and audience.
3. Extracts `kiloUserId`.
4. Looks up `user-exists:<userId>` in `USER_EXISTS_CACHE` KV.
5. Accepts cached `"1"`; rejects cached `"0"`.
6. On a cache miss, queries `kilocode_users` only for the user ID.
7. Caches existence for 24 hours, or absence for five minutes.

This verifies only that the retained user row exists. It does not inspect:

- `kilocode_users.api_token_pepper`;
- `kilocode_users.blocked_reason`;
- the JWT's `apiTokenPepper` claim.

The deletion flow intentionally retains and anonymizes the `kilocode_users` row. At deletion intake it blocks the user and rotates `api_token_pepper` in:

- `apps/web/src/lib/user/deletion-queue/deletion-access.ts`

Final anonymization rotates the pepper again and preserves a soft-deleted blocked reason in:

- `apps/web/src/lib/user/index.ts`

Because the row still exists, an old ordinary JWT continues to pass session-ingest authentication. Even after the 24-hour KV entry expires, the database existence check returns true and another positive entry is cached. The JWT can remain usable until its own expiry and can create new CLI v2 session data.

## Existing deletion-token exception

The durable deletion queue mints a five-minute token with audience:

```text
session-ingest:user-deletion
```

See:

- `apps/web/src/lib/user/deletion-queue/handlers/cli-v2.ts`
- `apps/web/src/lib/user/deletion-queue/deletion-constants.ts`
- `packages/worker-utils/src/internal-service-token-audiences.ts`

The middleware accepts that audience only for:

```text
DELETE /api/session/:sessionId
```

The route then uses the signed `kiloUserId` and calls the dedicated leaf-only deletion path in:

- `services/session-ingest/src/routes/api.ts`

That path:

- selects by both session ID and user ID;
- refuses deletion when the selected session still has a child;
- deletes only the selected leaf;
- clears the per-user access-cache entry;
- clears the session's Durable Object and R2-backed state;
- converges when the PostgreSQL row is already missing.

The deletion audience must continue to bypass the user's blocked/pepper state because blocking and pepper rotation happen before session deletion. Its authorization must remain limited to the exact route and method above.

## Important token compatibility issue

Ordinary user API tokens contain `apiTokenPepper`, but several web-to-session-ingest calls use `generateInternalServiceToken(userId)`, which intentionally contains only `kiloUserId` and token version.

See:

- `apps/web/src/lib/tokens.ts`
- `apps/web/src/lib/session-ingest-client.ts`
- `apps/web/src/lib/cloud-agent/session-events.ts`
- `apps/web/src/routers/active-sessions-router.ts`
- `apps/web/src/routers/cli-sessions-v2-router.ts`
- `services/security-auto-analysis/src/token.ts`

Therefore, simply requiring `payload.apiTokenPepper` on every non-deletion JWT would break legitimate current service calls. Do not silently treat a missing pepper as trusted either: that would create an ambiguous bypass unless this token class receives its own explicit, purpose-bound trust contract.

Inventory all session-ingest token issuers and classify them before changing acceptance rules.

## Approaches discussed

### 1. PostgreSQL lookup in global middleware — rejected

For every ordinary request, fetch current pepper and blocked state and compare them with the JWT.

This is straightforward and authoritative, and resembles `verifyKiloBearerAgainstCurrentPepper` in `packages/worker-utils/src/kilo-token-auth.ts`. However, at 135.1 requests/second it would impose an unreasonable database load. Do not implement this approach.

### 2. Validate only selected mutation routes — considered hacky

We considered putting an authoritative check only at session creation or WebSocket connection admission. Session creation already writes PostgreSQL, so its insert could theoretically be conditioned on the current user pepper and block state without adding a separate round trip.

This reduces load, but it distributes authentication/revocation policy into business routes and requires careful reasoning about every path that can create or mutate retained data. The user correctly considered this hacky and weird. Do not adopt it without a strong architectural justification.

### 3. Cache full authorization state in KV — current pragmatic candidate

Replace the existence-only cache value with an authorization snapshot containing at least:

```ts
type CachedUserAuthState = {
  pepper: string | null;
  blockedReason: string | null;
};
```

For an ordinary token:

1. Verify JWT signature and reject unexpected audiences locally.
2. Read `user-auth:<userId>` from KV.
3. On a cache miss, query PostgreSQL once for `api_token_pepper` and `blocked_reason` and cache the result for a short TTL, tentatively 60 seconds.
4. Accept only when `blockedReason === null` and the cached current pepper equals `payload.apiTokenPepper ?? null`.

For a deletion-audience token:

1. Verify the exact deletion audience.
2. Reject it unless the method and path are the exact leaf delete operation.
3. Permit the leaf deletion despite the blocked reason and pepper mismatch.

This changes the database load from one query per request to approximately one query per active user per cache TTL. It introduces a documented bounded revocation delay.

Cloudflare KV is eventually consistent, so an explicit overwrite/delete during blocking is useful for reducing the common-case delay but cannot by itself prove immediate global revocation. The design must not claim zero-delay revocation if it relies on KV.

### 4. Strongly consistent per-user Durable Object authorization cache — clean but larger

A per-user Durable Object could own the current auth epoch/state. Ordinary requests would consult it instead of PostgreSQL, and the deletion intake path would explicitly revoke the user.

This provides a coherent, strongly consistent revocation boundary, but it adds a Worker-to-DO RPC on the hot path and materially more lifecycle, deployment, failure, and invalidation machinery. Measure the latency/cost and justify the complexity before choosing it.

### 5. Short-lived purpose-bound session-ingest tokens — worth evaluating

A cleaner longer-term boundary may be for clients to exchange their general Kilo token for a short-lived token specifically accepted by session-ingest. The web/auth service validates current user state when minting it; session-ingest then validates it locally until a short expiry.

This bounds revocation delay without per-request database reads, but it changes client refresh flows, WebSocket reconnect behavior, and all current session-ingest issuers. It may be the best architectural answer, but it is broader than a minimal queue fix.

## Suggested direction to evaluate first

Start with the KV authorization-state design, but treat the following as explicit requirements rather than implementation details:

1. Choose and document the maximum revocation window.
2. Cache the current pepper and blocked state, not merely existence.
3. Ensure cache keys/serialization are versioned so old `"1"` entries cannot be interpreted as authorized under the new scheme.
4. Fail closed on malformed cache values and database errors.
5. Do not place raw JWTs or other credentials in KV, logs, tests, or error output.
6. Decide how purpose-free internal service tokens are migrated or replaced; do not preserve an undocumented missing-pepper bypass.
7. Keep deletion-audience authorization separate and exact.
8. Make the deletion queue wait until the maximum old authorization-cache window has passed before considering CLI v2 deletion complete, then rescan and delete any rows created during the window.
9. Avoid sleeping inside a Vercel invocation. Persist/reschedule the step until its not-before time.
10. Account for the existing `SessionIngestDO` deletion tombstone: after `clear()`, late ingest for that exact user/session DO is rejected and uploaded R2 blobs are cleaned. Verify this remains true through deployment-version skew.

The wait/rescan barrier is needed because a stale authorization snapshot can permit writes briefly after blocking. Completion must mean the stale-token window has closed and no user-owned CLI v2 rows remain.

## Questions the implementation owner must resolve

1. What revocation delay is acceptable: 30 seconds, 60 seconds, or another value?
2. Can the Cloud deletion path call a session-ingest internal invalidation endpoint as a best-effort accelerator without making correctness depend on it?
3. Should ordinary web-to-session-ingest internal calls carry the user's pepper, or should they use a separate explicit service audience plus an internal secret/service binding?
4. Which client paths call session-ingest directly with a long-lived general API token, including CLI and WebSocket connections?
5. Does Cloudflare KV propagation add delay beyond the chosen TTL in the deployed topology, and how should that affect the completion barrier?
6. Is a session-ingest-specific short-lived token worth doing now instead of adding authorization state to KV?
7. Does the queue already persist enough timing state (`blocked_at`, step timing/progress) to express the barrier without a schema change?

## Files to inspect

At minimum:

- `services/session-ingest/src/middleware/kilo-jwt-auth.ts`
- `services/session-ingest/src/middleware/kilo-jwt-auth.test.ts`
- `services/session-ingest/src/app.ts`
- `services/session-ingest/src/routes/api.ts`
- `services/session-ingest/src/routes/api.test.ts`
- `services/session-ingest/src/dos/SessionIngestDO.ts`
- `services/session-ingest/src/dos/SessionAccessCacheDO.ts`
- `services/session-ingest/wrangler.jsonc`
- `packages/worker-utils/src/kilo-token.ts`
- `packages/worker-utils/src/kilo-token-auth.ts`
- `packages/worker-utils/src/internal-service-token-audiences.ts`
- `apps/web/src/lib/tokens.ts`
- `apps/web/src/lib/session-ingest-client.ts`
- `apps/web/src/lib/user/deletion-queue/deletion-access.ts`
- `apps/web/src/lib/user/deletion-queue/handlers/cli-v2.ts`
- `apps/web/src/lib/user/index.ts`
- `packages/db/src/schema.ts`
- `packages/db/AGENTS.md`

Also inventory all call sites of `generateInternalServiceToken()` that target session-ingest.

## Required tests

Authentication tests should cover:

- ordinary token with matching pepper and unblocked user succeeds;
- stale pepper fails;
- matching pepper with non-null `blocked_reason` fails;
- missing user fails;
- malformed or unknown cached state fails closed;
- legacy existence-cache values do not authorize requests;
- cache miss reads PostgreSQL and writes the expected bounded state;
- cache hit avoids PostgreSQL;
- deletion token succeeds for exact `DELETE /api/session/:sessionId` after blocking;
- deletion token fails for GET/POST/PATCH/PUT on that path;
- deletion token fails for all other `/api` and internal routes;
- a token with another audience is rejected;
- the chosen handling of missing-pepper internal tokens is explicit and tested.

Deletion convergence tests should cover:

- blocking rotates pepper and records the barrier start;
- CLI v2 deletion does not terminally succeed before the revocation window closes;
- work is rescheduled rather than sleeping;
- after the barrier, sessions created during the stale window are found and deleted;
- a final rescan proves absence before success;
- late ingest cannot repopulate a cleared SessionIngestDO;
- deletion remains idempotent when PostgreSQL, cache, or DO state is already missing.

## Verification

Follow the target checkout's `AGENTS.md`, `services/AGENTS.md`, `packages/db/AGENTS.md`, and applicable repository skills before editing.

Run the narrowest relevant checks, likely including:

```sh
pnpm --filter cloudflare-session-ingest test -- src/middleware/kilo-jwt-auth.test.ts src/routes/api.test.ts
pnpm --filter cloudflare-session-ingest typecheck
pnpm --filter cloudflare-session-ingest lint
```

Run the focused web deletion-queue tests covering `handlers/cli-v2.ts` and any timing/barrier changes. Use repository-local binaries if pnpm wrappers hang. Finish with formatting of task-owned files and `git diff --check`.

Do not commit, push, or comment on a PR unless explicitly requested.

## Acceptance criteria

The task is complete when:

- an old ordinary token cannot recreate or mutate CLI v2 data after the documented bounded revocation window;
- no design adds a PostgreSQL query per session-ingest request;
- the database/cache load model is stated and defensible at 135.1 requests/second;
- internal service-token behavior is explicit rather than an accidental missing-pepper bypass;
- the deletion audience remains usable only for exact leaf deletion;
- deletion waits/rescans as needed and does not claim completion while stale authorization can recreate data;
- focused authentication and deletion-convergence tests pass;
- no unrelated worktree changes are overwritten.
