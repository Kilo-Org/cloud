# Session-ingest token revocation — review remediation and staged rollout plan

## Status and scope

This plan supersedes the implementation sequencing in
`SESSION-INGEST-TOKEN-REVOCATION-PLAN.md` where the verified review findings below
require changes. It does not supersede the original token-class and KV-state
decisions unless this document says so explicitly.

The work is split into two independently deployable pull requests:

1. **PR 1: session-ingest compatibility and enforcement**, implemented from the
   clean, current-main worktree:
   `/Users/evgeny/.argus/worktrees/E334DA0A-0BCF-4F1C-9457-B7FD59473A30/eshurakov-mighty-hazel`
2. **PR 2: web token issuance and invalidation**, created from `main` only after
   PR 1 is merged and deployed successfully.

The current `eshurakov-serene-cedar` worktree contains an older, uncommitted
combined implementation. Treat it as reference material. Do not cherry-pick or
copy that diff wholesale: it contains the review defects this plan addresses and
is based 46 commits behind the current `main` snapshot used by `mighty-hazel`.

No client release, database migration, KV namespace migration, or coordinated
flag day is required.

## Goal

After a user is blocked or GDPR-soft-deleted:

- ordinary pepper-bearing Kilo JWTs stop authorizing new HTTP requests to
  session-ingest after the documented KV convergence window;
- no production `cli_sessions_v2` insert path can create a row for a blocked or
  missing user;
- the session-ingest deployment remains compatible with both the currently
  issued pepper-less one-hour viewer tokens and the pepper-bearing viewer tokens
  introduced by PR 2;
- internal pepper-less service tokens retain their existing behavior in this
  rollout;
- blocking and deletion remain successful if best-effort cache invalidation
  fails;
- invalidation is never started inside an uncommitted caller-owned transaction;
  and
- normal web, mobile, extension, CLI, Cloud Agent, and internal-service traffic
  continues across a rolling deployment.

## Explicitly accepted residuals

This is the low-disruption path. The following limitations are intentional and
must remain visible in the PR descriptions and release notes:

1. `activeSessions.getToken` tokens issued before PR 2 remain pepper-less and
   continue to use the internal-token compatibility path until they expire, for
   at most one hour after issuance.
2. Authentication for `/api/user/web` and `/api/user/cli` occurs during the
   WebSocket handshake. Rotating a pepper does not re-authenticate or close an
   already-open socket. An open viewer socket may therefore outlive its JWT and
   continue to relay commands until it disconnects.
3. This rollout does not add command-time authorization checks, forced socket
   closure, periodic reauthentication, a per-user authorization Durable Object,
   or a purpose-bound internal-token migration.
4. Bulk blocking and the blacklisted-domain backfill rely on the authoritative
   60-second auth-cache TTL plus KV propagation. They do not fan out thousands of
   best-effort HTTP invalidation requests.
5. A PostgreSQL/Hyperdrive outage that lasts beyond a warm entry's 60-second TTL
   causes affected authenticated session-ingest requests to fail closed with
   503. This is the chosen security/availability trade-off.

Consequently, the bounded-revocation claim in this change applies to new HTTP
admissions and database creation paths. It must not be described as immediate
revocation of already-open WebSockets.

## Verified review findings and disposition

