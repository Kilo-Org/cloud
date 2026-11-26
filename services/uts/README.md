# UTS: the user token service

UTS is the OAuth 2.1 authorization server for every token with a user subject. It runs as two
Cloudflare Workers:

| Worker | Package | Hostname (production / staging) | Placement | Serves |
|---|---|---|---|---|
| Mint Worker `uts` | `services/uts` | `uts.kiloapps.io` / `uts-staging.kiloapps.io` | `aws:eu-central-1` | Issuer metadata; later sign-in, token and account endpoints. Binds the signer, key-set shard and feed objects |
| Feed Worker `uts-feed` | `services/uts-feed` | `uts-feed.kiloapps.io` / `uts-feed-staging.kiloapps.io` | none | The UTS key set, the revocation feed and the bootstrap endpoint |

The issuer, key set URL and local ports of each environment live in
`@kilocode/uts-contracts` (`UTS_ENDPOINTS`); verifiers read them from there.

## Mint Worker

- `GET /.well-known/oauth-authorization-server` serves RFC 8414 metadata: `issuer` and `jwks_uri`
  (on the feed Worker) always; the token, revocation and introspection endpoints once the
  environment binds the identity store (`IDENTITY_STORE`); the authorization endpoint and the code
  grant once a sign-in hand-off is wired; the device grant once its hook is. An endpoint joins the
  document when it answers, so no listed endpoint returns 404.
- The OAuth endpoints (`src/oauth/`, see "OAuth endpoints") run in this fetch handler. Staging and
  production bind no identity store yet, so they serve none of them.
- Placement runs the fetch handler next to the identity store's primary in Frankfurt:
  `"placement": { "region": "aws:eu-central-1" }`, a Cloudflare placement hint
  (https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region), which
  runs the Worker in the data center with the lowest latency to that AWS region. Smart placement is
  not used: it places only after it has seen traffic from several locations, and it can leave a
  request where it arrived. Placement does not apply to RPC methods or named entrypoints, so token
  minting stays a fetch handler.
- The account API for PATs and org bot keys and the PAT probe route (`src/account/`, `src/pat/`,
  see "Account API, PATs and org bot keys") run in this fetch handler too, with RFC 9728
  protected-resource metadata at `/.well-known/oauth-protected-resource`; PAT lookups for verifiers
  run in the named entrypoint `PatLookup`.
- Traces stay off in every block: a trace records Durable Object storage calls, and the signer
  objects hold private keys. Logs stay on.

### Signer objects

`UtsSignerDO` has 16 instances, named `<environment>:signer:<00-15>`, created in the `eu`
jurisdiction with the `weur` location hint (local development runs unscoped). A grant's tokens are
signed by the object `signerForGrant(grantId)` picks: SHA-256 of the grant id, first 4 bytes,
modulo 16.

Each object:

- generates its own Ed25519 keys and keeps them in its KV storage, one record, never in SQL rows
  (a trace would record bound SQL values);
- exposes only its RPC methods `publicKeys`, `sign`, `signMany` and `removeKid` and the platform's
  `alarm`. Workers RPC serves every public method of the class, so every other member is
  `#`-private, and no RPC method returns or accepts a private key (`test/runtime/signer.test.ts`
  calls the other members through a stub and expects each call to fail);
- refuses to create keys under any other name or in any other jurisdiction than its environment's,
  and refuses stored keys in any object but that signer's object of its environment: the id must
  be the one the signer's name gives in the environment's jurisdiction, a check that needs no name
  on the id, so it also holds when an alarm starts the object. A refused object answers every call
  with `misconfigured`, a deploy error that no retry fixes;
- publishes the public halves under `uts-token-<signer>-<RFC 7638 thumbprint>`;
- signs with `sign(claims)`: a compact JWS with header `alg: EdDSA`, `typ: at+jwt`, `kid`. It refuses
  a claim set with another issuer or environment, an `iat` more than 60 seconds from now, an `exp`
  at or before now, or an `exp` more than 1 hour ahead, the longest UTS token lifetime.
  `src/keys/claims.ts` is the signer's admission check; the published claim contract is phase 2's
  `AccessTokenClaimsSchema` (`@kilocode/sts-contracts`), and every claim set the signer accepts
  also passes it. A mint signs its 1 to 8 tokens in one `signMany(claims[])` call: each claim set
  passes the same check, one refused set refuses the batch, and all tokens carry the same `kid`;
- rotates by alarm: a key signs for 30 days. Each rotation creates the next key at once, to sign
  30 days later, so every signer always publishes a current and a next key, and the next key is
  published at least 7 days before it signs (a new object publishes its first two keys at once, the
  second 30 days ahead). A retired key stays published for 1 hour and 10 minutes, until the last
  token it signed has been expired for 10 minutes. That is two alarms per 30-day cycle. A change
  whose alarm never ran (its retries ran out) is applied by the next `publicKeys`, `sign` or
  `signMany` call, and `publicKeys` also sets a lost alarm again;
