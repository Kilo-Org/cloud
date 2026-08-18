# Session-ingest token revocation — implementation plan

**Checkout**: this worktree. The deletion-queue / `session-ingest:user-deletion` audience described in `SESSION-INGEST-TOKEN-REVOCATION-HANDOFF.md` does not exist here. Do not build it.

**Goal**: after block or GDPR soft-delete, a stolen ordinary Kilo JWT must not recreate or keep mutating CLI v2 data beyond a documented bounded window, without a PostgreSQL lookup on every session-ingest request.

## Locked decisions

1. Keep revocation in `kiloJwtAuthMiddleware`. Do not add a per-request Postgres lookup.
2. Do not change JWT shape. No `aud` migration. No dual-accept of token formats.
3. Classify tokens by whether `apiTokenPepper` is present on the verified payload:
   - field **absent** (`undefined`) → internal service token
   - field **present** (string or `null`) → ordinary user token
   - never coalesce with `??`. `undefined` and `null` are different.
4. Cache `{ pepper, blockedReason }` under a versioned KV key. Ignore legacy `user-exists:` values.
5. GDPR delete stays on the existing pepper-less `generateInternalServiceToken` + `DELETE /api/session/:id` path.
6. `POST /api/session` additionally refuses blocked users. This is required because internal tokens remain valid after block (GDPR delete needs that).
7. Best-effort KV invalidation from web on block / soft-delete. Correctness must not depend on it.
8. No per-user auth DO, no short-lived token exchange, no deletion-queue wait/rescan.

## Current hole (this checkout)

`services/session-ingest/src/middleware/kilo-jwt-auth.ts` verifies the JWT, then caches only `user-exists:<id>` (`"1"` for 24h). Soft-delete keeps the `kilocode_users` row, so an old CLI JWT stays valid until its own expiry and can `POST /api/session`.

GDPR today:

1. `softDeleteUser` sets `blocked_reason` and rotates `api_token_pepper`.
2. `deleteCliSessionV2Blobs` mints `generateInternalServiceToken(userId)` (no pepper) and `DELETE`s each session.

That delete only works because middleware ignores pepper and blocked state. Closing the hole must not break that.

## Token classes

After `verifyKiloToken(token, secret)` (no audience option):

| Payload | Class | Accept when |
|---|---|---|
| `apiTokenPepper` is `undefined` | Internal | user row exists |
| `apiTokenPepper` is `string` or `null` | User | user exists, `blockedReason === null`, cached pepper **===** claim (strict, including `null === null`) |
| `aud` present | Rejected already by `verifyKiloToken` | n/a |

Why this needs no transition window:

- `generateApiToken` / `generateOrganizationApiToken` always set `apiTokenPepper`.
- `generateInternalServiceToken` never sets it.
- In-flight 1h internal tokens and 5-year CLI tokens keep working on deploy.
- Do not add `audience` to internal tokens in this change. `verifyKiloToken` without `{ audience }` rejects any `aud`, so minting audience first would break every web call.

Internal tokens ignore pepper and blocked reason. That is an explicit contract, not a missing-field bypass: the field is omitted on purpose by `generateInternalServiceToken`.

### Residual

`activeSessions.getToken` returns a pepper-less 1h token to clients (mobile WS). After block, an already-issued `getToken` still authenticates until expiry. It cannot mint a new one if web auth checks pepper.

Mitigation in this change: `POST /api/session` rejects blocked users, so that token cannot recreate sessions. It can still ingest into sessions not yet deleted, until GDPR `deleteCliSessionV2Blobs` finishes or the 1h token expires.

Do not change `getToken` shape in this PR.

## KV cache

Reuse the existing `USER_EXISTS_CACHE` binding. Do not rename the namespace.

```ts
const USER_AUTH_CACHE_KEY_PREFIX = 'user-auth:v1:';
const USER_AUTH_TTL_SECONDS = 60;
const USER_MISSING_TTL_SECONDS = 5 * 60;

type CachedUserAuthV1 =
  | { v: 1; exists: false }
  | { v: 1; exists: true; pepper: string | null; blockedReason: string | null };
```

Key: `user-auth:v1:<userId>`.

Rules:

- Parse with Zod. Legacy `"1"` / `"0"` / unknown JSON → treat as miss, then read Postgres. Never treat them as authorized.
- Cache miss or malformed: `findKiloUserPepper` (already in `packages/worker-utils/src/kilo-token-auth.ts`). Missing row → cache `{ v: 1, exists: false }` for 5 minutes. Present row → cache `{ v: 1, exists: true, pepper, blockedReason }` for 60 seconds.
- **Await** `KV.put`. Do not `void` it.
- Postgres / Hyperdrive error → **503**, fail closed. Do not authorize.
- Do not log tokens, peppers, or Authorization headers.

Load model: one Postgres read per distinct active user per 60s, not 135 qps. First request after deploy is a miss (new key). Old `user-exists:` entries expire unused.

Documented revocation window for user tokens: **60s TTL + KV eventual consistency** (treat as ~2 minutes, not 60s). Do not claim immediate global revocation.

## Middleware algorithm

File: `services/session-ingest/src/middleware/kilo-jwt-auth.ts`