| Finding | Disposition | Planned treatment |
|---|---|---|
| 1. KV `put` failure causes a spurious 503 | Fix in PR 1 | Await the write but isolate its failure from the authoritative DB result. |
| 2. Invalidation runs inside a caller transaction | Fix in PR 2 | Use post-response scheduling for caller-owned transactions and direct post-commit best-effort work for self-owned transactions. |
| 3. Bulk block paths do not invalidate | Explicit bounded-risk decision | Rely on TTL for bulk paths; document why per-user fan-out is not added. |
| 4. Two other session insert paths are unguarded | Fix in PR 1 | Add one transaction-aware user-admission helper and use it at all three inserts. |
| 5. Vercel fire-and-forget invalidation can be dropped | Fix in PR 2 | Await or register work with Next `after()`; never leave an untracked promise. |
| 6. The 60-second TTL changes outage behavior | Explicit operational sign-off | Preserve fail-closed behavior, document it, and add deployment monitoring gates. |
| 7. `getToken` exposes a pepper-less client token | Low-disruption fix in PR 2 | Issue a pepper-bearing token with the same one-hour lifetime; accept old tokens and open-socket residuals. |
| 8. Invalidation client duplication | No change | Keep the two explicit helpers because their missing-configuration contracts intentionally differ. |
| 9. Missing-pepper semantics differ across services | Clarify in PR 1 | Add comments at both trust boundaries; do not introduce a premature shared classifier. |
| 10. Internal-secret check is repeated | Fix in PR 1 | Apply the existing middleware to all affected internal routes. |
| 11. Null/undefined style | No change | No correctness or maintenance value. |

## Compatibility model

### Token classes during the rollout

| Token | Before PR 1 | After PR 1 | After PR 2 |
|---|---|---|---|
| Ordinary API token with `apiTokenPepper` | Signature + retained-row existence | Pepper and blocked-state checked through KV | Same |
| Existing `getToken` token without pepper | Accepted | Accepted as the named internal compatibility class | Accepted until its one-hour expiry |
| New `getToken` token | Pepper-less | Pepper-less until PR 2 | Pepper-bearing, one-hour expiry |
| Server-generated internal token without pepper | Accepted | Accepted while the user row exists, regardless of block state | Unchanged |
| Token with an unexpected `aud` | Rejected | Rejected | Rejected |

### Why session-ingest must deploy first

PR 1 establishes the verifier that understands the new pepper-bearing viewer
token before PR 2 starts minting it. The old session-ingest middleware would also
accept the new token because it ignores the pepper, so the rollout is technically
bidirectionally compatible. Deploying session-ingest first is still preferable:

- it makes the intended dependency explicit;
- it closes the unguarded Cloud Agent insert path first;
- it allows production observation of the KV/Hyperdrive behavior before token
  issuance changes;
- it ensures the invalidation endpoint exists before web starts calling it; and
- it gives PR 2 a simple rollback path without rolling back the security
  enforcement in PR 1.

## PR 1 — session-ingest compatibility and enforcement

### Worktree and branch preparation

Use `eshurakov-mighty-hazel`. Before editing:

1. Confirm `git status --short` is empty.
2. Confirm the branch is based on the intended current `main`.
3. Read the root, `services/AGENTS.md`, and `packages/db/AGENTS.md` instructions.
4. Read the root and `services/session-ingest/package.json` scripts before
   running package commands.
5. Re-inspect every target file on this branch; do not assume the older
   `serene-cedar` line numbers still match.

### PR 1 file scope

Expected production files:

- `services/session-ingest/src/middleware/kilo-jwt-auth.ts`
- `services/session-ingest/src/services/user-session-admission.ts` — new shared
  admission helper; use a similarly focused existing services directory if the
  current branch has a more appropriate established location
- `services/session-ingest/src/routes/api.ts`
- `services/session-ingest/src/routes/cloud-agent-session-scope.ts`
- `services/session-ingest/src/session-ingest-rpc.ts`
- `services/session-ingest/src/app.ts`
- `packages/worker-utils/src/kilo-token-auth.ts` — comment-only clarification

Expected tests:

- `services/session-ingest/src/middleware/kilo-jwt-auth.test.ts`
- `services/session-ingest/src/routes/api.test.ts`
- `services/session-ingest/src/routes/cloud-agent-session-scope.test.ts`
- `services/session-ingest/src/session-ingest-rpc.test.ts`
- `services/session-ingest/src/index.test.ts` or the existing app-route test that
  owns internal endpoint authentication
