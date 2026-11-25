# @kilocode/verify

The one bearer-credential verifier for Kilo services (design section 7). It checks STS service
tokens, UTS access tokens and personal access tokens (PATs), and it answers every failure with the
status, error and headers section 7 prescribes. It depends only on `zod`, `jose` and
`@kilocode/sts-contracts`, uses Web platform APIs only (no `node:` imports, no Workers-only
globals), and runs unchanged on Workers, Vercel functions and Fly services.

## Use

Create one verifier per isolate or process, at module scope, so its caches serve every request:

```ts
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import { createVerifier, failureResponse, httpJwksSource } from '@kilocode/verify';

const verifier = createVerifier({
  audience: 'session-ingest',
  resourceMetadataUrl: 'https://session-ingest.kiloapps.io/.well-known/oauth-protected-resource',
  sts: {
    issuer: STS_ISSUERS.production,
    // On Workers, pass the STS service binding: httpJwksSource(issuer, (url, init) => env.STS.fetch(url, init)).
    jwks: httpJwksSource(STS_ISSUERS.production),
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const result = await verifier.verify(
      request,
      { issuer: 'sts', scope: 'session-ingest:events.write' },
      { waitUntil: promise => ctx.waitUntil(promise) }
    );
    if (!result.ok) return failureResponse(result);
    // result.caller is { kind: 'service', workload: 'cloud-agent-next' }
  },
};
```

On Vercel pass `waitUntil` from `@vercel/functions`; on Fly pass a function that keeps the promise
referenced (`promise => void promise`), since the process outlives the request.

## API

`createVerifier(config) -> { verify(input, route, ctx) }`

| Input | Meaning |
|---|---|
| `config.audience` | This service; the one `aud` it accepts |
| `config.resourceMetadataUrl` | RFC 9728 metadata URL sent in every 401 challenge |
| `config.sts` | `{ issuer, jwks, scopeRegistry? }`; the registry defaults to `STS_SCOPE_REGISTRY` |
| `config.uts` | `{ issuer, jwks, isTokenKid, scopeRegistry, revocation, pat? }` (ports below) |
| `input` | A `Request`, its `Authorization` value, or `null` |
| `route` | `{ issuer: 'sts' \| 'uts', scope, org?, requiresSession? }`: exactly one issuer and one scope |
| `ctx` | `{ waitUntil, clientAddress? }`: the request's own `waitUntil`, and the client address for the PAT lookup limit |

`verify` resolves to a `VerifyResult`:

- `{ ok: true, credential: 'access_token', issuerKind, claims, caller }`
- `{ ok: true, credential: 'pat', issuerKind: 'uts', pat, caller }`
- `{ ok: false, status, error, reason, headers, body }`; `failureResponse(failure)` turns it into a
  `Response`. `reason` names the rule that refused the request, for logs and tests only; it is never
  sent.

`caller` is `{ kind: 'service', workload }`, `{ kind: 'user', subject, clientId, org, sessionId,
actor }` or `{ kind: 'pat', subject, patId, org }`. `verify` never throws for a bad credential or a
failed dependency; it rejects only for a route the verifier cannot serve (a programming error: a
scope of another audience, an issuer the config lacks, an STS route that requires a session).
Results and errors never carry the credential.

## Ports

| Port | Who implements it | Contract |
|---|---|---|
| `JwksSource` `(signal) => Promise<unknown>` | `httpJwksSource(issuer, fetcher?)` here; a service binding on Workers | Returns the key-set body; the cache validates it (`keys[]`, Ed25519 OKP entries with a `kid`; other entries are skipped; a duplicate `kid` refuses the set) |
| `uts.isTokenKid` `(kid) => boolean` | Phase 3 (`signerOfTokenKid(kid) !== null` from `@kilocode/uts-contracts`) | The UTS key set also publishes revocation-feed keys; a token under any other `kid` is refused before any fetch |
| `UtsScopeRegistry` `(audience, scope) => { requiresSession, patEligible } \| null` | Phase 3 | `null` for an unregistered scope |
| `RevocationFeedSource.fetch(held, signal)` | Phase 3 | Resolves `{ head, list }` only after it has verified the head signature against the UTS feed keys and a new list against `head.listHash`; returns `list: null` when the hash equals `held.listHash`. Any rejection is a failed fetch |
| `PatLookup` `(hash, signal)` | Phase 3 | `found` (a `PatRecordSchema` record), `not_found` (unknown, revoked or expired), `rate_limited` or `unavailable` with `retryAfterSeconds` |
| `SharedPatCache` `{ get, put }` | The service: Workers Cache API or Vercel Runtime Cache | Opaque strings; errors count as a miss |

## PAT format

This package owns the format; UTS mints with `createPatString()` and stores `hashPat(pat)`.

```
kilo_pat_<body: 43 chars><checksum: 6 chars>     58 characters
```

- body: 32 bytes from `crypto.getRandomValues`, base64url without padding, canonical (it decodes
  to 32 bytes and re-encodes to itself);
- checksum: CRC-32 (IEEE) of the ASCII text `kilo_pat_<body>`, as 4 big-endian bytes in base64url
  without padding.

`parsePat` checks prefix, length, alphabet, canonical body and checksum offline. `hashPat` is the
SHA-256 of the whole PAT as lowercase hex: the key of both cache layers and of the UTS lookup.

## Section 7 rows