- removes a key at once with `removeKid(kid)`, a direct call, not an alarm. A removed current key
  is replaced by the published next key, which verifiers already hold, and a new next key is
  created to sign 30 days later; a removed next key is replaced by a new one published at least 7
  days before it signs. When the signer's storage itself is exposed, remove the next key first and
  the current key second: the second removal signs with the key the first removal created.
  Verifiers hold that key once it has been in the key set for 5 minutes and 17 seconds (the feed
  Worker's 17 seconds plus the 5-minute `max-age`, while every signer read succeeds), so wait that
  long between the two removals, and before the second one check that the public key set
  (`/.well-known/jwks.json` on the feed Worker) lists the signer's new next `kid`; removing at once
  leaves that signer's new tokens unverifiable for up to that time. The result is
  the revocation-feed entry: verifiers reject the `kid` until `revokeUntil`. The object stores the
  entry with the key change and keeps it until `revokeUntil`, so a repeated call for the same `kid`
  (after a lost answer, or an alarm write that failed behind a stored removal) answers the same
  entry and changes nothing. The feed carries such an entry as kind `kid` in `uts.revocations`
  ("Revocation feed" below). No route calls `removeKid` yet: it stays unreachable until the
  operator route exists, which writes that entry, audits and alerts on each removal;
- logs each rotation and removal as `uts.signer.key_event` (`SignerKeyEvent`, public `kid`s only),
  the event the UTS audit pipeline will carry (design 8.3).

### The SignerKeys entrypoint and the key-set shards

`signerKeys()` on the named entrypoint `SignerKeys` (`UTS_SIGNER_KEYS_ENTRYPOINT`, in
`src/signer-keys.ts`) returns plain data (`SignerKeysReadSchema`): `{ status: 'refused' }`,
`{ status: 'misconfigured' }` when its key-set shard refused to load, or
`{ status: 'answered', answer }` where `answer` is `{ signers }`, every signer exactly once
(`SignerKeysAnswerSchema`): its keys with `readAt`, the time they were read from the signer
object, or its failure, `misconfigured` (the object refused to load) or `unavailable` (the call
failed after its retries). The feed Worker takes every signer that has keys.

The entrypoint does not read the signer objects itself. It asks one of 8 key-set shards,
`UtsKeySetDO` (`src/dos/UtsKeySetDO.ts`), named `<environment>:keyset:<0-7>` and created in the
`eu` jurisdiction with the `weur` hint, like the signer objects; a shard under another name or
outside its jurisdiction answers `misconfigured`. Each isolate draws its shard at random once, so
feed isolates spread evenly over the 8 shards. Each shard holds:

- a copy of its last combined answer, in memory, served for 2 seconds, with one read in flight; a
  request that needs that read polls for it. The 16 signer objects therefore see at most 8 reads
  per 2 seconds, however many feed isolates ask;
- every signer's last good keys, in memory and in its KV storage (public keys only). A signer whose
  call fails, or whose object refuses to load, answers those keys with their own `readAt` while
  they are under 24 hours old, and its failure after that; each failure is logged with the read
  time of the keys that stood in. The shard stores them when a signer's kids change and otherwise
  at most once per 10 minutes, so a restarted shard (a deploy, an eviction) still answers a failing
  signer's keys, with a `readAt` at most 10 minutes earlier than their last good read: a restart
  can shorten a hold, never lengthen it. A cold feed isolate whose shard also restarted therefore
  never builds a key set without them. Only a shard that has never read a signer, which happens
  only while a new deployment's shards make their first reads, has nothing to stand in for it.

Every signer call of a read, retries included, ends within 5 seconds, and every entrypoint call to
its shard, retries included, within 8 seconds, so a hung object cannot hold a read past the feed
Worker's 10-second read guard. Each RPC result, from a signer and from a shard, is copied out and
disposed.

It answers only a service binding to this entrypoint whose `props.caller` is the feed Worker's
deployed name for its own environment, and refuses every other binding, with another caller or
without props, before any shard call. A service binding delivers `props` to a named entrypoint, as
for the STS broker; a deployed mint Worker did not see them on its default entrypoint, either as a
plain handler object or as a `WorkerEntrypoint` class. The default entrypoint's fetch handler
serves no signer keys: a request to the old `/internal/signer-keys` path gets `404 not_found` like
any unknown path. Placement does not apply to a named entrypoint, so the entrypoint runs where the
feed Worker runs and makes one call to its shard in the EU per read.
`test/repo/worker-configs.test.ts` fails any Worker config outside the two UTS Workers that names a
UTS Durable Object class or binds the mint Worker, any feed binding of the mint Worker at an
entrypoint other than `SignerKeys` or `FeedReads` (each once per block) or whose caller is not the
feed block's own name, any `FeedReader` binding whose caller is not its own block's deployed name,
any config but `wrangler.dev.jsonc` that runs the development entry, and any drift in the UTS
configs (names, `eu` jurisdiction, placement, traces, the development config's deploy guard).

### Revocation feed

Design 5.6. Every revoking statement (`/revoke`, a second use of a code, a reused third-party
token) writes its `uts.revocations` rows and returns them in the same statement
(`uts.feed_entries_of_statement()`, migration 0006; one index probe, skipped on the issued path).
After the commit the Worker writes them to both feed objects in parallel
(`src/revocation/publish.ts`) and goes on once one confirms; each write ends within 2 seconds.
`/revoke` answers 503 when neither confirms (the revocation stands, the backfill adds it); the
reuse paths answer as before. A failed publish logs kinds and counts, never ids.

The two feed objects (`src/feed/UtsFeedDO.ts`) are named `<environment>:feed:<0|1>`, in the `eu`
jurisdiction, feed 0 with the `weur` hint and feed 1 with `eeur`; only this Worker binds them, so
only it writes entries. Each one:

- keeps its entries in memory only (`src/feed/ledger.ts`); the identity store is the record;
- every 5 seconds (alarm) reads, as the app login, the entries revoked in the last 20 minutes,
  or every live entry after a restart or a gap over 15 minutes (`src/revocation/store.ts`), drops
  expired entries, and rotates its feed key;
- signs a head (`typ: kilo-feed-head+jwt`, `{iat, list_hash}`) with its own Ed25519 key, kept in
  its KV storage with the signer's 30-day rotation and published next key (`uts-feed-<n>-<thumbprint>`).
  `iat` is the start of its last good backfill, so every revocation committed before it is in the
  list; a new head is signed for each new list or backfill, and none once that backfill is 30
  seconds old or the object holds more than 50,000 entries. A backfill is given up after 10
  seconds (5 for the connect); expired entries leave the list at most once a minute;
- serves its current list, and each list it replaced in the last 30 seconds (at most 64 lists and
  16 MB of old list text, the oldest dropped first), by hash;
- answers a publish with whether it vouches for its list; a revoke counts as published only when a
  vouching object took its entries, and logs `uts.feed.publish_unvouched` (an alert: the backfill
  is failing) when only objects that vouch for nothing took them. Every write to
  `uts.revocations` is dated with its transaction time by a trigger (migration 0006), which keeps
  an expiry an update sets.

The list is canonical JSON: subject → `revoked_before` (whole seconds, rounded down); grant, third-party
family, session and sandbox grant → `revoked_sids`; PAT and bot key → `revoked_pat_ids`; `kid` →
`revoked_kids`; `blocked_account` → `blocked_accounts`. A PAT entry stays 15 minutes; a grant or
family entry 20 minutes. The feed objects' public keys reach the key set through the key-set
shards, beside the signers'. The feed Worker reads heads and lists through the `FeedReads`
entrypoint, which answers only the feed Worker's `props.caller` and gives each object call 800 ms.
Without an `IDENTITY_STORE` binding (staging and production today) no backfill runs, so the objects
sign no head and the feed answers `unavailable`.

## Local development

```sh
cd services/uts && pnpm exec wrangler dev -c wrangler.dev.jsonc --persist-to ../../.wrangler-uts
cd services/uts-feed && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
curl -s http://localhost:8801/.well-known/jwks.json
```

The local revocation-feed run (`scripts/feed-e2e.ts`) needs the mint Worker with `IDENTITY_STORE`
(below), the feed Worker and the verifier Worker of `services/uts-feed/test/fixtures/e2e` running
together, with `UTS_E2E_BASE_URL`, `UTS_E2E_FEED_URL`, `UTS_E2E_READER_URL` and
`UTS_E2E_ADMIN_URL` set. It checks that a revoke reaches the feed within 20 seconds, that the
backfill adds an entry no publish carried, that the feed serves from feed object 1 while
`POST /__dev/feed/stop` (development only, `src/dev-feed.ts`) stops feed object 0 for 90 seconds,
that the head stays under 20 seconds old, and that every head verifies under a feed key of the key
set, over HTTPS and over the `FeedReader` binding.

Development only: `POST http://localhost:8800/__dev/sign` with `{ "grantId": "...", "claims": {...} }`
signs a claim set through the signer the grant picks. The route lives in `src/dev-index.ts`, which
only `wrangler.dev.jsonc` runs, and the claim set must name the development issuer. That config
cannot be deployed: its build command, which Wrangler runs before `dev`, `deploy` and `versions
upload` with `WRANGLER_COMMAND` set to the command, fails for every command but `dev`, and
`test/repo` fails any other config that runs the development entry. `wrangler.jsonc` holds only the
production and staging blocks. The same entry wires the development sign-in hand-off
(`src/dev.ts`): it approves every authorization request for the synthetic account `dev:uts-local`.

The local config binds the local identity store as `IDENTITY_STORE` (login `uts_app_a`) and
`IDENTITY_STORE_PAT` (login `uts_pat_a`). The UTS logins have no password in the repository, so
give both logins one and pass the URLs to wrangler
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_PAT` for the second):

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE=postgres://uts_app_a:<password>@127.0.0.1:55432/uts \
  pnpm exec wrangler dev -c wrangler.dev.jsonc
UTS_E2E_BASE_URL=http://127.0.0.1:8800/ UTS_E2E_ADMIN_URL=... UTS_E2E_APP_URL=... \
  pnpm exec tsx scripts/oauth-e2e.ts
```

`scripts/oauth-e2e.ts` runs code, token, refresh, a replayed proof (also at another grant of the
same device key), a code-exchange retry and two concurrent exchanges of one code, third-party
rotation, reuse (the family is revoked), a blocked third-party client, a streamed oversized body,
revoke and introspect, prints the audit rows (token ids only), checks that no token value reached
an audit row, and times the mint path. Its first-party steps use `kilo-cli` scopes
(`kilo-api:profile.read`, `uts:pats.manage`); its third-party steps use `fixture:read`, a
development fixture scope (`src/scopes/development-fixtures.ts`) that only the development entry
adds on top of the registry, since the registry holds no third-party-safe scope yet. `test/repo`
checks that the deployed entry's imports never reach the fixtures and that `UTS_SCOPE_REGISTRY`
holds no `fixture:*` scope. `scripts/pat-e2e.ts` (`UTS_E2E_BASE_URL`,
`UTS_E2E_ADMIN_URL`) signs the CLI in, creates a PAT, uses it on the probe route, lists and
revokes it and times until the probe refuses it, creates, lists and revokes an org bot key, shows
the tier B refusal once the sign-in is 11 minutes old, refuses a web-app-only scope to the CLI at
`/authorize`, refuses an owner-or-member scope to an org admin at `/authorize`, mints it for a
member with the `org` claim and refuses its refresh once the member is an admin again (neither
refusal writes an audit row; the development hand-off binds the `org` the request names), checks
each token's lifetime in the audit rows, and checks that no credential value or hash reached an
audit row. It mints only scopes the registry allows `kilo-cli`.

## OAuth endpoints

| Endpoint | Behaviour | SQL |
|---|---|---|
| `GET /authorize` | Code with PKCE `S256`; `resource` is `urn:kilo:service:<audience>`; a first-party client binds the code to `dpop_jkt`; `state` and `iss` (RFC 9207) go back; a bad client or redirect URI is shown, never redirected; sign-in and consent come from the `AuthorizationHandoff` hook | `uts.issue_authorization_code` |
| `POST /token` `authorization_code` | First party: DPoP proof, device session and `kilo_rt_` grant (desktop 30 days idle, 180 days total; mobile 60 and 365). Third party: grant family and its first rotating token. A first-party retry of the same request while the code's 60-second lifetime lasts gets the same grant and the same refresh token (below); any other second use of a code, a third-party one included, revokes the grant | `uts.exchange_authorization_code` |
| `POST /token` `refresh_token` | First party: DPoP proof matched to the grant key; last use moves at most once per hour. Third party: rotation with no grace; any later use of a replaced token revokes the family and writes a feed entry, until the family's 90-day end | `uts.refresh_first_party`, `uts.refresh_third_party` |
| `POST /revoke` | RFC 7009; revokes the grant or family, writes the feed entry; a token issued to another client answers 200 like an unknown token and writes a denied row (at most one per grant per minute); an access token is `unsupported_token_type` | `uts.revoke_refresh_token` |
| `POST /introspect` | RFC 7662 for refresh credentials, to their own client (first party with a DPoP proof); `active: false` for anything else | `uts.introspect_refresh_token` (no audit row) |

Each call verifies at most one DPoP proof before the grant read. The grant statement records the
proof's `jti` in `uts.dpop_proofs` under the RFC 7638 thumbprint of the proof's key (primary key
`jkt` and `jti`), so a second use of the proof fails that statement with `dpop_replay`, which
answers `invalid_dpop_proof`. A proof names its key, method and URL, not a grant, so its `jti`
is scoped to the key: a proof accepted for one grant of a device key is refused at every other
grant of that key, and the `htu` check keeps it to one endpoint. A row stays 121 seconds: a
proof's `iat` is at most 60 seconds ahead and it is accepted until 60 seconds after its `iat`. The
statement records a `jti` only once the grant and the key match, so a caller without the device
key adds no row. A first-party refresh grant names its grant id (`kilo_rt_<grant id><32-byte
secret>`), so the endpoint knows the grant and its signer before the statement. One call mints one
access token per scope, up to 8, each with one audience; one `signMany` call to the signer the
grant id picks signs all of them, and `issued_tokens` lists them. The claims are exactly
`iss exp aud sub client_id iat jti scope org act req sid auth_time amr env`
(`UtsAccessTokenClaimsSchema`). A dependency that does not answer gives 503 with `Retry-After`; a
failure no retry fixes gives 500.

The tokens are signed after the statement commits. When signing fails (or the response is lost),
a first-party client sends the same code exchange again with a new DPoP proof. While the code's
60-second lifetime lasts, the same client, redirect URI, PKCE verifier and DPoP key get the grant
the first attempt created, the same refresh token and new access tokens, and the code does not
count as reused: the device key and a fresh proof show the same client instance. The refresh
token's secret is the SHA-256 of a fixed label, the code and the verifier
(`firstPartyRefreshTokenOfExchange`), so every attempt presents the hash the grant holds and no
attempt replaces it: when the first answer also reaches the client, after the retry's or before
it, both carry the one valid refresh token. A retry with another hash is refused and changes
nothing. The store holds only the SHA-256 of the code and of the verifier, so stored data does not
give the secret. A third-party client has only its PKCE verifier, so any second use
of its code revokes the family (OAuth 2.1 section 4.1.2); a third-party client that lost its
response authorizes again, and its consent stands, so it sees no consent screen. A consumed code
with another client, redirect URI, verifier or key, or after its lifetime, still revokes the
grant. The audit row of a mint lists the `jti` of each token the call is about to sign, and each
token's lifetime in the same order (`tokenLifetimeSeconds`, `uts.token_lifetimes`): after a
failed signing no token carries those ids, and the retry's row (`token.issued`, `rotation`
`code_retry`) lists the ids of the tokens it signs.

A blocked third-party client (`uts.third_party_clients.status`) gets nothing more: the code
exchange, the refresh read and the introspection read each check the client's status, so the
status change alone stops it at once. `uts.maintain_oauth_rows()` then revokes the client's live
families, at most 5,000 per call, each with its feed entry (`revoke_reason` `client_blocked`), so
its live access tokens stop at the verifiers within one cron cycle plus feed propagation (they
expire within 10 minutes anyway). The block itself stays one short statement whatever the client's
family count. An unblock waits for those batches: the trigger
`third_party_clients_refuse_early_unblock` refuses `blocked` to `active` while the client still has
an active family (one probe of `third_party_grant_families_client_idx`), with SQLSTATE 55006 and
"client still has active families; maintenance is ending them, retry after it reports
blocked_client_families 0". At 5,000 families per call a client with N families stays blocked for
about ceil(N / 5,000) cron cycles (about 20 at 100k); the operator path retries on that refusal
rather than treating it as a failure. Once it succeeds, no family comes back. The batches write
no audit row; the operator action that blocks or unblocks the client writes it.

## Account API, PATs and org bot keys

Every account route takes a UTS access token for the `uts` audience with the route's scope and a
`sid` (`src/account/bearer.ts`): `EdDSA` under a `uts-token-` key that the isolate's key-set shard
holds (one Durable Object call per request), `typ` `at+jwt`, the issuer, 60 seconds of skew and
the claim profile, and a client that the scope registry allows for the scope (today `kilo-cli`
only). A PAT names no session, so it is refused there. Each action is one statement that reads the
grant the `sid` names and its device session, so a revoked grant, an ended session or a blocked
account fails at once, with no feed lookup.

`/authorize` and `/token` apply the scope registry (`src/scopes/policy.ts`; the endpoints take it
as a dependency: `utsScopeEntry` in every deployed Worker, plus the `fixture:*` scopes in the
development entry only):

- **Client:** a scope that is unregistered, whose `allowedClients` does not name the first-party
  client, or that is not third-party-safe for a third-party client is refused: at `/authorize`
  with `invalid_scope` before the hand-off, so a code or grant only ever holds scopes its client
  may hold; at `/token` with `invalid_scope` when requested (before the statement) and when
  minted (before signing; only a registry change after the grant can reach this).
- **Organization:** a scope that needs the `org` claim is refused at `/authorize` without an
  organization, before a code is stored. A scope limited to listed membership roles
  (`subjects.roles`) is refused inside the code and mint statements when the caller's role in the
  bound organization is another (migration 0005, `uts.scope_org_roles` mirrors the registry and a
  DB test holds them equal): the code statement and the exchange answer `invalid_scope` with no
  code, session, grant or audit row (the exchange leaves the code unused), a first-party refresh
  answers `invalid_scope` without touching the grant or writing a row, and a third-party refresh,
  which reads no role, refuses every such scope. Each refresh reads the role again. The statements
  also return the role, and `/token` checks both again before signing.

Resource indicators (RFC 8707) are exact strings: `urn:kilo:service:<audience>`, or an origin of
the environment's table in `UTS_RESOURCE_ORIGINS` (`@kilocode/uts-contracts`), which maps each
origin to its audience. Production lists the web app (`kilo-api`), the issuer (`uts`), the
`*.kiloapps.io` origins of ai-attribution, session-sync, notifications, events and chat, and the
`*.kilosessions.ai` origins of session ingest, data export, the git token service and the cloud
agent; staging lists only `https://staging-app.kilo.ai` and its issuer; development lists loopback
origins only. An origin in the table does not activate a service: the service proves its caller
first. `protectedResourceMetadataFor` builds a resource's RFC 9728 metadata from the same table.
Another environment's origin, a path, a trailing slash or a query answers `invalid_target`.

| Route | Scope | Behaviour | SQL |
|---|---|---|---|
| `POST /account/pats` | `uts:pats.manage` | Tier B gate (a sign-in within 10 minutes, or a passkey step-up of the same session); the scope must be registered and PAT-eligible; 90 days unless `expires_in_days` (1 to 365) says otherwise; at most 100 live PATs per account; the PAT appears once in the answer. A gate refusal answers 401 with the RFC 9470 challenge (`insufficient_user_authentication`, `max_age="600"`) | `uts.create_pat` |
| `GET /account/pats` | `uts:pats.manage` | The live PATs, newest first, with the last four characters | `uts.list_pats` |
| `DELETE /account/pats/<id>` | `uts:pats.manage` | Revokes; writes a 15-minute feed entry; 204 also when already revoked | `uts.revoke_pat` |
| `POST /account/orgs/<org>/bot-keys` | `uts:bot-keys.manage` | An owner or admin of the organization; tier B gate; at most 100 live keys per organization (a key flagged within 7 days counts) | `uts.create_bot_key` |
| `GET /account/orgs/<org>/bot-keys` | `uts:bot-keys.manage` | The live keys; a flagged key shows when it stops | `uts.list_bot_keys` |
| `DELETE /account/orgs/<org>/bot-keys/<id>` | `uts:bot-keys.manage` | Revokes; 15-minute feed entry | `uts.revoke_bot_key` |
| `POST /account/orgs/<org>/bot-keys/<id>/keep` | `uts:bot-keys.manage` | Keeps a flagged key before its 7-day cutoff; tier B gate, since keeping restores long-lived access | `uts.keep_bot_key` |
| `GET /probe/pat` | `uts:probe.read` on the PAT | Answers whose PAT it is: the offline format check, a client address, 20 lookups per second per address per isolate, then the lookup with no cache, so a revoked PAT fails on its next use | `uts.lookup_pat` (PAT config) |

- A create writes the credential, its gate pass (consumed by that one row), the owner's in-app
  notice and the audit row in one statement. The push and email notice goes through the
  `CredentialNotices` port after the statement; slice 3.8 (security notices) implements the port,
  and until then only the in-app notice is written.
- A create that names an organization, and a keep, lock the caller's membership row `FOR SHARE`
  (`uts.lock_org_role`), so a concurrent `uts.remove_org_member` waits and then revokes or flags
  the new credential, or the create waits for the removal and is refused. The 100-credential caps
  hold under concurrent creates: the account's row lock orders PAT creates, a transaction advisory
  lock per organization orders bot key creates.
- Last use of PATs and bot keys is not written yet: `last_used_at` stays null until the lookup
  carries the client network (design 5.3 hourly last use and new-network audit).
- PATs and bot keys are `kilo_pat_` or `kilo_bot_` plus 32 random bytes in base64url plus a
  6-character CRC-32 checksum (`src/pat/format.ts`, the format `@kilocode/verify` parses). The
  identity store keeps the SHA-256 and the last four characters; audit rows name a credential by
  its id and `uts.credential_reference` of the hash, never by its value, its hash or its name.
- A refused gate writes at most one `ai.kilo.uts.gate.refused` row per grant per minute.
- `uts.remove_org_member` applies a membership-removed event: it revokes the member's org-bound
  PATs and grants, flags the bot keys the member created (they stop 7 days later unless an admin
  keeps them) and gives each owner and admin one notice; a stale event changes nothing.
- `uts.open_tier_a_gate_pass` opens a tier A pass for the sign-in method and email actions: a
  sign-in within 10 minutes with the account's strongest method, the emailed code (and the code to
  the new address for an email change, which must be another address), and no method added in the
  last 24 hours for a removal or an email change. Each tier A code row records whether it went to
  the primary address (`current`) or the new one (`new`), and each code counts only in its own
  role. The service that sends a `current` code, and the caller of the gate, hash the account's
  primary address itself, never an address from the request.