- `packages/worker-utils/src/kilo-token-auth.test.ts` only if a behavior assertion
  is needed to protect the documented legacy null-pepper semantics

Do not change `apps/web/**` in PR 1.

### 1. Replace the existence-only KV value with versioned auth state

In `kilo-jwt-auth.ts`:

```ts
const USER_AUTH_CACHE_KEY_PREFIX = 'user-auth:v1:';
const USER_AUTH_TTL_SECONDS = 60;
const USER_MISSING_TTL_SECONDS = 5 * 60;

type CachedUserAuthV1 =
  | { v: 1; exists: false }
  | { v: 1; exists: true; pepper: string | null; blockedReason: string | null };
```

Required behavior:

1. Read only `user-auth:v1:<kiloUserId>`.
2. Parse with a strict Zod schema.
3. Treat legacy `user-exists:` keys, literal `"1"`/`"0"`, malformed JSON,
   unknown versions, and wrong field types as cache misses. None may authorize.
4. On a miss, call the existing `findKiloUserPepper` helper.
5. Cache a present user's pepper and blocked reason for 60 seconds.
6. Cache a missing user for five minutes.
7. Fail closed with 503 if KV `get`, secret resolution, PostgreSQL, or Hyperdrive
   fails before an authoritative state is available.
8. Do not log tokens, peppers, Authorization headers, internal secrets, or cache
   payloads.

### 2. Isolate KV write failure from authorization

An authoritative DB result is sufficient to decide the current request. A cache
write is an optimization for later requests.

After constructing `state` from PostgreSQL:

1. Await `USER_EXISTS_CACHE.put` as required by the platform contract.
2. Catch only the `put` failure locally.
3. Emit a sanitized structured warning containing the operation, user ID, and
   safe error message/class, but never the serialized state or pepper.
4. Return the authoritative state whether the `put` succeeds or fails.

Expected outcomes:

- present, unblocked matching user + failed `put` → authorize;
- present blocked or mismatched user + failed `put` → 403;
- missing user + failed `put` → 403;
- DB lookup failure → 503; and
- KV `get` failure → 503 rather than an unbounded DB fallback during a KV outage.

The implementation must not use `void USER_EXISTS_CACHE.put(...)`; the test must
prove that the write was awaited even though its rejection is non-fatal.

### 3. Preserve and document token classification

After signature, expiry, schema, and audience verification:

- `apiTokenPepper === undefined` is the explicit internal compatibility class;
- `apiTokenPepper` present as a string or `null` is an ordinary user token;
- ordinary tokens require `blockedReason === null` and strict pepper equality;
- internal compatibility tokens require an existing user row but ignore pepper
  and blocked state; and
- unexpected audiences remain rejected.

Add a concise code comment at this branch in `kilo-jwt-auth.ts`. Add a matching
comment near `payload.apiTokenPepper ?? null` in
`packages/worker-utils/src/kilo-token-auth.ts` explaining that the shared helper
uses legacy null-pepper comparison semantics and does not perform
session-ingest's internal-token classification.

Do not add a shared `classifyKiloToken` abstraction in this PR. There is no
second consumer with the same policy.

### 4. Add one transaction-aware CLI session admission helper

Create a small shared session-ingest service whose only responsibility is to
decide whether a user may create a `cli_sessions_v2` row.

Suggested contract:

```ts
async function canCreateCliSessionForUser(
  tx: WorkerDbOrTransaction,
  kiloUserId: string
): Promise<boolean>
```

The exact database type should reuse an existing exported repository type rather
than defining a broad local interface.

Required query semantics:

1. Select the `kilocode_users` row by ID.
2. Lock the row for the duration of the creation transaction using the existing
   Drizzle/PostgreSQL locking pattern (`FOR UPDATE` or the narrowest equivalent
   that conflicts with the blocking update).
