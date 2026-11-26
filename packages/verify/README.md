# @kilocode/verify

The one bearer-credential verifier for Kilo services (design section 7). It checks STS service
tokens, UTS access tokens and personal access tokens (PATs), and it answers every failure with the
status, error and headers section 7 prescribes. It depends only on `zod`, `jose` and
`@kilocode/sts-contracts`, uses Web platform APIs only (no `node:` imports, no Workers-only
globals), and runs unchanged on Workers, Vercel functions and Fly services.

The cost of the request path, the background fetches and the memory bounds is in
[COST.md](./COST.md).

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
    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    // Start the cold fetches beside the secrets bundle call; a no-op once the caches hold data.
    verifier.warm({ waitUntil });
    const result = await verifier.verify(
      request,
      { issuer: 'sts', scope: 'session-ingest:events.write' },
      { waitUntil }
    );
    if (!result.ok) return failureResponse(result);
    // result.caller is { kind: 'service', workload: 'cloud-agent-next' }
  },
};
```

On Vercel pass `waitUntil` from `@vercel/functions`; on Fly pass a function that keeps the promise
referenced (`promise => void promise`), since the process outlives the request.

### Client address (PAT verifiers)

A verifier whose config has `uts.pat` requires `clientAddress` in every `verify` call; the type
of `verify` enforces it. Pass the address the platform's edge sets, never one the client can
choose; pass `null` when the header is absent, and the library refuses any PAT with 400
`invalid_request` (there is no shared fallback bucket for the per-address lookup limit).

| Runtime | Header |
|---|---|
| Workers | `CF-Connecting-IP` |
| Vercel | `x-real-ip` (Vercel sets it and overwrites client-supplied forwarding headers; `ipAddress()` from `@vercel/functions` reads it) |
| Fly | `Fly-Client-IP` |

## API

`createVerifier(config) -> { verify(input, route, ctx), warm(ctx) }`

| Input | Meaning |
|---|---|
| `config.audience` | This service; the one `aud` it accepts |
| `config.resourceMetadataUrl` | RFC 9728 metadata URL sent in every 401 challenge |
| `config.sts` | `{ issuer, jwks, scopeRegistry? }`; the registry defaults to `STS_SCOPE_REGISTRY` |
| `config.uts` | `{ issuer, jwks, scopeRegistry, revocation, bootstrap?, pat? }` (ports below) |
| `input` | A `Request`, its `Authorization` value, or `null` |
| `route` | `{ issuer: 'sts' \| 'uts', scope, org?, requiresSession? }`: exactly one issuer and one scope |
| `ctx` | `{ waitUntil, clientAddress }`: the request's own `waitUntil`; the client address, required when the config has `uts.pat` |

Issuers must be `https:` URLs; `http:` is accepted only on `localhost`, `127.0.0.1` and `[::1]`.

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

`warm(ctx)` starts, without waiting, the fetches a cold instance needs: the UTS bootstrap (or the
UTS key set when no bootstrap is configured) and the STS key set, in parallel, under
`ctx.waitUntil`. A later `verify` joins the fetches in flight. It does nothing once the caches hold
data.

## Ports

| Port | Who implements it | Contract |
|---|---|---|
| `JwksSource` `(signal) => Promise<{ body, age, oldestAge }>` | `httpJwksSource(issuer, fetcher?)` here; a service binding on Workers | `body` is the key-set JSON; the cache validates it (`keys[]`, Ed25519 OKP entries with a `kid`; other entries are skipped; a duplicate `kid` refuses the set). `age` and `oldestAge` are the response's `Age` and `Kilo-Key-Set-Oldest-Age` (`KEY_SET_OLDEST_AGE_HEADER`) in whole seconds, `null` when absent; `httpJwksSource` fails the fetch on a header that is not digits. A UTS set needs both, `age <= oldestAge`, or the refresh fails. An STS set counts a missing `age` as 0 and ignores `oldestAge`. Do not put a generic HTTP cache in front of the UTS key set |
| UTS key classes | Phase 3 (UTS publishes) | Token keys under `UTS_TOKEN_KID_PREFIX` (`uts-token-`), revocation-feed keys under `UTS_FEED_KID_PREFIX` (`uts-feed-`), both exported from this package. A feed-prefixed key never verifies a token from any issuer; a UTS token under any other `kid` is refused before any fetch; the feed accepts only feed-prefixed keys of the UTS set |
| `UtsScopeRegistry` `(audience, scope) => { requiresSession, patEligible } \| null` | Phase 3 | `null` for an unregistered scope |
| `RevocationFeedSource` `{ head(signal), list(listHash, signal) }` | Phase 3 (service binding on Workers, HTTPS on Vercel and Fly) | `head` returns the signed head as a compact JWS string; `list` returns the list bytes for that hash. The transport verifies nothing: the library verifies the head under a feed key and the list against the head hash (format below). Any rejection is a failed fetch |
| `UtsBootstrapSource` `(signal) => Promise<{ jwks, keyAges, head, list }>` | Phase 3 (the bootstrap endpoint) | One call: the UTS key-set body, its ages `keyAges: KeySetAges` = `{ newest, oldest }` (whole seconds at the feed Worker, `0 <= newest <= oldest`; the HTTPS JSON `key_ages`), a head and its list bytes, in the same formats. Used only while neither the UTS key set nor the feed holds data; it applies whole or not at all, and an answer without valid `keyAges` is a failed call. The keys count their age from `keyAges` and the start of the call, and never replace a held set that has newer keys |
| `PatLookup` `(hash, signal)` | Phase 3 | `hash` is the lowercase-hex SHA-256 of the PAT. Answers `found` (a `PatRecordSchema` record), `not_found` (unknown, revoked or expired), `rate_limited` or `unavailable` with `retryAfterSeconds` |
| `SharedPatCache` `{ get, put }` | The service: Workers Cache API or Vercel Runtime Cache | Opaque strings; errors count as a miss |
| `PatConfig.cacheKeys` `(ctx) => Promise<{ current, previous? }>` | The service: two `Secrets.get` calls on its own bundle | Read on each shared-cache read and write, so a rotation reaches a running instance; `current` signs, `current` and `previous` verify; a rejection is a miss or a skipped write |

### Revocation feed format

- **Head:** a compact JWS with protected header `{ alg: 'EdDSA', typ: 'kilo-feed-head+jwt', kid }`
  (`FEED_HEAD_TYPE`; `kid` under `uts-feed-`; no `crit` or `b64`) and payload
  `{ iat, list_hash }` (`FeedHeadPayloadSchema`): `iat` is when the feed object signed it, a JWT
  NumericDate in seconds; `list_hash` is the base64url SHA-256 of the list bytes.
- **List:** UTF-8 JSON (`RevocationListWireSchema`): `{ revoked_before: { <sub>: <seconds> },
  revoked_sids: [], revoked_kids: [], revoked_pat_ids: [], blocked_accounts: [] }`. Unknown fields
  are ignored.
- The library rejects a head older than the one it holds, a head over 30 s old, and a head more
  than 5 s in the future (the design 5.6 clock skew); a head up to 5 s ahead ages from its fetch
  time. It fetches the list only when `list_hash` changes.

## PAT format

This package owns the format; UTS mints with `createPatString()` and stores `hashPat(pat)`.

```
kilo_pat_<body: 43 chars><checksum: 6 chars>     58 characters
```

- body: 32 bytes from `crypto.getRandomValues`, base64url without padding, canonical (it decodes
  to 32 bytes and re-encodes to itself);
- checksum: CRC-32 (IEEE) of the ASCII text `kilo_pat_<body>`, as 4 big-endian bytes in base64url
  without padding.

`parsePat` checks prefix, length, alphabet, canonical body and checksum offline. Two encodings of
the same SHA-256 digest name a PAT:

- `hashPat(pat)`: lowercase hex, 64 characters. What UTS stores, the key of both cache layers and
  of the UTS lookup.
- `patReference(pat)`: the first 8 characters of the base64url digest. The token reference in logs
  and audit rows (design 8.2); never a lookup key.

## Section 7 rows

Code is in `src/verifier.ts` unless named; tests are table-driven, one `describe` per row.

| Row | Rule | Code | Tests |
|---|---|---|---|
| 1 Algorithm | `EdDSA` only, header names a `kid`; no `crit` or `b64` | `verifySignedToken`, `jws.ts` | `rows.test.ts` row 1 |
| 2 Signature | The JWKS key for that `kid`, Ed25519 only, over the bytes received (decoded once) | `verifySignedToken`, `jws.ts`, `jwks.ts` `importKeySet` | row 2; `jwks.test.ts` key-set validation |
| 3 Issuer | Exact `iss`, checked again on the verified claims; key only from that issuer's set; no feed key | `verifySignedToken`, one `KeySetCache` per issuer, kid prefixes | row 3 |
| 4 Audience | One string equal to this service; an array is refused | `AccessTokenClaimsSchema` (`sts-contracts`), `verifyStsToken`, `verifyUtsToken`, `verifyPat` | row 4; PAT record checks |
| 5 Type | `typ` is `at+jwt` | `verifySignedToken` | row 5 |
| 6 Time | `exp`, `iat`, `nbf` with 60 s skew | `timeFailure` | row 6 |
| 7 Identity | `sub`, `jti`, `client_id`; STS profile | claim schemas, `claimsReason` | row 7 |
| 8 Scope | Registered scope of this audience, equal to the route scope; PATs only for PAT-eligible scopes | `verifyStsToken`, `verifyUtsToken`, `verifyPat` | row 8; PAT record checks |
| 9 Organization | A present org equals the route org | `orgMatches` | row 9; PAT record checks |
| 10 Revocation | UTS: `revoked_before`, revoked `sid` and `kid`; STS: none (decision Q4) | `verifyUtsToken`, `revocation.ts` | row 10; `revocation.test.ts` |
| 11 Session | A session-bound route or scope needs a live `sid`; a PAT never qualifies | `verifyUtsToken`, `verifyPat` | row 11; PAT record checks |
| 12 PAT | Offline check, client address, two cache layers, feed override, fail-closed lookups | `pat-format.ts`, `pat.ts`, `verifyPat` | row 12; `pat.test.ts` |
| 13 Account | Blocked accounts from the feed; STS skips | `verifyUtsToken`, `verifyPat` | row 13; PAT record checks |
| 14 Issuer per route | One issuer per route; a PAT is a UTS credential | `dispatch`, `verifySignedToken` | row 14 |

Fail-closed and caching rules:

| Rule | Code | Tests |
|---|---|---|
| JWKS: 5-min set, background refresh after 4 min (±20 %), synchronous after expiry or cold. Both count from the newest keys' read: the fetch (or the bootstrap call) start minus `Age`; an STS set without `Age` counts from its fetch | `jwks.ts` | `jwks.test.ts` key-set lifetime; `key-ages.test.ts` a UTS set counts its lifetime and refresh from Age; an STS set |
| JWKS: the last good UTS set serves only while UTS is unreachable, up to 24 h after its oldest keys' read (`Kilo-Key-Set-Oldest-Age`), then 503. That limit is a refresh point: the first request past it refreshes at once, even inside a retry wait, and refuses only if that refresh fails. Unreachable means the refresh failed, or has not answered in 1 s (`JWKS_STALE_WAIT_MS`) and the last good set holds the `kid`; a `kid` it lacks waits for the whole 5 s fetch. An STS set never serves past its 5-minute lifetime | `jwks.ts` | the last good set while the issuer is unreachable; `key-ages.test.ts` the 24-hour limit |
| JWKS: a fetched set already past its refresh point, or with missing or malformed ages (UTS) or a malformed `Age` (STS), is a failed refresh; a stale set that still serves becomes the last good set. A set never replaces one with newer keys, so a late answer or a bootstrap never restarts an age | `jwks.ts` `answered`, `hold` | `key-ages.test.ts` |
| JWKS: retry wait 5 s, doubling per failure up to 60 s while the held set still serves; 5 s once none does; ±20 % jitter on each | `jwks.ts` | the last good set while the issuer is unreachable; missing key set; `key-ages.test.ts` jitter |
| JWKS: missing set is 503 with `Retry-After` | `jwks.ts` | missing key set |
| JWKS: unknown `kid` refreshes at most once per 5 min per set, also when the requests are cancelled | `jwks.ts` | unknown kid |
| Feed: background refresh 10 s after the last fetch, wait once the head is over 30 s old; 1 s fetch timeout | `revocation.ts` | `revocation.test.ts` request-driven revalidation |
| Feed: the library verifies each head under a feed key and each new list against its hash | `revocation.ts` `verifyFeedHead`, `parseRevocationList` | heads and lists that do not count |
| Feed: a head over 30 s old, more than 5 s in the future, or older than the held one counts as failed | `revocation.ts` | heads and lists that do not count; heads from the future |
| Feed: retry wait 5 s, doubling per failure up to 30 s while the copy still serves short tokens | `revocation.ts` | head-age limits while the feed is down |
| Feed: tokens up to 10 min accept a 10-min head; longer credentials refuse past 60 s, even cached | `maxHeadAgeForLifetime` | head-age limits while the feed is down |
| Cold start: one bootstrap call fills the UTS key set and the feed; `warm` starts it beside the STS key set | `bootstrap.ts`, `warm` | `bootstrap.test.ts` |
| PAT: malformed is 401 with no cache write | `verifyPat` | `pat.test.ts` offline check |
| PAT: no client address is 400 `invalid_request`, before any cache or feed read | `verifyPat` | the client address |
| PAT: 60 s positive / 30 s negative in the instance and in the shared cache, by full hash; HMAC keys read per access (current and previous); workload in the key | `pat.ts` | two cache layers; shared-cache keys from the bundle |
| PAT: the hash and the shared-cache read run alongside the feed read | `verifyPat`, `pat.ts` `prefetch` | the shared-cache read on a cold instance |
| PAT: feed entry overrides both layers | `verifyPat` | the feed entry for a PAT id overrides both layers |
| PAT: lookup failure is 503; an expired entry serves stale up to 10 min, refreshed by at most one background lookup at a time, only with a head under 60 s | `pat.ts`, `verifyPat` | fail-closed lookups |
| PAT: one lookup per hash; 429 above 20 uncached lookups/s per address, before the lookup; a 429 or 503 never evicts | `pat.ts` | merging and the per-address limit; fail-closed lookups |
| PAT: bounded bookkeeping (10,000 instance entries, failures and pending lookups; 10,000 tracked addresses, oldest first) | `pat.ts` | bounded bookkeeping |
| No promise shared across requests: owner + pollers, `waitUntil` hand-off | `flight.ts` | `runtime.test.ts` (real workerd: concurrent cold requests, one call each; `warm`) |
| A request cancelled mid-call does not stall others: after 1 s without its heartbeat, a key-set, feed or bootstrap call counts as failed (with its retry wait); a PAT lookup lets the next request make its own | `flight.ts` `abandoned` | `runtime.test.ts` races; the cancellation tests in each test file |

Error responses: no credential is 401 with `WWW-Authenticate: Bearer resource_metadata="…"`;
malformed, expired, revoked or wrong-issuer credentials, a missing `sid` on a session-bound route,
and a PAT on a session-bound route are 401 `invalid_token`; wrong audience or unknown scope is 403
`insufficient_scope` with the required scope in the body and the challenge; an org mismatch is 403
`org_mismatch`; a PAT without a client address is 400 `invalid_request`; a failed dependency (key
set, feed, bootstrap, PAT lookup, including a UTS 429 or 503) is 503 `temporarily_unavailable` with
`Retry-After`; the per-address PAT lookup limit is 429 `too_many_requests` with `Retry-After`.
Every failure carries `Cache-Control: no-store`.

## Checks

```sh
pnpm --filter @kilocode/verify typecheck
pnpm --filter @kilocode/verify lint
pnpm --filter @kilocode/verify test   # includes the workerd runtime test (wrangler)
```