- `PatLookup` (`src/pat/entrypoint.ts`) is the lookup port of `@kilocode/verify` for Worker
  verifiers: the lowercase-hex SHA-256 in, `found`, `not_found`, `rate_limited` or `unavailable`
  out (`UtsPatLookupResultSchema`). It answers only callers its environment lists
  (`PAT_LOOKUP_CALLERS`), runs at most min(100, 3 × `PAT_LOOKUP_CONNECTIONS`) lookups at once per
  isolate (see "Deploys"), and sends one statement through the PAT config. The probe route uses the
  same cap.
- The scope registry is `UTS_SCOPE_REGISTRY` in `@kilocode/uts-contracts`; `test/repo` checks every
  entry against the rules of design 5.3 (no PAT carries a privileged, step-up, staff,
  credential-changing or session-bound scope; a privileged scope needs a step-up and lives at most
  5 minutes; a scope needs the `org` claim exactly when its subjects are organization members, in
  any role or in listed roles; no delegated token carries a privileged, step-up, staff or
  credential-changing scope; a scope limited to listed roles is neither third-party-safe nor
  PAT-eligible). It lists the account API scopes (`uts:pats.manage`, `uts:bot-keys.manage`,
  session-bound), `uts:probe.read`, `uts:security.read` (the web app's security view,
  session-bound), `uts:browser-session.read` (the web app's bootstrap at its code exchange,
  session-bound, no account change), `kilo-api:profile.read` (CLI and PATs), the CLI's Kilo API
  route scopes
  (`kilo-api:notifications.read`, `organizations.read`, `auto-routing.read`; session-bound
  `organizations.write` for organization members, `auto-routing.write`, `sessions.write`,
  `shell-security.analyze`, `feedback.write`, `credits.redeem`; no generic write scope), and the
  phase 4 service scopes of session ingest, cloud agent, data export, the git token service,
  ai-attribution (org owners and members), session sync, notifications, events and chat. The
  account API serves only session-bound scopes, and refuses a token without `sid`. The mint gives
  each access token its scope's registered maximum lifetime when shorter than 10 minutes (5
  minutes for the export and disconnect scopes).