3. Return true only when the row exists and `blocked_reason IS NULL`.
4. Do not compare a token pepper here. This guard also protects trusted internal
   creation paths, and ordinary-token pepper validation remains middleware's
   responsibility.
5. Do not reveal whether the user is missing or blocked through public HTTP
   responses.

The guard and insert must execute in the same PostgreSQL transaction. A separate
preflight query is insufficient because blocking could commit between the check
and insert.

Concurrency invariant:

- if session creation acquires the user lock first, its row commits before the
  block and is part of the pre-block/in-flight state that deletion must clean;
- if blocking acquires the user lock first, session creation observes the
  blocked row and refuses the insert; and
- no creation can observe an unblocked row, release that observation, then
  insert after the block commits.

### 5. Apply admission at every production insert site

#### Public `POST /api/session`

Wrap the admission check and `cli_sessions_v2` insert in one transaction.
Return the existing generic 403 shape when admission fails. Preserve current
idempotent conflict behavior, event emission, and access-cache warming after the
transaction.

#### `SessionIngestRPC.createSessionForCloudAgent`

Run admission at the start of the existing transaction, before attempting the
insert or rebinding an existing row. If admission fails, throw one stable,
non-sensitive domain error. The Cloud Agent caller must treat it as failed
session preparation and must not continue creating execution state as if the
ownership row existed.

This is the critical bypass closure: Cloud Agent's public `start` authentication
currently verifies token signature/shape but does not compare current pepper or
blocked state before invoking the service-binding RPC.

#### Cloud Agent scoped child-session creation

Run admission inside the existing transaction before locking the root session
and before inserting a contained child. Return the same generic 403 response as
the public creation route. Preserve root identity, organization access, and
scope assertions.

Do not add blocked checks to read, export, delete, share, or ingest routes as
part of this item.

### 6. Add the internal user-auth invalidation endpoint

Add `POST /internal/user-auth/invalidate` with:

- body `{ kiloUserId: string }` validated by Zod;
- `X-Internal-Secret` authentication;
- deletion of `user-auth:v1:<kiloUserId>` from the existing
  `USER_EXISTS_CACHE` namespace;
- 204 on success;
- 400 on invalid input; and
- 401 on a missing or invalid internal secret.

The endpoint may ship unused in PR 1. That is intentional and enables the safe
deployment order.

### 7. Reuse the existing internal-secret middleware

Apply `requireValidInternalSecret` to the exact internal routes that currently
repeat `hasValidInternalSecret`, including:

- `/internal/session-access/invalidate`;
- `/internal/user-auth/invalidate`; and
- `/internal/session/:sessionId/export`.

Keep the existing middleware ordering for `/internal/cloud-agent/v1/*`: Kilo JWT
authentication followed by internal-secret authentication. Do not broaden the
secret middleware to public routes or change public 401/404 behavior.

### 8. PR 1 tests

#### Middleware tests

Cover at minimum:

- matching ordinary pepper + unblocked state → 200;
- stale pepper → 403;
- blocked state → 403;
- present `null` token pepper + `null` stored pepper → 200;
- present `null` token pepper + string stored pepper → 403;
- missing user → 403;
- warm cache hit avoids PostgreSQL;
- malformed and legacy values cause a DB miss and never authorize directly;
- present-user cache miss writes TTL 60;
- missing-user cache miss writes TTL 300;
- `put` remains pending → response remains pending;
- `put` rejects after a successful DB read → the DB-derived allow/deny response
  is preserved;
- PostgreSQL throws → 503 and no authorization;
- KV `get` throws → 503 and no PostgreSQL stampede fallback;
- internal compatibility token + existing blocked user → accepted;
- internal compatibility token + missing user → 403;
- unexpected audience → 401; and
- missing/malformed bearer token → 401.

#### Creation-admission tests

For each of the three insert sites, cover:

- existing unblocked user → current create/idempotent behavior;
- existing blocked user → no insert;
- missing user → no insert; and
- admission failure occurs before any post-insert event/cache side effect.

