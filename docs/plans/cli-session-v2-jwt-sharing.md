# CLI session v2 JWT sharing implementation plan

## Outcome

Replace `cli_sessions_v2` public UUID links with purpose-bound JWT share links while preserving immediate per-session disablement and adding an operator-controlled creation-time revocation boundary.

The JWT is the bearer credential and is never stored in PostgreSQL. The existing nullable `cli_sessions_v2.public_id` UUID remains in place as the current share generation ID: it is embedded as the JWT `jti` claim, matched during every public read, and cleared to revoke every JWT issued for that session generation.

This is a clean cutover. Existing UUID URLs do not need compatibility because production `public_id` values have already been reset to `NULL`.

## Accepted decisions

- Session-ingest exclusively signs and verifies share JWTs. Cloud does not receive the share signing secret or duplicate token verification.
- Use a dedicated session-share signing secret rather than `NEXTAUTH_SECRET`.
- Keep `public_id` and its partial unique index unchanged; no PostgreSQL migration is needed.
- JWTs do not expire automatically. They remain valid until their session is disabled, the global minimum `iat` advances, or the signing secret rotates.
- Repeated sharing of an enabled session signs a JWT with the current integer-second `iat` while retaining the same `public_id`. Calls within one second may produce the same deterministic token; otherwise their JWT strings differ. Tokens from that generation remain valid unless the session is disabled, their `iat` falls below the global cutoff, or the signing secret rotates.
- Disabling and then re-enabling sharing produces a new `public_id`, so JWTs from the previous generation cannot become valid again.
- The JWT remains in the URL path (`/s/{jwt}`) to preserve self-contained browser and CLI share links.
- No disable-sharing UI or new Cloud unshare mutation is part of this change. The existing authenticated ingest `POST /api/session/:sessionId/unshare` route remains the available backend mechanism and continues to clear `public_id`.
- The public landing page keeps its current title and owner-display-name behavior by resolving metadata through session-ingest.

## Security and token contract

### Claims

Create a session-ingest-local share-token module using the already-installed `jose` package. Move `jose` from the service's `devDependencies` to `dependencies` because signing and verification become production runtime behavior.

Sign with HS256 and require this exact logical contract:

| Field | Value |
| --- | --- |
| Protected `alg` | `HS256` only |
| `iss` | A fixed session-ingest issuer constant |
| `aud` | A fixed CLI session share audience constant |
| `version` | `1` |
| `sub` | `cli_sessions_v2.session_id` |
| `jti` | The current `cli_sessions_v2.public_id` UUID |
| `iat` | Integer epoch seconds assigned by the signer |
| `exp` | Omitted intentionally |

Use strict payload validation after cryptographic verification. Reject missing, malformed, unknown-version, wrong-issuer, wrong-audience, wrong-algorithm, and missing-`iat` tokens. Do not accept ordinary Kilo user JWTs at this boundary even though they are also HS256 JWTs.

### Dedicated secret and global cutoff

- Add a required session-ingest Secrets Store binding such as `CLI_SESSION_SHARE_JWT_SECRET_PROD`. Provision at least 32 random bytes before deployment; never place the value in tracked files or logs.
- Add `CLI_SESSION_SHARE_TOKEN_MIN_IAT` to session-ingest Worker variables as a decimal non-negative integer epoch-seconds value, defaulting to `0`.
- Parse the cutoff strictly. A configured malformed, negative, fractional, or unsafe integer is a server configuration error and must fail closed rather than silently behaving as `0`.
- Accept a token when `iat >= CLI_SESSION_SHARE_TOKEN_MIN_IAT`; reject it when `iat` is lower. Equality is intentionally accepted.
- Advancing the cutoff and deploying session-ingest revokes all older share JWTs. A subsequent share call mints a new valid JWT even when the session's `public_id` generation is unchanged.
- Rotating the dedicated signing secret revokes every existing share JWT. Existing enabled rows may mint replacement JWTs without changing `public_id`.

### Bearer-token handling

The accepted URL-path transport means the hosting infrastructure necessarily observes the bearer token. Limit secondary exposure under application control:

- Never add a share token to application logs, exception messages, Sentry extras, analytics, or tracing attributes.
- Return `Cache-Control: no-store` from token-authenticated public ingest responses and fetch them with `cache: 'no-store'` from Cloud.
- Apply `Referrer-Policy: no-referrer` to `/s/*`, overriding the current global `strict-origin-when-cross-origin` policy for these capability URLs.
- Always URL-encode tokens when Cloud constructs an ingest request. Do not decode or expose JWT payload fields in client-side UI.

## Session-ingest implementation

### Central resolver

Add one internal resolver used by every public share-token endpoint. It owns the complete authorization boundary:

1. Load the dedicated secret and validate the configured minimum `iat`.
2. Verify the JWT signature, algorithm, issuer, audience, version, and strict claims.
3. Reject claims whose `iat` is below the configured cutoff.
4. Query `cli_sessions_v2` for a row matching both `session_id = sub` and `public_id = jti`.
5. Return the internal session ID, owner user ID, title, and existing owner display name needed by consumers.

The combined `sub + jti` match is important because the table's primary key includes `kilo_user_id`, while the partial unique index makes the non-null `public_id` generation globally unambiguous. A valid signature alone never grants access; the current database generation must still match.

Return a typed “not shared” result only for invalid/malformed JWTs, cutoff rejection, or a missing generation match. Let secret retrieval, cutoff configuration, database, and Durable Object failures remain operational errors rather than disguising them as revocation.

Do not cache the session-generation lookup. Immediate disablement depends on every public request observing the authoritative nullable `public_id`, and the current UUID implementation already performs one PostgreSQL lookup per public snapshot request. This change does not add a new database read to that hot path.

### Share issuance

Update the existing authenticated `POST /api/session/:sessionId/share` route:

- Preserve its current ownership and current-organization-access checks.
- Preserve the atomic `SET public_id = COALESCE(public_id, generated_uuid)` update so concurrent first-share requests converge on one stored generation.
- Return the stored `public_id`, sign a fresh JWT from it, and respond with `{ success: true, share_token: string }`.
- Never return the raw `public_id` as the external share credential and never persist the JWT.
- If signing fails after the database update, return an operational error. A retry is safe: it reuses the stored generation and mints a token.

Concurrent share and unshare requests linearize through their row updates. A share response may become revoked immediately if a concurrent unshare clears the generation after issuance; this is correct because disablement wins at the later database state.

### Disablement

Do not add a new endpoint. Keep the existing authenticated `POST /api/session/:sessionId/unshare` behavior and authorization intact. Its `public_id = NULL` update is the revocation operation for all JWTs in the active generation.

Update focused coverage to prove that a previously valid JWT no longer resolves after this update. A future UI or Cloud mutation can call the existing ingest route without changing the token model.

### Public snapshot and metadata

- Change `GET /session/:value` to interpret the route value only as a share JWT. Remove UUID parsing and direct `public_id` lookup. Resolve through the central resolver, then stream the same `SessionIngestDO.getAllStream()` snapshot with the existing JSON content type plus `Cache-Control: no-store`.
- Add `GET /session/:shareToken/metadata`. Resolve through the same helper and return only `{ success: true, title: string | null, owner_name: string | null }` with `Cache-Control: no-store`.
- Return the same `404 session_not_found` response for malformed tokens, bad signatures/claims, cutoff-revoked tokens, cleared generations, and missing sessions. Do not reveal which validation step failed.
- Return `500` for invalid server configuration or unavailable dependencies. Do not include the token or raw verification error in the response.

The metadata endpoint exists only to preserve the current server-rendered `/s/*` page without sharing the signing key with Cloud or downloading the full session snapshot merely to validate the landing page.

## Cloud implementation

### Server client and tRPC contracts

Update the existing session-ingest server client and v2 session routers:

- Parse the ingest share response as `{ success: true, share_token: string }` and return `share_token` to `cliSessionsV2.share`.
- Reuse the same client helper from `shareForWebhookTrigger` instead of maintaining a second fetch and response parser. Preserve the webhook route's existing organization/personal authorization and its use of the session owner's internal service token.
- Return `share_token` from `shareForWebhookTrigger` and update its current caller to construct `/s/{share_token}`.
- Add `fetchSharedSessionMetadata(shareToken)`. It calls the ingest metadata endpoint server-to-server with `cache: 'no-store'`, returns `null` on `404`, parses the successful response strictly, and throws on operational or malformed responses.
- Do not add an unshare client function or `cliSessionsV2.unshare` procedure in this change.

Use `share_token` consistently in public API and local variable names. Keep `public_id` terminology only at the database boundary where it names the retained column.

### Landing page and existing share callers

Update `/s/[sessionId]` semantically to treat its dynamic segment as `shareToken`:

- Remove UUID validation and the direct Cloud PostgreSQL lookup by `public_id`.
- Resolve title and owner display name through `fetchSharedSessionMetadata`; call `notFound()` for a `null` result.
- Preserve the current landing-page layout, editor link, and `kilo import` command, substituting the JWT URL as the shared value.
- Update the two existing v2 share dialogs and webhook-request UI to consume `share_token` when building links. No visual redesign is required.

Do not decode or validate the token in browser code. The page's server component and session-ingest remain the only participants in resolution.

## Tests

### Session-ingest token tests

Add focused unit coverage for the token module:

- A freshly signed token verifies and contains the exact required claims with no `exp`.
- Wrong secret, non-HS256 algorithm, issuer, audience, version, malformed `sub`, malformed `jti`, missing `iat`, and malformed payloads are rejected.
- `iat` one second below the cutoff is rejected; `iat` equal to and above the cutoff is accepted.
- A malformed cutoff fails as configuration error instead of accepting or classifying the token as not found.

### Session-ingest route tests

Extend the existing route suites to cover:

- First share fills a null `public_id`, returns `share_token`, and the verified token's `sub`/`jti` match the session row.
- Repeated share reuses `public_id` and signs with the current `iat`; tokens issued in different seconds both resolve while they remain above the cutoff and the generation stays active.
- A share JWT is not present in database update parameters or returned as `public_id`.
- Existing personal and organization authorization failures still stop before issuance.
- A valid matching JWT streams the snapshot and valid metadata returns the existing title/owner fields.
- Malformed, wrongly signed, wrong-purpose, below-cutoff, subject-mismatched, generation-mismatched, and cleared-generation JWTs all return the same `404` without calling the Durable Object.
- Clearing `public_id` through the existing unshare route invalidates a JWT that resolved immediately before it.
- Re-sharing after disablement uses a new `public_id`; the new JWT resolves and the previous JWT remains rejected.
- Operational configuration, database, and Durable Object failures remain `500` and do not expose the token.
- Successful public snapshot and metadata responses contain `Cache-Control: no-store`.

### Cloud tests

Update focused web tests to cover:

- The session-ingest client parses and returns `share_token`; old `{ public_id }` responses are rejected after cutover.
- Metadata returns parsed data on `200`, `null` on `404`, and throws on malformed or operational responses without including the token in captured metadata.
- `cliSessionsV2.share` and v2 webhook sharing return `share_token` while preserving existing access checks.
- Existing share-dialog and webhook link construction uses `/s/{share_token}`.
- The shared page renders current metadata for a valid token and returns Next.js not-found behavior for a rejected token. Avoid markup snapshots; test the server-side decision and important generated import/editor URLs.
- `/s/*` receives `Referrer-Policy: no-referrer`.

## Delivery sequence

1. Add and test the session-ingest token module, dedicated secret binding, cutoff variable, and central resolver.
2. Convert ingest share issuance, public snapshot resolution, metadata, and existing unshare coverage.
3. Update the Cloud server client, tRPC/webhook contracts, landing page, and current share-link callers.
4. Provision the dedicated production secret before deploying session-ingest. Keep the tracked cutoff at `0` for initial launch.
5. Deploy session-ingest and Cloud as one coordinated release. Because there are no retained UUID links, a brief deployment-order mismatch may make new sharing unavailable but must not fall back to accepting UUID access.
6. Smoke-test a newly issued link through the Cloud landing page and CLI snapshot endpoint. Confirm that the JWT is absent from application logs and error reporting.
7. Exercise the existing ingest unshare route with an authorized test session and confirm that both metadata and snapshot reads return `404`; re-share and confirm only the newly issued generation works.

Rollback should restore the previous application versions and rotate or remove the dedicated share secret if it may have been exposed. Do not restore old database `public_id` values or add UUID compatibility. Rows enabled during the JWT release still contain UUID generations; after rollback they would become directly usable UUID credentials, so rollback must either clear those newly populated `public_id` values before re-enabling the legacy reader or keep public sharing disabled until the JWT release is repaired.

## Verification commands

Use the narrowest relevant repository scripts after implementation:

- Run the session-ingest unit suite, typecheck, and lint.
- Run focused web tests for `session-ingest-client`, `cli-sessions-v2-router`, webhook sharing, and the `/s/*` page, then the web typecheck and lint.
- Run the relevant root typecheck if shared types or package boundaries change.
- Run changed-file formatting checks and `git diff --check`.
- Do not generate a database migration; verify that `packages/db/src/schema.ts` and migration metadata remain unchanged.
- Review changed logging, exception capture, analytics, and tracing calls to confirm that none receive a raw share token or token-bearing URL.

## Completion criteria

The change is complete when:

- New share operations return JWT URLs and no external response exposes `public_id` as the credential.
- A public snapshot or metadata read succeeds only when signature, purpose, version, `iat` cutoff, session subject, and current `public_id` generation all match.
- Clearing `public_id` immediately revokes every JWT for that session, and re-sharing cannot resurrect older tokens.
- Advancing the Worker cutoff revokes older JWTs while allowing newly minted JWTs for already-enabled sessions.
- No JWT is persisted in PostgreSQL or intentionally emitted to logs, monitoring, analytics, caches, or referrers.
- Cloud holds no share signing key and implements no parallel JWT authorization logic.
- Existing share authorization, webhook authorization, landing-page metadata, snapshot streaming, and CLI-import link behavior remain covered by focused tests.