- First-party clients are `UTS_FIRST_PARTY_CLIENTS` in `@kilocode/uts-contracts`: `kilo-cli` (public
  native, loopback `/callback`), `kilo-web`, the web BFF (confidential, `private_key_jwt`, redirect
  URIs `<app origin>/api/auth/uts/callback` per environment), and `kilo-mobile` (public native,
  private-use redirect, device attestation required). The authorization endpoint serves only the
  clients in `src/oauth/clients.ts`: every OAuth endpoint treats `kilo-web` as unknown until the
  token endpoint verifies a private-key JWT. `test/repo` holds each confidential client to
  `private_key_jwt` and exact HTTPS redirect URIs with a path (a loopback origin in development
  only), each desktop client to a loopback path, and each mobile client to one reverse-domain
  private-use URI and attestation.

## Tests

- `pnpm test:workers`: unit and runtime tests in the Workers pool (`vitest.config.ts`,
  `wrangler.test.jsonc`): key lifecycle with time travel, signing and verification with `jose`, key
  persistence across restarts, rotation by alarm, an overdue rotation and a lost alarm, emergency
  removal by direct call, the RPC surface, the SignerKeys entrypoint over real service bindings
  (its caller check) and the key-set shards (their names, their 2-second copy with one read in
  flight, at most one signer read per shard per 2 seconds under many concurrent isolates, and the
  held keys of a failed signer), metadata, DPoP proofs, the signer's batch signing, every OAuth
  endpoint against a recording grant store and feed publisher, the feed objects (keys kept across
  restarts, no head without a good backfill, refused names), the publisher and the `FeedReads`
  caller check, the PAT and bot key format against fixed vectors, every account route against a
  recording account store with tokens from the real signers, the probe route, the PAT lookup and
  its entrypoint over real service bindings; unit tests cover feed entries, list serialization and
  the feed ledger.