Add one database-backed concurrency regression test if the repository's current
session-ingest test infrastructure can exercise two real transactions without
substantial harness work. It should demonstrate that a concurrent block and
create serialize on the user row. If the service suite is mock-only, protect the
locking and same-transaction invariant with focused query-chain tests and note
the lack of a real concurrency test in the PR description.

#### Internal route tests

Cover valid secret + valid body, invalid secret, missing secret, malformed body,
and exact versioned-key deletion. Ensure route authentication tests prove the
middleware is actually mounted rather than merely unit-testing the helper.

### 9. PR 1 verification

Run the narrow service checks first, then the package-wide suite:

```sh
pnpm --filter cloudflare-session-ingest test -- src/middleware/kilo-jwt-auth.test.ts
pnpm --filter cloudflare-session-ingest test -- src/routes/api.test.ts
pnpm --filter cloudflare-session-ingest test -- src/routes/cloud-agent-session-scope.test.ts
pnpm --filter cloudflare-session-ingest test -- src/session-ingest-rpc.test.ts
pnpm --filter cloudflare-session-ingest test
pnpm --filter cloudflare-session-ingest typecheck
pnpm --filter cloudflare-session-ingest lint
```

Also run the narrow `@kilocode/worker-utils` test/typecheck commands declared in
its `package.json` if that package changes. Finish with formatting of only
task-owned files and `git diff --check`.

Do not report Docker/PostgreSQL unavailability as a code failure. State which
database-backed checks could not run and the remaining concurrency risk.

### 10. Suggested PR 1 commit boundaries

1. `fix(session-ingest): cache revocable user auth state`
2. `fix(session-ingest): guard every CLI session insert`
3. `feat(session-ingest): add user auth cache invalidation endpoint`
4. `test(session-ingest): cover revocation failure and compatibility paths`

Small adjustments are acceptable, but keep production behavior and test-only
changes reviewable rather than combining the entire port into one opaque commit.

## PR 1 deployment and observation gate

### Pre-deploy checks

- PR merged from current `main` with all required checks green.
- The `USER_EXISTS_CACHE`, `HYPERDRIVE`, `NEXTAUTH_SECRET_PROD`, and
  `INTERNAL_API_SECRET_PROD` bindings exist in the target environment.
- No secret or pepper values appear in logs or test fixtures.
- The deployment owner acknowledges the 60-second fail-closed outage trade-off.

### Deploy

Deploy session-ingest by the normal production process. Do not deploy PR 2 in the
same change window.

### Observe before PR 2

Observe at least one full positive TTL plus KV propagation margin; use a minimum
of several minutes and extend the window if traffic or metrics are sparse.

Check:

- total request and WebSocket-handshake success rate;
- 401, 403, and 503 rates split by route class;
- p50/p95/p99 authentication latency;
- Hyperdrive/PostgreSQL query rate and connection errors;
- KV `get`, `put`, and sanitized cache-write failure logs;
- Cloud Agent session-start failures from `createSessionForCloudAgent`; and
- unexpected growth in missing/malformed cache-state misses.

Expected one-time behavior:

- legacy `user-exists:` entries are ignored;
- the first request per active user for the new versioned key reads PostgreSQL;
- concurrent first requests may duplicate that read and write because KV is not
  a single-flight cache; and
- load settles toward one auth-state lookup per distinct active user per minute.

### PR 1 rollback

If availability or load is unacceptable, roll back only the session-ingest
deployment. The new `user-auth:v1:` keys are isolated by prefix and expire on
their own. No schema or client rollback is required because PR 2 has not shipped.

Do not proceed to PR 2 until PR 1 is healthy.

## PR 2 — web token issuance and invalidation

### Branch preparation