Code is in `src/verifier.ts` unless named; tests are table-driven, one `describe` per row.

| Row | Rule | Code | Tests |
|---|---|---|---|
| 1 Algorithm | `EdDSA` only, header names a `kid` | `verifySignedToken` | `rows.test.ts` row 1 |
| 2 Signature | The JWKS key for that `kid`, Ed25519 only | `verifySignedToken`, `jwks.ts` `importKeySet` | row 2; `jwks.test.ts` key-set validation |
| 3 Issuer | Exact `iss`; key only from that issuer's set; no feed key | `verifySignedToken`, one `KeySetCache` per issuer, `isTokenKid` | row 3 |
| 4 Audience | One string equal to this service; an array is refused | `AccessTokenClaimsSchema` (`sts-contracts`), `verifyStsToken`, `verifyUtsToken`, `verifyPat` | row 4; PAT record checks |
| 5 Type | `typ` is `at+jwt` | `verifySignedToken` | row 5 |
| 6 Time | `exp`, `iat`, `nbf` with 60 s skew | `timeFailure` | row 6 |
| 7 Identity | `sub`, `jti`, `client_id`; STS profile | claim schemas, `claimsReason` | row 7 |
| 8 Scope | Registered scope of this audience, equal to the route scope; PATs only for PAT-eligible scopes | `verifyStsToken`, `verifyUtsToken`, `verifyPat` | row 8; PAT record checks |
| 9 Organization | A present org equals the route org | `orgMatches` | row 9; PAT record checks |
| 10 Revocation | UTS: `revoked_before`, revoked `sid` and `kid`; STS: none (decision Q4) | `verifyUtsToken`, `revocation.ts` | row 10; `revocation.test.ts` |
| 11 Session | Session-bound route or scope needs a live `sid`; a PAT never qualifies | `verifyUtsToken`, `verifyPat` | row 11; PAT record checks |
| 12 PAT | Offline check, two cache layers, feed override, fail-closed lookups | `pat-format.ts`, `pat.ts`, `verifyPat` | row 12; `pat.test.ts` |
| 13 Account | Blocked accounts from the feed; STS skips | `verifyUtsToken`, `verifyPat` | row 13; PAT record checks |
| 14 Issuer per route | One issuer per route; a PAT is a UTS credential | `dispatch`, `verifySignedToken` | row 14 |

Fail-closed and caching rules:

| Rule | Code | Tests |
|---|---|---|
| JWKS: 5-min entries, background refresh after 4 min, synchronous after expiry or cold | `jwks.ts` | `jwks.test.ts` key-set lifetime |
| JWKS: last good set only while the issuer is unreachable, up to 24 h, then 503 | `jwks.ts` | the last good set while the issuer is unreachable |
| JWKS: missing set is 503 with `Retry-After` | `jwks.ts` | missing key set |
| JWKS: unknown `kid` refreshes at most once per 5 min per set | `jwks.ts` | unknown kid |
| Feed: background refresh 10 s after the last fetch, wait once the head is over 30 s old | `revocation.ts` | `revocation.test.ts` request-driven revalidation |
| Feed: fetched head over 30 s old or older than the held one counts as failed | `revocation.ts` | fetched heads that do not count |
| Feed: tokens up to 10 min accept a 10-min head; longer credentials refuse past 60 s, even cached | `maxHeadAgeForLifetime` | head-age limits while the feed is down |
| PAT: malformed is 401 with no cache write | `verifyPat` | `pat.test.ts` offline check |
| PAT: 60 s instance + shared cache (60 s / 30 s), by full hash; HMAC with current and previous key; workload in the key | `pat.ts` | two cache layers keyed by the full hash |
| PAT: feed entry overrides both layers | `verifyPat` | the feed entry for a PAT id overrides both layers |
| PAT: lookup failure is 503; stale up to 10 min with one background refresh, only with a head under 60 s | `pat.ts`, `verifyPat` | fail-closed lookups |
| PAT: one lookup per hash; 429 above 20 uncached lookups/s per address, before the lookup; a 429 or 503 never evicts | `pat.ts` | merging and the per-address limit; fail-closed lookups |
| No promise shared across requests: owner + pollers, `waitUntil` hand-off | `flight.ts` | `runtime.test.ts` (real workerd: concurrent cold requests, one call each) and the concurrency tests above |
| A request cancelled mid-call does not stall others: its heartbeat stops, and after 1 s a poller makes its own call (no backoff) | `flight.ts` `abandoned` | `runtime.test.ts` races for the STS key set, UTS key set, feed and PAT lookup |

Error responses: no credential is 401 with `WWW-Authenticate: Bearer resource_metadata="…"`;
malformed, expired, revoked or wrong-issuer credentials are 401 `invalid_token`; wrong audience or
unknown scope is 403 `insufficient_scope` with the required scope in the body and the challenge; an
org mismatch is 403 `org_mismatch`; a failed dependency (key set, feed, PAT lookup, including a UTS
429) is 503 `temporarily_unavailable` with `Retry-After`; the per-address PAT lookup limit is 429
`too_many_requests` with `Retry-After`. Every failure carries `Cache-Control: no-store`.

## Checks

```sh
pnpm --filter @kilocode/verify typecheck
pnpm --filter @kilocode/verify lint
pnpm --filter @kilocode/verify test   # includes the workerd runtime test (wrangler)
```