- `pnpm test:repo`: the repository config check and the scope registry check (`test/repo`), with
  no database.
- `pnpm test` runs both; neither needs Postgres. `pnpm test:postgres` runs the identity store
  tests (`test/db`, see "Local database and tests"), the OAuth grant functions, the DPoP `jti`
  check and the account functions (gates, PATs, bot keys, member removal) included.

## Staging proof run (before merge)

workerd implements neither jurisdictions nor placement, so these checks run on staging before the
pull request merges (design 2.4, 5.7). The pull request stays held, out of the merge queue, until
the results of all three checks are in its body. Deploy both Workers from the branch, the mint
Worker first, and start a tail of the mint Worker before the first key-set read, which creates all
16 signer objects:

```sh
cd services/uts && pnpm exec wrangler deploy --env staging
cd ../uts-feed && pnpm exec wrangler deploy --env staging
cd ../uts
pnpm exec wrangler tail uts-staging --format json > /tmp/uts-staging-tail.json &
curl -sS -D - https://uts-feed-staging.kiloapps.io/.well-known/jwks.json -o /tmp/jwks.json
jq '.keys | length' /tmp/jwks.json
curl -sS https://uts-staging.kiloapps.io/.well-known/oauth-authorization-server
```

Expect `200`, `cache-control: max-age=300, stale-if-error=<86100 or less>`, `32`, and metadata
naming `https://uts-staging.kiloapps.io` and the feed key set.

1. **`eu` jurisdiction and location hint together (design 5.7).** Each signer object logs
   `uts.signer.bootstrapped` once, when it creates its keys, and each key-set shard logs
   `uts.key_set_shard.started` once per start, both with the jurisdiction and the data center it
   runs in; an object outside `eu` refuses, and the key set answers 500:

   ```sh
   jq -r '.logs[]?.message[]? | select(type == "string" and (contains("uts.signer.bootstrapped") or contains("uts.key_set_shard.started")))' /tmp/uts-staging-tail.json | jq -c '{event, signer, shard, jurisdiction, colo}'
   ```

   Expect 16 signer lines and a line for each shard the read reached (8 once enough feed isolates
   have asked), each `"jurisdiction":"eu"` with a `colo` in the EU. The jurisdiction is enforced;
   the `weur` hint is best effort, so an object can land in another EU data center
   (https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint).
   Record every colo in the pull request.

2. **Key persistence across real restarts (design 5.7).** A deploy restarts every object. Record
   the kids, redeploy the mint Worker, wait past the feed Worker's 17-second window, and compare;
   the tail must show no new `uts.signer.bootstrapped` line:

   ```sh
   jq -r '.keys[].kid' /tmp/jwks.json | sort > /tmp/kids-before
   pnpm exec wrangler deploy --env staging
   sleep 20
   curl -sS https://uts-feed-staging.kiloapps.io/.well-known/jwks.json | jq -r '.keys[].kid' | sort | diff /tmp/kids-before - && echo same
   ```

3. **The mint path runs in the placed region (design 5.2).** Cloudflare adds a `cf-placement`
   header (`remote-<colo>` or `local-<colo>`) to the responses of a placed Worker's fetch handler.
   Read it from the public metadata response:

   ```sh
   curl -sS -o /dev/null -D - https://uts-staging.kiloapps.io/.well-known/oauth-authorization-server | grep -i '^cf-placement'
   ```

   Expect `remote-FRA` (or `local-FRA` for a request that entered in Frankfurt). The signer-keys
   read is outside this check: it runs on the `SignerKeys` named entrypoint, which placement does
   not cover, so it runs where the feed Worker runs. The key-set request above proves it answers
   the feed Worker (`36` keys: 32 token keys and 4 feed keys).

4. **The mint path's p95 under placement is a staging gate (design 3, 5.2).** No environment binds
   the identity store yet, so this branch measures the mint statement and `POST /token` only
   through local `wrangler dev`. The slice that binds the staging Hyperdrive config must measure
   the server-side p95 of `POST /token` refresh in staging, with placement, the production-shaped
   Hyperdrive pool and the signer objects in their EU data center, and block its merge until the
   p95 is under 150 ms.

## Deploys

Both Workers deploy through `.github/workflows/deploy-workers.yml`, which discovers every
`services/*/wrangler.jsonc`. The feed Worker's service binding names the mint Worker, so when both
change, as on the first deploy of an environment, detection takes them out of the parallel matrix:
the `deploy-uts` job deploys `services/uts`, and `deploy-uts-feed-after-uts` deploys
`services/uts-feed` only after it succeeds (`scripts/deployment-workflows.test.mjs` checks the
order). A change to only one of them deploys in the matrix. The signer-keys answer carries the feed
objects' keys in an optional `feeds` field for one release, so either Worker can deploy or roll back
alone. Every grant statement calls `uts.feed_entries_of_statement()`, so apply migration 0006 to an
environment's identity store before that environment binds `IDENTITY_STORE`; the code exchange,
third-party refresh and `/revoke` fail until it is applied.