Create PR 2 from `main` after PR 1 has merged and its production deployment has
passed the observation gate. Prefer a fresh worktree. If reusing
`eshurakov-serene-cedar`, first preserve its uncommitted user-owned files, update
it deliberately, and resolve overlaps without overwriting those changes.

PR 2 depends on the deployed invalidation endpoint but remains safe if an
individual invalidation call fails because the 60-second cache TTL owns
correctness.

### PR 2 file scope

Expected production files:

- `apps/web/src/routers/active-sessions-router.ts`
- `apps/web/src/lib/session-ingest-client.ts`
- `apps/web/src/lib/user/block.ts`
- `apps/web/src/lib/user/index.ts`

Potential comments/documentation at the direct bulk block paths:

- `apps/web/src/lib/abuse/bulkBlock.ts`
- `apps/web/src/app/admin/api/backfills/block-blacklisted-domains/route.ts`

Expected tests:

- the focused active-sessions token test file;
- `apps/web/src/lib/session-ingest-client.test.ts`;
- the unset-environment helper test if kept separate;
- `apps/web/src/lib/user/block-invalidate.test.ts` or the existing block test
  suite; and
- `apps/web/src/lib/user/soft-delete-invalidate.test.ts` or the existing
  soft-delete test suite.

Do not change session-ingest behavior in PR 2 except for a narrowly justified
follow-up discovered during integration verification.

### 1. Mint a pepper-bearing viewer token

Change only `activeSessions.getToken` to mint an ordinary user token containing
the current `ctx.user.api_token_pepper`, with an explicit one-hour expiry.

Requirements:

- preserve the response shape `{ token }`;
- preserve the one-hour lifetime;
- use the existing `generateApiToken` and `TOKEN_EXPIRY.oneHour` primitives;
- do not change mobile, web, or extension consumers;
- do not change the other `generateInternalServiceToken` calls in
  `active-sessions-router.ts`; they are server-side calls and remain part of the
  internal compatibility class; and
- do not introduce a new JWT audience or token format in this PR.

The test must decode/verify the minted token and assert:

- `kiloUserId` matches the authenticated user;
- `apiTokenPepper` is present, including the distinction between explicit
  `null` and an absent field;
- expiry is approximately one hour; and
- no unrelated user fields are added.

### 2. Add the web invalidation client

Add `invalidateUserAuthCache(kiloUserId)` next to the existing organization
session-access invalidation helper.

Requirements:

- call `POST /internal/user-auth/invalidate`;
- send `X-Internal-Secret` and a JSON content type;
- send only `{ kiloUserId }`;
- use the existing 30-second request deadline pattern;
- capture and throw non-2xx failures using sanitized metadata;
- never log a token, pepper, secret, cookie, or Authorization header; and
- return without a network request when the session-ingest URL or internal
  secret is unset, preserving the chosen local/test behavior.

Keep this explicit helper separate from organization-session invalidation. Their
missing-configuration behavior is intentionally different, so a generic helper
with policy flags would add more concepts than it removes.

### 3. Make single-user block invalidation post-commit and lifecycle-safe

`blockUser` has two transaction ownership modes and must handle them separately.

#### Self-owned transaction

When `blockUser` opens and awaits its own transaction:

1. finish the transaction;
2. if the user transitioned to blocked, call a best-effort invalidation wrapper;
3. await that wrapper so the fetch is tracked by the invocation; and
4. catch/log failure inside the wrapper so the successful block is still
   returned.

#### Caller-owned transaction (`dbOrTx`)

`blockUser` cannot observe the caller's commit. For this mode:

1. finish the block writes using the provided transaction;
2. if the user transitioned to blocked, register the best-effort invalidation
   with Next's `after()` using the established `credits.ts` pattern;
3. in automated tests, execute or capture the callback through the repository's
   established test branch/mock because `after()` requires request context; and
4. do not start the invalidation fetch synchronously before returning to the
   outer transaction.