1. Extract bearer, or WS `?token=` when `Upgrade: websocket`.
2. `verifyKiloToken(token, secret)` — no audience. Invalid/expired/`aud` → 401.
3. Load cached auth state as above.
4. If `!exists` → 403 `User account not found`.
5. If `payload.apiTokenPepper === undefined` → `c.set('user_id', kiloUserId)` and `next()` (internal).
6. Else if `state.blockedReason !== null` or `state.pepper !== payload.apiTokenPepper` → 403 (same generic error for both; do not leak which).
7. Else authorize.

Keep applying this middleware to `/api/*` and `/internal/cloud-agent/v1/*`. Cloud-agent routes still also require `X-Internal-Secret`.

## Create-path block

File: `services/session-ingest/src/routes/api.ts` — `POST /session`

Before insert, read `blocked_reason` for `kiloUserId`. If the user is missing or `blocked_reason !== null`, return 403 and do not insert.

This is a low-volume extra query on session create only. It is required: internal tokens are accepted after block, and without this check `getToken` / any pepper-less JWT could recreate `cli_sessions_v2` rows.

Do not add blocked checks to ingest/export/delete/share. Ingest into a missing session already 404s. Ingest into a cleared `SessionIngestDO` already returns `reason: 'deleted'` and drops R2 blobs. GDPR delete uses `DELETE` with an internal token and must keep working.

## Best-effort invalidation

Add `POST /internal/user-auth/invalidate` next to the existing session-access invalidate route in `app.ts`.

- Auth: `X-Internal-Secret` via existing `hasValidInternalSecret`.
- Body: `{ kiloUserId: string }`.
- Action: `USER_EXISTS_CACHE.delete('user-auth:v1:' + kiloUserId)`.
- Response: 204.
- Correctness does not depend on this. A lost race can leave a stale unblocked snapshot until TTL.

Web helper in `apps/web/src/lib/session-ingest-client.ts`, same pattern as `invalidateOrganizationSessionAccess` (secret header, 30s timeout). Fire-and-forget from:

- `blockUser` in `apps/web/src/lib/user/block.ts` — after the transaction commits, not inside it. Catch + log / Sentry. Do not fail the block.
- `softDeleteUser` in `apps/web/src/lib/user/index.ts` — after the anonymize transaction. Soft-delete does **not** call `blockUser`, so both sites are required.

Skip the call when `SESSION_INGEST_WORKER_URL` or `INTERNAL_API_SECRET` is unset (local / tests).

## Out of scope

- `generateInternalServiceToken` audience
- Changing `getToken` to include pepper
- Deletion-queue files / leaf-only delete / `session-ingest:user-deletion`
- Renaming the KV binding
- Schema migrations
- Per-request Postgres in middleware
- Sleeping or rescheduling GDPR for a cache window

## Tests

### `kilo-jwt-auth.test.ts`

Mock KV + `findKiloUserPepper` / `getWorkerDb`. Cover:

- user token, matching pepper, unblocked → 200
- user token, stale pepper → 403
- user token, matching pepper, blocked → 403
- user token, `apiTokenPepper: null`, cached pepper `null`, unblocked → 200
- user token, `apiTokenPepper: null`, cached pepper string → 403
- missing user → 403
- malformed KV JSON → miss, then Postgres; do not authorize from the blob
- legacy `"1"` / `"0"` → miss, then Postgres
- cache hit → no Postgres
- cache miss → Postgres + `put` of `user-auth:v1:` with TTL 60 (or 300 if missing)
- await `put` (assert `put` was called before the 200)
- Postgres throw → 503, not 200
- internal token (`version` + `kiloUserId` only) + unblocked user → 200
- internal token + blocked user → 200 (GDPR delete)
- internal token + missing user → 403
- token with `aud` → 401
- missing Authorization → 401

### `api.test.ts`

- `POST /session` when `blocked_reason` is set → 403, no insert
- `POST /session` when user missing → 403, no insert
- existing create tests still pass for an unblocked user

### Web

- `session-ingest-client` invalidate helper: secret header, 204, error path
- `blockUser` / `softDeleteUser`: invalidate called after success; block/delete still succeeds if invalidate throws

Do not add deletion-queue wait/rescan tests. They belong to a queue that is not in this tree.

## Verification

```sh
pnpm --filter cloudflare-session-ingest test -- src/middleware/kilo-jwt-auth.test.ts src/routes/api.test.ts
pnpm --filter cloudflare-session-ingest typecheck
pnpm --filter cloudflare-session-ingest lint
```

Plus the focused web tests for the invalidate helper and the `blockUser` / `softDeleteUser` call sites. Format task-owned files. `git diff --check`.

Do not commit, push, or comment on a PR unless asked.

## Implementation order

1. Middleware + cache types + auth tests (closes the CLI JWT hole).
2. `POST /session` blocked check + api tests (closes internal-token recreate).
3. Internal invalidate route.
4. Web helper + `blockUser` / `softDeleteUser` best-effort calls + tests.
5. Typecheck / lint / format of owned files.

## Acceptance

- Ordinary user JWT with rotated pepper or non-null `blocked_reason` is rejected after at most the documented KV window.
- No Postgres read on a warm cache hit.
- Pepper-less internal token still deletes sessions after soft-delete.
- Pepper-less internal token cannot create a new session for a blocked user.
- Legacy `"1"` does not authorize.
- Internal missing-pepper behavior is tested as a named class, not accidental.
- `SessionIngestDO.clear()` tombstone behavior is unchanged.