Provisioning the identity store's Hyperdrive configs for an environment: the mint Worker's var
`PAT_LOOKUP_CONNECTIONS` holds the PAT lookup config's (`IDENTITY_STORE_PAT`) connection limit, and
each isolate runs at most min(100, 3 × `PAT_LOOKUP_CONNECTIONS`) PAT lookups at once
(`patLookupsInFlight` in `src/env.ts`, design 3, "PAT lookups"). Staging sets 12 (cap 36);
production sets 32 (cap 96), the PAT config's 20 percent of `max_connections` 160. A change to the
config's connection limit changes the var in the same deploy. Staging and production refuse to
start without a valid var; development may leave it out (cap 100).

## Identity store

UTS keeps its credential state in a dedicated Postgres database, the identity store. Only UTS binds
its Hyperdrive configs, and those configs run with caching disabled.

### Layout

| Path | Contents |
|---|---|
| `migrations/` | Ordered SQL migrations, `NNNN_name.sql` |
| `scripts/migrator.ts` | Applies the migrations and records each file's SHA-256 |
| `scripts/migrate.ts` | Command-line entry point for the migrator |
| `scripts/connection.ts` | Connection rules for the admin login: plaintext to loopback only, otherwise verified TLS |
| `scripts/platform-access.ts`, `scripts/check-platform-access.ts` | Deploy-time check of the platform roles |
| `scripts/local-db.sh` | Local Postgres 17 container for development and tests |
| `src/db/` | Worker access through Hyperdrive with `pg`: client, row schemas, enums, PAT lookups |
| `test/db/` | Node tests that run against the local Postgres |

### Schemas and roles

| Schema | Owner | Contents |
|---|---|---|
| `uts` | `uts_owner` | Every table, type and function |
| `uts_read` | `uts_owner` | Read-only account views without hashes, keys or client addresses |
| `uts_migrations` | admin login | The migrator's record of applied files |

| Role | Logins | Hyperdrive config | Privileges |
|---|---|---|---|
| `uts_owner` | none | none | Owns the objects; the admin login acts as it during migrations. Holds the privileges of every UTS login (no SET), so `uts.end_long_transactions()` can end their sessions |
| `uts_app` | `uts_app_a`, `uts_app_b` | Primary: mint, sign-in, refresh, revoke, account API, audit relay | DML on the ungated credential tables; on gated rows (CI trust policies, third-party consents, device approvals) SELECT, DELETE and UPDATE of lifecycle columns only; PATs, org bot keys and gate passes SELECT only, written only through the account functions (migration 0005); codes, grants, device sessions, third-party families and tokens, revocations and DPoP proof `jti`s only through the OAuth functions, keeping SELECT on them; INSERT on chosen audit columns and SELECT on audit rows; SELECT on relay watermarks, which it moves only through `uts.advance_audit_watermark()`; `uts.maintain_audit_partitions()`, `uts.maintain_oauth_rows()` and `uts.end_long_transactions()` |
| `uts_pat` | `uts_pat_a`, `uts_pat_b` | PAT lookups | `uts.lookup_pat(bytea)` and `uts.lookup_bot_key(bytea)` only |
| `uts_reader` | `uts_reader_a`, `uts_reader_b` | Replica: account views | SELECT on the `uts_read` views; read-only transactions by default |

Each group has two logins. UTS rotates the password of the idle login and then switches each
Hyperdrive config to it, so the login in use never changes. Every login ends a transaction that
stays idle for 10 seconds (`idle_in_transaction_session_timeout`) or lasts 10 seconds
(`transaction_timeout`), and cancels a statement that runs for 5 seconds (`statement_timeout`), so
one stuck session or one long statement cannot hold back the audit relay. The database itself sets
the same idle limit for every other session (admin, migration, dashboard). These are defaults that
a session can change for itself, so they bound mistakes only. `uts.end_long_transactions()` bounds a
session that changes them: it ends every session of a UTS login whose transaction started more than
30 seconds ago, a limit the caller cannot change. The audit relay slice's minute cron and each of
its relay runs will call it before they read; nothing calls it in this package yet, so that bound
holds only once the relay lands (then about 35 seconds). The relay's horizon is the oldest open
transaction of the whole server, so the alert on an unrelayed row older than 60 seconds covers
sessions of other logins and in other databases.

### Platform roles

The UTS role matrix does not cover the roles the platform brings. `PUBLIC` keeps `CONNECT` on the
database but has no `TEMP`. Members of `pg_read_all_data` and `pg_write_all_data` can read or write
every table, so a deploy runs `pnpm db:check-access` (`scripts/check-platform-access.ts`) with the
migration connection. It lists the members of both roles and fails when `anon`, `authenticated` or
`service_role` holds any privilege on `uts`, `uts_read` or `uts_migrations`, or on anything in them,
whether granted directly, through `PUBLIC` or through an inherited role. It checks every role a
platform role can switch to with `SET ROLE` the same way, since a membership with `SET TRUE,
INHERIT FALSE` passes on no privilege until the session switches, and reports such a privilege as
`... through SET ROLE <role>`.

### Rules for statements

- A Worker sends one SQL statement per call and never opens a multi-statement transaction through
  Hyperdrive. A mint, refresh or revoke is one statement that calls a stored function, which writes
  the credential row and its audit row together.
- Opaque values (refresh grants, PATs, bot keys, codes, tickets, session cookies) are stored only as
  32-byte hashes. A PAT or org bot key also keeps its last four characters for display; its prefix
  (`kilo_pat_`, `kilo_bot_`) is fixed by its table, so no column stores it.
- Short secrets get a keyed hash (HMAC-SHA-256) under a key that only UTS holds: email codes, email
  addresses in code and limit rows, and RFC 8628 device user codes, which are short enough that a
  plain SHA-256 could be reversed offline.
- Each lifecycle has one status enum, and a CHECK constraint ties every status to the columns it
  needs. Lifetimes from design section 5.3 are CHECK constraints too.
- A gate pass serves one action of its own account once: each table that records a gated action
  holds a constant `gate_pass_action` column, a foreign key on (pass, account, action) and a unique
  pass id. A pass is never swept while a credential refers to it: those foreign keys refuse the
  delete, and an org bot key lets go of its pass only once it is flagged, kept or revoked.
- No login role writes a gate pass or a gated row. A tier B gate is decided inside the statement
  that writes the credential: `uts.write_gated_pat` and `uts.write_gated_bot_key` compute the
  checks the caller's session meets now (`uts.tier_b_checks`: a sign-in or a passkey step-up of
  that session within 10 minutes), then write the pass already consumed and the credential that
  names it in one statement. No statement takes a pass id from its caller, so an expired, used or
  released pass can serve nothing. These write steps have no grant; the account API's SECURITY
  DEFINER statements `uts.create_pat` and `uts.create_bot_key` (migration 0005) call them and
  write the audit row and the notice in the same statement. They check the organization's SSO
  rule before the write step, without a lock, so the write step takes the account row lock before
  any membership lock. Only PATs and org bot keys have a write step here: the write paths for CI
  trust policies, third-party consents and device approval arrive in later pull requests, and
  until then none of these flows has a write path.