`after()` may still run after a later caller rollback. That produces only an
extra cache miss and authoritative reload of the still-unblocked row; it cannot
incorrectly block the user. The important invariant is that it cannot delete the
cache and allow a pre-commit DB read to repopulate a fresh unblocked value.

Tests must prove:

- self-owned block invalidates after transaction success;
- caller-owned block does not invoke invalidation before the outer transaction
  callback finishes;
- a rollback does not persist the block;
- invalidation failure does not change the successful block result; and
- already-blocked/missing users do not invalidate.

Replace the current test that merely asserts invalidation occurred inside a
provided transaction; it encodes the wrong ordering.

### 4. Make soft-delete invalidation post-commit and lifecycle-safe

`softDeleteUser` owns and awaits its anonymization transaction. After it commits:

1. call the same best-effort invalidation wrapper;
2. await the wrapper so Vercel cannot freeze an untracked fetch;
3. catch and report failure without failing completed anonymization; and
4. preserve the existing deletion event behavior outside this remediation's
   scope.

Tests must prove invalidation occurs only after successful anonymization, is not
called when the transaction fails, and cannot turn a completed soft-delete into
an error.

### 5. Explicitly retain TTL-only behavior for bulk blocking

Do not issue one invalidation HTTP request per user from `bulkBlockUsers` or the
blacklisted-domain backfill. Those paths can update up to thousands of users,
and an unbounded HTTP/KV fan-out would add a larger availability risk than the
accelerator solves.

Document near each direct block update that:

- session-ingest authorization correctness is bounded by the 60-second positive
  TTL plus KV propagation;
- these bulk paths intentionally do not accelerate invalidation;
- pepper rotation and non-null `blocked_reason` remain authoritative; and
- a future bulk invalidation endpoint requires measured need and bounded Worker
  operation/concurrency limits.

This resolves the review finding by making the trade-off explicit rather than
silently omitting a presumed required side effect.

### 6. PR 2 tests

Cover at minimum:

- `getToken` returns a pepper-bearing one-hour token;
- existing client code compiles without response-contract changes;
- invalidation helper request URL, method, body, secret header, and timeout;
- invalidation helper non-2xx reporting;
- unset URL and unset secret both skip fetch;
- self-owned block post-commit ordering;
- caller-owned block scheduling and ordering;
- block invalidation failure isolation;
- already-blocked/missing block behavior;
- successful soft-delete post-commit invalidation;
- failed soft-delete does not invalidate; and
- soft-delete invalidation failure isolation.

Do not add snapshots that merely reproduce implementation details. Prefer
observable ordering and outcome assertions.

### 7. PR 2 verification

Read the current `apps/web/package.json` and use its exact scripts. At minimum:

```sh
pnpm --dir apps/web exec jest --runInBand --no-watchman <focused-test-files>
pnpm --filter web typecheck
pnpm --filter web lint
```

The web Jest environment performs global PostgreSQL cleanup even for apparently
unit-only files. Start/migrate the documented test database when available. If
Docker/PostgreSQL is unavailable, report that environment limitation separately
and still run typecheck, lint, `git diff --check`, and any test suite that can run
without the database.

Format only task-owned files and finish with `git diff --check`.

### 8. Suggested PR 2 commit boundaries

1. `fix(web): issue revocable active-session viewer tokens`
2. `fix(web): invalidate session auth after committed user blocks`
3. `fix(web): invalidate session auth after soft delete`
4. `test(web): cover revocable token and invalidation lifecycle`

## PR 2 deployment and drain

### Pre-deploy

- Confirm PR 1 is still deployed and healthy.
- Confirm the internal invalidation endpoint returns 204 from the deployed web
  environment using the configured secret; do not print the secret.
- Confirm every web deployment serving `activeSessions.getToken` is included.
- Confirm the one-hour expiry is explicit in code and tests.

### Deploy

Deploy PR 2 through the normal web deployment process. No client-store release
or coordinated mobile/extension update is required because clients treat the
token as opaque and fetch it on connection/recovery.

### Observe

Check:

- `activeSessions.getToken` error rate;
- `/api/user/web` handshake 401/403 rates;
- invalidation endpoint 2xx/4xx/5xx rates and latency;
- logged invalidation failures;
- unexpected mobile, extension, or web reconnect loops;
- session-ingest DB lookup and 503 rates; and
- reports of active-session lists or remote controls failing for unblocked
  users.

### Drain window

Wait at least one hour after the last web deployment finishes before claiming
that previously issued pepper-less viewer tokens have expired. This drain does
not close already-open WebSockets and must not be represented as doing so.

### PR 2 rollback

Rolling back web token issuance is safe because deployed session-ingest continues
to accept pepper-less internal compatibility tokens. Leave PR 1 deployed unless
its own metrics require rollback. The invalidation endpoint may remain unused.

## End-to-end acceptance criteria

### Security and correctness

- A matching ordinary token for an existing unblocked user is accepted.
- An ordinary token with a rotated pepper is rejected after the KV convergence
  window.
- An ordinary token for a blocked user is rejected after the KV convergence
  window.
- Legacy cache blobs cannot authorize a request.
- A failed KV cache write does not reject a request whose authoritative DB state
  permits it.
- DB/KV-read failures fail closed without exposing credentials.
- Pepper-less internal compatibility tokens retain their named behavior.
- A blocked or missing user cannot create a `cli_sessions_v2` row through the
  public route, the Cloud Agent RPC, or the scoped child-session route.
- Admission check and insert are serialized in the same transaction.
- Blocking and soft-delete success do not depend on invalidation success.
- Single-user invalidation is not initiated inside an uncommitted caller-owned
  transaction and is tracked through completion by await or `after()`.

### Compatibility

- PR 1 supports old pepper-less viewer tokens and new pepper-bearing tokens.
- PR 1 can be deployed and rolled back before any web change.
- Existing mobile, extension, and web clients require no code update.
- PR 2 preserves `{ token }` and the one-hour token lifetime.
- Existing server-to-server internal token issuance remains unchanged.
- The accepted already-open WebSocket residual is documented and is not hidden
  behind an overbroad revocation claim.

### Operations

- The 60-second positive TTL and 503-on-authoritative-read-failure behavior are
  explicit in both PR descriptions.
- Production observation separates expected cold versioned-key misses from
  errors.
- Neither PR logs tokens, peppers, secrets, cookies, or authentication headers.
- Rollback requires no database migration, KV deletion, or client release.

## Deferred follow-up: strict WebSocket revocation

Create a separate design only if product/security requires already-open viewer
sockets to lose mutation ability within the same bounded revocation window.
Evaluate, with measured traffic and latency:

1. command-time cached authorization checks in `UserConnectionDO`;
2. attaching token class/pepper/expiry metadata to accepted sockets and forcing
   periodic reauthentication;
3. a reliable per-user socket-revocation RPC with retries/durable delivery; or
4. short-lived, purpose-bound session-ingest viewer tokens.

That follow-up must explicitly cover Durable Object hibernation, reconnect
behavior, pending command settlement, mobile background/resume behavior,
extension lifecycle, deploy-version skew, and the load added to KV or another
authorization service. It is not part of either PR in this plan.

## Final handoff checklist

Before declaring the remediation complete:

1. PR 1 is merged, deployed, observed, and its production health gate passed.
2. PR 2 was based on PR 1's merged `main`, not the older combined diff.
3. PR 2 is merged and deployed to every relevant web project.
4. The one-hour legacy viewer-token drain elapsed.
5. Automated checks and any environment-limited checks are reported accurately.
6. PR descriptions include the availability trade-off and WebSocket residual.
7. No unrelated user changes in either worktree were overwritten.
8. No push, deployment, or PR-thread action is performed by an agent without
   explicit authorization.