- A PAT bound to an organization, and every org bot key, needs an active membership (owner or
  admin for a bot key). The write step locks the account row first, then holds the membership row
  `FOR SHARE` until commit, so a member removal that runs at the same time waits for the new
  credential. The removal sees it only if it updates the membership row in one statement and
  revokes the member's org-bound PATs and flags the member's keys in later statements of a
  VOLATILE function (each statement takes a fresh snapshot), or does that from a row trigger on
  `uts.org_memberships`; `uts.remove_org_member` (migration 0005) does the former. A removal
  written as one statement, with data-modifying CTEs, keeps the snapshot it took before the wait
  and misses the new credential. An account holds at most 100 live PATs and an organization at
  most 100 live bot keys, counted behind a lock.
- The app login can still revoke, flag, keep, deny and record use of CI trust policies,
  third-party consents and device codes, through column grants that leave out the holder, the
  hash, the scope, the lifetime and the pass, so an update cannot turn a row into a different
  credential. PATs and org bot keys lose those grants in migration 0005: only the account
  functions change them. A revoked PAT, bot key, CI trust policy or consent, and a denied or
  consumed device code, keep their status; a flagged bot key becomes only kept or revoked, and its
  `flagged_at` never changes once set (`uts.refuse_reopening`).
- Every new org bot key needs a gate pass (a `BEFORE INSERT` trigger refuses one without). Deleting
  the creator's account flags the creator's active keys, as member removal does (design section
  5.8), so they stop after 7 days unless an org admin keeps them. `created_by` keeps the creator's
  id as history; only `gate_pass_id` becomes NULL when the account's passes go with it.
- `refresh_grants.last_used_at` and `idle_expires_at` move at most once per grant per hour, not on
  every mint; the table leaves 10 percent of each page free (`fillfactor = 90`) for those updates.
- The app login writes authorization codes, refresh grants, device sessions, third-party families
  and tokens, revocations and DPoP proof `jti`s only through the security-definer OAuth functions
  (migration 0004), and PATs, org bot keys and gate passes only through the security-definer
  account functions (migration 0005), which write the credential rows and their audit row
  together; it keeps SELECT on those tables. It still writes the ungated credential tables directly.
  The account-deletion function will be one more such function: in the same statement, before the
  delete, it collects the active bot keys the account created (the keys the delete trigger is about
  to flag) and writes a bot-key-flagged audit row and the org-admin notices for each (design
  sections 5.8 and 8.1).
- Time limits compare with `statement_timestamp()` where a statement can run late in a transaction
  (the PAT and bot key lookups), and spell 7 days as 168 hours where the session's time zone could
  stretch or shorten calendar days (the flagged bot key cutoff, partition maintenance).
- `IdentityStoreError` keeps only the SQLSTATE, the constraint, the table, and for a failed
  connection the system error code (`ECONNREFUSED`, `ETIMEDOUT`, ...). The server's error detail can
  quote the refused row, so it never leaves `src/db/client.ts`.

### Audit outbox

`uts.audit_events` is partitioned by UTC day. Each row records its transaction id (`xid8`) and its
shard (`id % 8`). Each shard publishes as its own audit stream, and `last_seq` numbers that stream's
batches. The watermark marks the newest row whose batch the audit queue accepted; nothing confirms
that the archive stored it, because UTS cannot bind the archive or the audit relay service (design
section 8.1). A partition is therefore dropped only once every row in it is relayed and it is past
the 7-day tier, which leaves the audit relay service days to retry on top of the queue's own
retries.

The watermark moves only through `uts.advance_audit_watermark()` (SECURITY DEFINER); the app login
has no UPDATE on the watermarks. The function locks the shard's row and accepts a move only from
the current `last_seq`, forward, to a row of the shard below the oldest open transaction, and only
when the sequence advances by exactly the count of the shard's rows it passes (1 to 500, one index
range read). A login that moves a watermark without sending therefore leaves a sequence gap, which
the audit relay service holds and pages on, rather than a silently skipped row.

The relay read for one shard has this shape, and the relay keeps it (`RELAY_READ` in
`test/db/harness.ts`; `test/db/audit-maintenance.test.ts` checks the plan):

```sql
SELECT event.*
FROM uts.audit_relay_watermarks AS watermark
CROSS JOIN LATERAL (
  SELECT candidate.*
  FROM uts.audit_events AS candidate
  WHERE candidate.shard = watermark.shard
    AND (candidate.txid, candidate.id) > (watermark.last_txid, watermark.last_id)
    AND candidate.txid < pg_snapshot_xmin(pg_current_snapshot())
  ORDER BY candidate.txid, candidate.id
  LIMIT $2
) AS event
WHERE watermark.shard = $1
ORDER BY event.txid, event.id
```

The watermark drives the inner query, so the row comparison is the index condition on every
partition's (`shard`, `txid`, `id`) index and the read never touches a relayed row. A join that
filters on the watermark instead walks every relayed row of the shard on each read.

`uts.maintain_audit_partitions()` runs one step per call: it creates the first missing partition of
the next 7 days. Otherwise it takes the first partition whose upper bound, as attached, is at least
168 hours old and whose rows are all relayed: it truncates it while it holds data, which locks only
that partition (no insert reaches an old day), and drops it once it is empty. The age comes from
the bound, never from the name, and the function runs in UTC with a fixed 168-hour cutoff, so
neither a partition attached by hand under an older name nor a daylight-saving change shortens the
tier. Every check (one index probe per shard on the partition) runs before the one CREATE, TRUNCATE
or DROP. The DROP is the only step that takes the parent's `ACCESS EXCLUSIVE` lock, and it only
removes empty files; a DDL that waits 200 ms for its lock gives up, and the next call retries. The
cron calls it until it returns no `created`, `truncated` or `dropped` row. A partition whose name
is not `audit_events_YYYYMMDD` is left alone.

The `event` column holds an `AuditEvent` from `@kilocode/sts-contracts`. `uts.is_audit_event` checks
it in the database as strictly as `AuditEventSchema` does, narrowed to UTS sources, UTS event types
and the three OCSF classes in use, because a row the relay could not parse would stall its shard.

A second CHECK, `audit_events_no_credential`, is stricter than the contract. Event authors must know
it, because a refused audit row fails the whole credential statement:

- No string anywhere in the event may hold `kilo_pat_`, `kilo_rt_` or `kilo_bot_` followed by 16 or
  more of `A-Za-z0-9_-`, or a JWT shape (`eyJ...` then two dots). A mention of a prefix alone, such
  as "malformed kilo_pat_ value", passes. Refer to a token by its id or reference instead.
- `account_id` and the actor id may not be a bare email address.

The audit event contract slice adds the same refusal to `AuditEventSchema`, so both match.

A row is at most 8 KB, so one row always fits one queue message (60 KB compressed). A full 500-row
read of real mint events does not: 500 mixed mints (1 to 4 tokens each) compress to about 70 KB and
500 four-token mints to about 86 KB (`test/db/audit-outbox.test.ts`). The relay therefore halves any
batch the encoder refuses, as the STS relay does.

#### Storage

A mint audit row takes about 1 KB of table space and about 80 bytes in its two indexes. At one mint
per active client every 8 minutes:

| Active clients | Rows per day | 7-day tier, table | 7-day tier, indexes |
|---|---|---|---|
| 10k | 1.8M | ~13 GB | ~1 GB |
| 50k | 9M | ~63 GB | ~5 GB |
| 200k | 36M | ~250 GB | ~20 GB |

The relay reads only the newest rows, so the tier needs disk more than memory. The identity store
moves up one compute size when its buffer cache hit ratio stays below 99 percent for an hour at
peak, and its disk grows before data and indexes pass 70 percent of it.

Third-party refresh tokens are the other table that grows with traffic. A family keeps one
current token row; each refresh replaces it and keeps the replaced token as a tombstone in
`third_party_rotated_tokens` (16-byte key, family id, family end) until the family is past its
90-day end (below). A tombstone with its two index entries takes about 120 bytes. As an upper
bound, with every family refreshing every 8 minutes, a family gathers 90 days / 8 minutes =
16,200 tombstones by its end. Size the disk on the "at most" column: tombstones of a revoked
family stay until its 90-day end too, and a client that authorizes again often (a lost rotation
answer revokes its family) keeps close to that bound. The average assumes families of evenly
spread ages:

| Active third-party families | Tombstones, at most | Table and indexes, at most (disk sizing) | Average (evenly spread ages) |
|---|---|---|---|
| 10k | 162M | ~19 GB | ~10 GB |
| 50k | 810M | ~97 GB | ~49 GB |
| 200k | 3.24B | ~389 GB | ~194 GB |

### OAuth row maintenance

The app login cannot delete credential rows, so `uts.maintain_oauth_rows()` (SECURITY DEFINER)
removes the rows no statement reads again and ends the families of blocked clients. Each call
handles at most 5,000 rows of each kind and returns one `(kind, deleted)` row per kind. Like
`uts.maintain_audit_partitions()`, it has no caller in this service yet: the UTS cron that slice
3.9 adds calls both, this one until every count is under 5,000. `uts_app` holds EXECUTE on it by
choice until then; it takes no input and every step is time- or status-gated, so a caller can
only do the same work sooner. Slice 3.9 moves it to a dedicated maintenance role. It handles:

| Rows | When | Why that is safe |
|---|---|---|
| `blocked_client_families` | A live family of a blocked client: revoked (`client_blocked`) with its feed entry, not deleted, so `deleted` counts the families this call revoked; rows a refresh holds wait for the next call (`SKIP LOCKED`) | Every read already refuses the blocked client, so the batch only makes the revocation reach the verifiers; the client's unblock waits until this reports 0 |
| `authorization_codes` | 1 hour past the code's 60-second lifetime, used or not | Until then a second use of a used code still revokes its grant |
| `third_party_refresh_tokens` | The current token of a family that is revoked or past its 90-day end | It fails anyway: every reader checks the family's status, so a family revoke writes only the family row |
| `third_party_rotated_tokens` | Past the family's 90-day end, oldest first | No token of the family can be issued or refreshed again, so no reuse check needs the tombstone. Until then a replaced token that comes back revokes the family, however long ago it was replaced |
| `revocations` | Past `feed_expires_at` | The feed no longer carries the entry |
| `dpop_proofs` | Past `expires_at` (121 seconds) | No clock accepts the proof again |

It never deletes a grant, a family row, the current token of a live family, a tombstone of a
family that can still issue tokens, or a code within its lifetime (`test/db/oauth-grants.test.ts`).
At one mint per active client every 8 minutes, the DPoP rows arrive at 21, 104 and 417 per second
for 10k, 50k and 200k clients: 1,250, 6,250 and 25,000 per minute; in a steady state tombstones
age out at the rate they arrive, at most the same per third-party family, so a cron that runs
every minute makes 1 to 5 calls.

### Third-party reuse detection

A third-party client has no sender constraint, so a replaced token that comes back is treated as
stolen, whoever presents it: the whole family is revoked, a feed entry is written, and the
refresh fails (`reuse_detected`, which answers `invalid_grant`). A replaced token has no grace
window: with one, a second holder of a just-replaced token (a thief, or a copy) would get a
fresh token that outlives the grace and rotates the client's current token away. A client that
lost a rotation response authorizes again; its consent stands, so it sees no consent screen. The
tombstone keeps that evidence until the family ends, so a client that returns weeks later with a
token a thief replaced still revokes the thief's chain (`test/db/oauth-grants.test.ts`,
"third-party reuse detection"). First-party grants do not rotate; their DPoP key is the sender
constraint.

### Hot-path index probes

Each hot-path read reaches its credential through one unique-index probe on the hash, plus
primary-key probes for the rows that hang off it (`test/db/index-probes.test.ts` checks the plans):

| Read | Indexes |
|---|---|
| Mint and first-party refresh (`uts.read_refresh_grant`) | `refresh_grants_token_hash_key`, then `device_sessions_pkey`, `accounts_pkey`, `org_memberships_pkey`, `org_sso_policies_pkey` |
| Third-party refresh (`uts.read_third_party_refresh_token`) | `third_party_refresh_tokens_token_hash_key`, then `third_party_grant_families_pkey`, `third_party_clients_pkey`, `third_party_consents_pkey`, `accounts_pkey`, `org_memberships_pkey`, `org_sso_policies_pkey` |
| Replaced third-party token (`uts.read_rotated_third_party_token`), only when the hash is no current token | `third_party_rotated_tokens_pkey`, then `third_party_grant_families_pkey` |
| PAT lookup (`uts.lookup_pat`) | `personal_access_tokens_token_hash_key`, then `accounts_pkey` |
| Org bot key lookup (`uts.lookup_bot_key`) | `org_bot_keys_token_hash_key` |
| Web session check | `browser_sessions_token_hash_key` |

### Local database and tests

The local container runs Postgres 17.12 (`postgres:17.12`), the Postgres 17 release of the target
Supabase project. Its admin login has `CREATEROLE` and `CREATEDB` but not `SUPERUSER`, like
Supabase's `postgres` login, so the migrations are proven not to need a superuser. The container's
passwords are synthetic, and the tests give the UTS logins a random password on each run.

```sh
pnpm test                        # the suites that need no database
pnpm db:up                       # start the container; prints UTS_MIGRATION_DATABASE_URL
UTS_MIGRATION_DATABASE_URL=... pnpm db:migrate
pnpm test:postgres               # migrates a template database, then clones it per test file
pnpm db:down
```

`UTS_PG_PORT` (default 55432) and `UTS_PG_CONTAINER` change the port and the container name.
`UTS_TEST_ADMIN_URL` changes the admin URL of the tests, for a local server only: the test setup
changes cluster-wide roles and drops databases, so it refuses any host other than 127.0.0.1,
localhost and ::1.

In CI, the `test (cloudflare-uts)` job runs `pnpm test`, and the `uts-postgres` job runs
`pnpm test:postgres` against a `postgres:17.12` service container. That job runs `pnpm db:up`
with `UTS_PG_CONTAINER` set to the service container, so the container gets the same admin login
and `uts` database as the local one, and it sets `UTS_TEST_ADMIN_URL` to the container's loopback
port.

### Migrations

Migrations are plain SQL, not generated by drizzle-kit, because the identity store needs roles,
grants, a partitioned table, an `xid8` column and stored functions, which drizzle-kit cannot
express. The migrator runs each file in its own transaction as the database's admin login, over a
connection made directly or through the Supabase session pooler (session mode, port 5432), never
through Hyperdrive or the transaction pooler, and always with `sslmode=verify-full` and the Supabase
CA (`Supabase Root 2021 CA`). It records each file with its SHA-256, and refuses to continue when
an applied file changed, disappeared, or a new file sorts before an applied one. Add new files at
the end; never edit an applied file.

An operator runs the migrator (design section 5.2): a break-glass read of the admin login's password
from `/admin/identity-store`, approved by a secret admin, and a run that raises the same alert as
SQL-editor use. The migrator and the access check refuse a host other than loopback unless the URL
carries `sslmode=verify-full` and `sslrootcert=<Supabase CA file>`, and they accept no other URL
parameter (`scripts/connection.ts`).
