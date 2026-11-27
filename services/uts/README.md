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
  (on the feed Worker) always; the authorization, token, revocation and introspection endpoints
  once the environment binds the identity store (`IDENTITY_STORE`); the device grant once
  `DEVICE_USER_CODE_KEY` is set. An endpoint joins the document when it answers, so no listed
  endpoint returns 404.
- The OAuth endpoints (`src/oauth/`, see "OAuth endpoints"), the sign-in pages and passkey calls
  (`src/signin/`), the device grant (`src/signin/device/`) and ticket minting (`src/tickets/`) run
  in this fetch handler. Staging and production bind no identity store yet, so they serve none of
  them. Tickets are redeemed only through the `TicketRedeemer` entrypoint, by a caller listed in
  `TICKET_REDEEMERS` (empty in staging and production). The caller names the audience, the
  purpose and the resource (or none) it opens, and only a ticket minted for all three redeems; a
  mismatch leaves the ticket usable (migration 0020).
- The mobile app (`kilo-mobile`) needs device attestation (design 5.5), which UTS does not verify
  yet, so the authorization endpoint serves it in development only.
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
token, a PAT or org bot key revoke on the account API, a subject operation or a membership
removal on the `/internal/` routes) writes its `uts.revocations` rows and returns them in the same
statement (`uts.feed_entries_of_statement()`, migration 0006; one index probe, skipped on the
issued path). After the commit the Worker writes them to both feed objects in parallel
(`src/revocation/publish.ts`) and goes on once one confirms; each write ends within 2 seconds.
`/revoke`, the account API's revokes and the `/internal/` routes answer 503 when neither confirms
(the revocation stands, and the backfill adds it); the reuse paths answer as before. A retried
`/revoke` or account API revoke finds the credential revoked and gets its feed entry back while
the entry lives (`uts.live_feed_entries`, `uts.live_feed_entries_of_refresh_token`, migration
0019), so it answers success only once a feed object confirmed the entry. A failed publish logs
kinds and counts, never ids.

The two feed objects (`src/feed/UtsFeedDO.ts`) are named `<environment>:feed:<0|1>`, in the `eu`
jurisdiction, feed 0 with the `weur` hint and feed 1 with `eeur`; only this Worker binds them, so
only it writes entries. Each one:

- keeps its entries in memory only (`src/feed/ledger.ts`); the identity store is the record;
- every 5 seconds (alarm) reads, as the app login, the entries revoked in the last 20 minutes,
  or every live entry after a restart or a gap over 15 minutes (`src/revocation/store.ts`), drops
  expired entries, and rotates its feed key. While the environment binds no identity store the
  alarm runs hourly and only rotates the key; loading moves such an alarm back to now once the
  store is bound;
- signs a head (`typ: kilo-feed-head+jwt`, `{iat, list_hash}`) with its own Ed25519 key, kept in
  its KV storage with the signer's 30-day rotation and published next key (`uts-feed-<n>-<thumbprint>`).
  `iat` is the start of its last good backfill, so every revocation committed before it is in the
  list. It signs one list per `iat`: a verifier that holds a head refuses another list under the
  same `iat`, so a publish that changes the list after a head of that `iat` went out keeps that
  head and moves the next backfill to the start of the next second, whose head names the new list.
  None is signed once that backfill is 30 seconds old or the object holds more than 50,000
  entries. A backfill is given up after 10
  seconds (5 for the connect); expired entries leave the list at most once a minute;
- serves its current list, and each list it replaced in the last 30 seconds (at most 16 MB of old
  list text, the oldest dropped first), by hash;
- answers a publish with whether it vouches for its list; a revoke counts as published only when a
  vouching object took its entries, and logs `uts.feed.publish_unvouched` (an alert: the backfill
  is failing) when only objects that vouch for nothing took them. Every write to
  `uts.revocations` is dated with its transaction time by a trigger (migration 0006), which keeps
  an expiry an update sets.

The list is canonical JSON: subject → `revoked_before` (whole seconds, rounded down); grant, third-party
family, session and sandbox grant → `revoked_sids`; PAT and bot key → `revoked_pat_ids`; `kid` →
`revoked_kids`; `blocked_account` → `blocked_accounts`. An `unblocked_account` entry feeds no field:
it removes the account's `blocked_account` entry unless that block is newer, and keeps an older
copy of the block out while it lasts (`mergeEntry`, migration 0014). A PAT entry stays 15 minutes;
a grant or family entry 20 minutes. The feed objects' public keys reach the key set through the
key-set shards, beside the signers'. The feed Worker reads heads and lists through the `FeedReads`
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

The HTTPS feed answers only an admitted STS workload (`services/uts-feed/README.md`,
"Authenticated HTTPS feed"), so every run that reads it over HTTPS (`feed-e2e.ts`,
`subjects-e2e.ts`, `feed-https-e2e.ts`) starts a stand-in STS (`scripts/fake-sts.ts`: a synthetic
key set on `UTS_E2E_STS_PORT`) and reads as the `web` workload; the feed Worker runs with
`--var STS_URL:http://127.0.0.1:<that port>`. `scripts/feed-https-e2e.ts` takes
`UTS_E2E_FEED_URL`, `UTS_E2E_ADMIN_URL`, `UTS_E2E_STS_PORT` and, optionally,
`UTS_E2E_FEED_OFF_URL` (a feed Worker run with `--var FEED_HTTPS_ENABLED:false`). It checks the
refusals (no token 401; another workload, audience or scope 403; another environment, an expired
token or an unknown key 401), the head, list and bootstrap for `web` and `ai-gateway`, a 304
for an unchanged head and a held list, `@kilocode/verify` running over the transport (one
bootstrap per cold start, then the head and list calls of one minute while a revocation changes
the list, and the revoked subject refused), the CPU of the caller check, and the 503 of the
switched-off Worker.

Two runs bring up their own Workers and a fresh identity-store database, so neither needs a
`wrangler dev` server running: `scripts/keyset-e2e.ts` and `scripts/relay-e2e.ts`. Both take
`UTS_E2E_ADMIN_URL`, the admin login of `scripts/local-db.sh up`, on a loopback host and without
query parameters, and `UTS_E2E_PORT`, the first of the run's ports (9300 and 9310 by default). Each
drops and recreates its own database (`uts_keyset_e2e`, `uts_relay_e2e`), applies the migrations,
and gives `uts_app_a`, `uts_pat_a` and `uts_reader_a` a random password for the run. Roles are
cluster-wide and the database names and ports are fixed, so run one of them at a time. Each prints
a `PASS` line per check, a final pass line and the path of its log directory, and exits nonzero
when a check fails. Both stop their Workers when they end, also on SIGINT (exit 130) or SIGTERM
(exit 143).

`scripts/keyset-e2e.ts` starts the mint and feed Workers under `wrangler dev`, in one persisted
state directory, and runs the key-set proof: 36 keys with `Age` and `Kilo-Key-Set-Oldest-Age`
under 17 seconds and cache windows that end with the 24-hour hold, no private key part, RFC 8414
metadata, a token signed through `/__dev/sign` that verifies with jose while a tampered one does
not, every key-set shard storing the signers' keys (a reader Worker in one `wrangler dev` with the
mint Worker asks each shard by name), a restart that keeps the same kids without bootstrapping a
signer, an intruder Worker whose binding carries another caller that gets no keys, the held set
while the mint Worker is down, signer 03's rotated keys standing beside signer 07's held ones from
a restarted shard, a cold start of both Workers over whichever shard the mint Worker draws, each of
which stored signer 07's keys, and a warm feed isolate that keeps signer 07's keys from its own
copy once no shard holds stored keys.

`scripts/relay-e2e.ts` runs the mint Worker and the audit relay consumer in one `wrangler dev`
over two configs (`--env local`) with the local queue and the consumer's R2 archive, and runs the
outbox proof: a transaction held open for 7 seconds holds every shard's watermark, 600 rows
inserted while the app login cannot move a watermark move nothing, 6,000 rows follow once it can,
terminated relay sessions resend rather than skip, every shard relays, and the archive holds every
row once, contiguous, in transaction order. A cron run after the drain logs no lag alert. The run
writes a synthetic Axiom token, Slack webhook and loopback Axiom URL to
`services/audit-relay/.dev.vars` and deletes the file when it ends. It refuses to run (exit 2) when
`services/audit-relay/.dev.vars` or `.dev.vars.local` (which wrangler reads in its place) already
exists; move your own file away for the run.

Development only: `POST http://localhost:8800/__dev/sign` with `{ "grantId": "...", "claims": {...} }`
signs a claim set through the signer the grant picks. The route lives in `src/dev-index.ts`, which
only `wrangler.dev.jsonc` runs, and the claim set must name the development issuer. That config
cannot be deployed: its build command, which Wrangler runs before `dev`, `deploy` and `versions
upload` with `WRANGLER_COMMAND` set to the command, fails for every command but `dev`, and
`test/repo` fails any other config that runs the development entry. `wrangler.jsonc` holds only the
production and staging blocks. The same entry wires the development sign-in hand-off
(`src/dev.ts`): it approves every authorization request for the synthetic account `dev:uts-local`.

The local config binds the local identity store as `IDENTITY_STORE` (login `uts_app_a`),
`IDENTITY_STORE_PAT` (login `uts_pat_a`) and `IDENTITY_STORE_REPLICA` (login `uts_reader_a`). The
UTS logins have no password in the repository, and wrangler refuses a local connection string
without one, so give the three logins one and pass the URLs to wrangler
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_PAT` and
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_REPLICA` for the others):

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
| `POST /token` token exchange, refresh-token subject | The home-widget exchange (below): `kilo-mobile` exchanges its grant, with a DPoP proof of its key, for a widget grant that holds only `kilo-api:home-widget.use` | `uts.exchange_home_widget_grant` |
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

## Mobile attestation

`kilo-mobile` needs device attestation at its code exchange (design 5.5, decision Q67): iOS App
Attest and Android Play Integrity (`src/attest/`, migration 0017). The client is served only
where the environment's attestation config is complete (`src/attest/config.ts`); anything less
refuses it at `/authorize` with `unauthorized_client` and logs `uts.attestation.misconfigured`
with the names (never the values) of what is missing. Development with no attestation value at
all serves it without attestation, for the local tests.

| Name | Kind | Value |
|---|---|---|
| `ATTEST_APPLE_TEAM_ID` | var | the Apple Developer team id (10 characters) |
| `ATTEST_APPLE_BUNDLE_ID` | var | the iOS bundle id; with the team id it is the App ID whose SHA-256 is the RP ID hash |
| `ATTEST_PLAY_INTEGRITY_PACKAGE_NAME` | var | the Android package name |
| `ATTEST_PLAY_INTEGRITY_CERT_DIGESTS` | var | comma-separated SHA-256 digests of the accepted app signing certificates (Play Console hex, with or without colons, or base64url) |
| `ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY` | secret | the JSON key of a Google service account allowed to call `decodeIntegrityToken` in the Cloud project linked to the app |
| `ATTEST_DEV_ENDPOINTS` | development only | a stand-in App Attest root and Play Integrity origin on loopback; set anywhere else it refuses the client |

The Apple App Attestation Root CA is pinned in code (`APPLE_APP_ATTEST_ROOT`, checked by its
SHA-256). Google's token endpoint and API URLs are fixed; the key file's `token_uri` is ignored.

**App contract.** The challenge is the lowercase hex SHA-256 of
`kilo-uts-attestation-v1:<code>` (`@kilocode/uts-contracts` `attestation.ts`), with the code as the
redirect delivered it. The token request adds:

| `attestation_type` | `attestation_key_id` | `attestation` |
|---|---|---|
| `app_attest_key` (the install holds no key for UTS: first sign-in, or after `attestation_required`) | the new key's id, standard base64 | `attestKey(keyId, challenge)`, standard base64 |
| `app_attest_assertion` (every other sign-in) | the stored key's id | `generateAssertion(keyId, challenge)`, standard base64 |
| `play_integrity` | absent | the token of a standard request whose `requestHash` is the challenge itself (`requestIntegrityCheckAsync(challenge)`), as returned |

App Attest signs `SHA-256(UTF-8(challenge))` as its client data hash. Once `attestKey` ran for a
key, the app stores its id and sends only assertions for it, also when the attestation's answer
was lost; it attests a new key only after `attestation_required`. An exchange without an
attestation, an assertion of a key UTS does not hold, or an attestation of a key UTS holds
already answers `attestation_required` (400) and leaves the code usable while its 60 seconds
last. A refused attestation answers `invalid_grant` and the code never exchanges. A dependency
failure answers 503 with `Retry-After`; the app retries the same exchange. A retry of an attested
exchange (same code, verifier and DPoP key, a fresh proof) needs no attestation and gets the same
grant. UTS treats the Play Integrity token as opaque (base64url characters and dots, at most 16
KiB); `decodeIntegrityToken` decides.

**Checks.** App Attest: the chain to the pinned root with each certificate valid now, the nonce
`SHA-256(authData || clientDataHash)` in the credential certificate, the key id as the SHA-256 of
its key, the App ID hash, counter 0, the production AAGUID (development also accepts
`appattestdevelop`), the credential id, and the COSE key equal to the certificate's; an assertion's
signature over `SHA-256(authenticatorData || clientDataHash)`, its App ID hash, and a counter above
the stored one. Play Integrity: `requestHash`, the package (request and app), a verdict under 5
minutes old, `PLAY_RECOGNIZED`, an accepted signing certificate and `MEETS_DEVICE_INTEGRITY`.

**Statements and calls per mobile sign-in.** `uts.claim_code_attestation` checks the code against
the request (client, redirect URI, PKCE challenge, DPoP key, lifetime) before any verification, so
a request without a valid code reaches no verifier and no Google call; it claims the code for one
verification at a time (taken over after 15 seconds), and returns the stored key for an assertion.
`uts.settle_code_attestation` stores a new key, moves an assertion's counter only upward, refuses
(one `token.denied` audit row with the reason, and the code is dead), drops the claim for a key
stored already, or releases the claim after a retryable failure; a settle of a claim another
request took over changes nothing. Within an isolate a second request for a code in verification
answers 503 before its first await. The exchange statement then runs as for any first-party
client, behind a backstop: the trigger `authorization_codes_require_attestation` refuses to
consume a `kilo-mobile` code (SQLSTATE 23514) unless it is attested or, in development without
attestation config only, marked exempt (`uts.exempt_code_attestation`, refused in every other
environment; it trusts the Worker's `UTS_ENVIRONMENT`, so a production deploy misconfigured as
development would mark codes exempt and the backstop would not catch it; `test/repo` holds the
trigger's client list equal to the attestation-required clients). Per mobile sign-in: 3 statements (claim, settle, exchange) instead of 1, a retry of
an attested exchange 2, development without config 2 (exempt, exchange); for Android one
`decodeIntegrityToken` call plus one token exchange per isolate per hour; no Durable Object hop
beyond the signer call; no queue message; one audit row per refusal. After a Google 429 each
isolate answers 503 without calling Google for the `Retry-After` (60 seconds without one, at most
5 minutes). The config is parsed once per isolate. Refresh is unchanged. App Attest keys stay
until 400 days after their last use (`uts.maintain_attestation_rows()`, minute cron); a code's
attestation goes with its code.

Deliberate deferrals (decision Q86): the Play licensing verdict is not checked, and the App
Attest receipt is not stored or sent to Apple's fraud-metric service.

`scripts/attest-e2e.ts` (`UTS_E2E_ADMIN_URL`, `UTS_E2E_PORT`, default 9490) runs the mint Worker
with a complete config and stand-ins for Apple and Google in their real formats, and a second
mint Worker with one value missing: it checks an admitted key attestation, assertion and Play
Integrity verdict, refused replays, repeated counters, missing attestations, wrong packages,
unrecognized apps and other signers, one decode per code across a retry, the refusal by default,
and that no credential value reaches an audit row.

## Home-widget grant

The mobile home-screen widget reads `GET /api/mobile/widgets` and registers its push token at
`POST /api/mobile/widgets/push-token` on the web app while the app is not running (design 9.3).
Today a 30-day HS256 credential under the shared web secret serves it; under UTS the widget holds
its own refresh grant, narrowed to one scope, and refreshes 10-minute access tokens like any
first-party client (`src/home-widget/exchange.ts`, migration 0024, contract in
`@kilocode/uts-contracts` `home-widget.ts`).

**Why an exchange of the app's grant, not a new grant type.** Design 5.3 and 5.5 already give
first-party clients one credential shape: a DPoP-bound refresh grant with an allowed scope list
and 10-minute access tokens. The widget needs exactly that, with less: one scope, the same device,
and no longer life than the app's sign-in. So the app exchanges its own grant at `/token` with RFC
8693 (`subject_token_type` refresh token), and the result is an ordinary `uts.refresh_grants` row
that the widget refreshes with `refresh_token`. No new client, grant type, signer path or verifier
rule exists. Sharing the app's grant with the widget extension was rejected: that grant holds
every mobile scope, and the extension's keychain item is readable by a second process.

| Property | Rule |
|---|---|
| Client | `kilo-mobile` only; another first-party client gets `unauthorized_client`, a third-party one too |
| Proof | A DPoP proof of the app grant's key; the widget grant takes the same key, which the app keeps in the keychain access group it shares with the widget extension (Android: the app's own keystore). The app's refresh token stays in the app's private keychain item, so the extension holds only the widget grant |
| Scope | Exactly `kilo-api:home-widget.use` (audience `kilo-api`, 10 minutes, session-bound), which the app grant must list |
| Organization | `org` optional: an org-bound app grant names its own organization or none; a personal app grant may name any organization with an active membership whose SSO requirement the session's sign-in meets (design 5.8). The organization becomes every widget token's `org` claim; without one the widget is personal. Each widget refresh rechecks it |
| Lifetime | The widget grant expires at the app grant's idle expiry at the time of the exchange, so it never outlives the app's sign-in. The app exchanges again when it opens (after its own refresh, which moves its idle expiry) and `refresh_token_expires_in` is under 7 days, or when the widget's organization changes. It does not exchange again while its last exchange already answered under 7 days: then the app grant itself ends within 7 days (its one-year maximum), every new widget grant would end with it, and a repeat buys nothing until a new sign-in replaces the app grant |
| One per app grant | A new exchange revokes the previous widget grant (`replaced`, with its feed entry); at most 10 exchanges per app grant per hour, then 429 `slow_down` with `Retry-After` |
| Revocation | `/revoke` with the widget's refresh token ends only the widget. Anything that ends the app grant (sign-out, device revoke, reuse detection, member removal, subject operations) ends the widget in the same statement (`uts.end_grant`), each grant with its own feed entry, and writes the widget's own `grant.revoked` audit row (system actor, the app grant's reason, under the environment the widget grant recorded at its exchange); the device session ends with its last grant. A device revoke that names the app grant also names its widget grants and answers every entry its statement wrote, and a `/revoke` retry of a revoked app grant republishes its widget's entry, so each call publishes the widget's entry before it succeeds. A member removal revokes an org widget of a personal app grant with the member's other org-bound grants |
| Not allowed | A widget grant mints no ticket (`uts.issue_ticket` answers `invalid_grant`), cannot be exchanged again, and records no device sign-in or new-device notice |
| Switch | Offered only where `HOME_WIDGET_GRANT_ENABLED` is exactly `true`; otherwise the exchange answers `invalid_request`. `test/repo` keeps it off in production |

**Wire contract.** `POST /token`, form-encoded, `DPoP` header: `grant_type`
`urn:ietf:params:oauth:grant-type:token-exchange`, `client_id` `kilo-mobile`, `subject_token` the
app's `kilo_rt_` token, `subject_token_type` `urn:ietf:params:oauth:token-type:refresh_token`,
`scope` `kilo-api:home-widget.use`, optional `requested_token_type` (access token only),
`resource` (`kilo-api` only) and `org`. A 200 is `HomeWidgetGrantResponseSchema`: the widget's
first access token with `issued_token_type`, and its `refresh_token` and
`refresh_token_expires_in`. Errors: 400 `invalid_request` (malformed form, actor or `audience`
parameters, switch off), 401 `invalid_client`, 400 `unauthorized_client`, 400 `invalid_scope`,
400 `invalid_target`, 400 `invalid_dpop_proof` (missing, invalid or replayed proof), 400
`invalid_grant` (app grant unknown, revoked, expired, another key, a widget grant, or the
organization refused), 429 `slow_down`, 503 `temporarily_unavailable` with `Retry-After` (retry
the exchange with a new proof), 500 `server_error`. A lost answer after the statement committed
costs nothing but the next exchange, which replaces the grant the lost answer carried.

**Verifying.** The widget routes verify with `@kilocode/verify` as audience `kilo-api`, route
`{ issuer: 'uts', scope: 'kilo-api:home-widget.use', requiresSession: true }`; the principal is
`sub` and `org` (absent: personal). The verifier's feed check (`revoked_sids`, `revoked_before`,
`blocked_accounts`) replaces the legacy route's per-request database rechecks; UTS rechecks the
account, device session, membership and SSO requirement at each widget refresh.

**Cost.** An exchange is one SQL statement (the app grant by its token hash with its row lock, the
proof row, a range probe of the hourly count, the membership row when a personal grant names an
organization, at most one replaced grant, one grant insert, one or two audit rows), at most one
feed publish (two feed-object calls, only when a grant was replaced) and one signer call. It runs
when the app opens and its widget grant is under 7 days from expiry, so about once per 53 days
per device. A widget refresh is the ordinary refresh: one statement and one signer call per
widget run with an expired token, at most one per 10 minutes per device, inside the "mint or
refresh a user token" budget (design 3). The cascade in `uts.end_grant` adds one probe of
`refresh_grants_live_widget_key` per first-party grant revoke.

## Third-party clients, consent and the broker exchange

Design 5.9. A third-party client id is the HTTPS URL of its Client ID Metadata Document
(`src/third-party/`); dynamic client registration stays off.

- **Metadata** (`metadata.ts`, `clients.ts`): `/authorize` resolves the client from the
  identity-store copy (`uts.third_party_clients`). A missing or stale copy is fetched first, a
  stale one with `If-None-Match`. The fetch guards:
  - HTTPS on the default port only; no IP literal, single label, `localhost` or private name space;
  - no redirect; 200 or 304 only; a JSON body of at most 8 KiB; 5 seconds in all;
  - a cache time of `max-age` bounded to 5 minutes to 24 hours (1 hour without one).

  The document must name the same client id. It must not carry a client secret, and every
  redirect URI must be HTTPS, HTTP loopback on `127.0.0.1` or `localhost` (never `[::1]`: the
  confirm page's `form-action` cannot name an IPv6 literal), or a private-use scheme of a native
  app, short ones included (`cursor://`, `vscode://`; RFC 8252 section 7.1's reverse-domain form is
  a SHOULD), except a scheme that runs code, reads local data or leaves the browser (`javascript`,
  `data`, `file`, `blob`, `about`, `vbscript`, `filesystem`, `ftp`, `ws`, `wss`, `mailto`); the
  consent and confirm pages show the whole redirect URI, and `/authorize` checks a cached URI
  against the same rule again. A blocked client is never served and keeps its
  status through a refresh. Each isolate runs one fetch per client id at a time, and after a
  failure it waits 60 seconds before it fetches that id again. Every fetch also counts against the
  requesting network's anonymous-write allowance (10 a minute per network per isolate, its own
  window, `src/signin/limits.ts`); past it `/authorize` answers `429 temporarily_unavailable` with
  `Retry-After`, and a cached client costs nothing. The minute cron deletes an active client that
  no consent names one day after its cache time ended (`uts.maintain_third_party_client_rows`,
  migration 0021). Only `uts.save_third_party_client` and `uts.extend_third_party_client` write a
  client; the app login has no DML on the table. A Worker cannot see the address a name resolves
  to, so a public name that resolves to a private address relies on Workers not reaching private
  networks.
- **Errors before consent**: a third-party client listed its own redirect URIs, so every
  `/authorize` error before the user acts in the hand-off is shown (400 JSON), never redirected;
  a denial or a later error, once the user signed in and consented or denied, goes back to the
  redirect URI.
- **Consent** (`consent.ts`): the sign-in hand-off sends a third-party request with a browser
  session to the consent screen. An active consent of the account, client and organization that
  covers the scopes approves at once. Otherwise the page shows the client name, the metadata URL,
  the redirect, the organization and one tick box per consent line (`consentText` in
  `UTS_SCOPE_REGISTRY`). Its form posts the authorization URL back from this origin.
  `uts.grant_third_party_consent` writes the consumed tier B pass, the consent, the
  `third_party_client_approved` notice and the audit row in one statement. A sign-in older than 10
  minutes needs the passkey step-up, which the page runs before it submits. A request whose
  redirect is not HTTPS (loopback or private-use scheme) never completes on a plain GET, even
  under an existing consent: it shows the confirm page, whose same-origin POST approves (RFC 8252
  section 8.6). The sign-in hand-off applies the same rule to the first-party clients, the CLI's
  loopback redirect included.
- **Apps page** (`GET`/`POST /signin/apps`): it lists the account's consents, and a same-origin
  form POST withdraws one. `uts.withdraw_third_party_consent` revokes the consent and ends each
  live family with a `third_party_family` feed entry. It never writes `revoked_before`. The page
  publishes the entries before it answers, and a page answered 202 means only the backfill will
  add them.
- **Broker exchange** (`src/exchange/`, `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
  at `/token`): Kilo MCP authenticates with an STS bearer (audience `uts`, workload `kilo-mcp`,
  scope `uts:token-exchange`). The STS token is checked through the `StsCallerVerifier` port. The
  deployed entry wires none until `@kilocode/verify` is on this branch, so the grant answers
  `unsupported_grant_type` there and the metadata does not list it. The development entry checks
  tokens of a local fake STS key set (`DEV_STS_JWKS_URL`, `src/dev-clients.ts`).

  The subject token is verified against signer keys held in isolate memory (`keys.ts`): a 5-minute
  copy, a re-read for an unknown `kid` at most every 10 seconds, and a copy under 1 hour old kept
  through failed reads. Its scope must list the requested scope in `delegatesTo`.

  The result has `exp = min(now + 300, subject exp)`, refused with `invalid_grant` under 30 seconds
  left. It carries `act: { sub: "kilo-mcp" }`, `req`, the subject's `sid` and `client_id`, and its
  `org` only when present.

  Cost per request: one statement (`uts.exchange_delegated_token`: grant or family, consent,
  subject and `kid` revocations, `token.exchanged` audit row), then one `signMany` call. The
  limits are attempt budgets, not success budgets. Each isolate allows 600 attempts a minute per
  caller workload, counted once the STS token is verified, and 60 per subject `sid`, counted once
  the subject token is verified. Both count refused attempts too, so a caller that retries a
  refused subject spends the same budget. Above that it answers
  `429 { error: "slow_down", limit: "subject" | "caller" }` with `Retry-After` of 1 to 60 seconds,
  and a 429 itself counts nothing.

The local run is `scripts/clients-e2e.ts`. Start the mint Worker with
`--var DEV_CLIENT_METADATA_ORIGIN:http://127.0.0.1:9132 --var DEV_STS_JWKS_URL:http://127.0.0.1:9131/jwks.json`
and set `track_functions = 'all'` on the local server, so the run can count the exchange
statements. The run serves the metadata document and the fake STS key set itself.

## CI token exchange

A GitHub Actions job trades its GitHub OIDC token for one UTS access token at `POST /token`
(`src/ci/`; design 5.3, 5.5 and 6.2; RFC 8693). It replaces a long-lived Kilo API key in
repository secrets. The wire contract is `ci.ts` in `@kilocode/uts-contracts`.

- **Switch.** The trust policies are the Worker var `CI_TOKEN_POLICIES`, a JSON array per
  environment in `wrangler.jsonc`. Absent or `[]`: the exchange answers `unsupported_grant_type`
  and the metadata does not list the token exchange for it. A value that breaks a load rule keeps
  it off and logs `uts.ci_token.misconfigured` with the rules it breaks. Production sets none, and
  `test/repo/worker-configs.test.ts` keeps it that way and checks every configured list.
- **Policy.** One entry per repository id, GitHub environment and workflow file:

  ```json
  {
    "name": "ci-kilocode-smoke-test",
    "repository": "Kilo-Org/kilocode",
    "repositoryId": "946087422",
    "repositoryOwnerId": "201822503",
    "environment": "smoke-test",
    "refs": ["refs/heads/main"],
    "jobWorkflowRefs": ["Kilo-Org/kilocode/.github/workflows/smoke-test.yml@refs/heads/main"],
    "events": ["workflow_dispatch"],
    "legacySubject": true,
    "subject": "<UTS account id of the dedicated CI account>",
    "scopes": ["kilo-gateway:inference"],
    "lifetimeSeconds": 3600
  }
  ```

  The load rules (`src/ci/policy.ts`) follow the STS GitHub rules (design 6.3): `ci-<job>` names;
  workflow entries of the policy's own repository, each on a listed ref; events from `push`,
  `schedule`, `workflow_dispatch` and `workflow_run` only, `workflow_run` alone and never in
  production; production accepts only `refs/heads/main`; `legacySubject` only for
  Kilo-Org/kilocode (decision Q62a). Every scope must be registered, PAT-eligible and need no
  organization claim, so a CI token never holds more than a PAT of the same account could.
- **Subject.** Each policy names one UTS account, a dedicated CI account for that job, not an org
  bot key. The token then has the claim profile of any user token, so a verifier needs no new
  subject kind. The token carries `sub`, `client_id` (the policy name), `scope`, `aud`, `env`,
  `jti` and the policy's lifetime (at most 1 hour), and no `sid`, `org`, `act` or refresh token.
- **Stopping CI tokens.** Removing a policy stops new CI tokens only: tokens already issued live
  until their expiry, up to 1 hour. The emergency stop is an access block of the CI account
  (subject operation `revoke`, reason `access_block`): its statement refuses every later exchange
  and puts a `subject` entry (with `revoked_before`) and a `blocked_account` entry on the
  revocation feed for 70 minutes, past the longest CI token issued before it. A verifier refuses
  such a token once its feed copy holds the entries, not at once (design 3, 5.6, 7): the first
  request 10 seconds after its last fetch refreshes the copy in the background, a request waits
  for a refresh once the signed head is over 30 seconds old (about 41 seconds in the worst case),
  and, for a policy lifetime over 10 minutes, the verifier answers 503 rather than accept it once
  the head is over 60 seconds old (10 minutes for a shorter lifetime).
  `test/runtime/ci-token.test.ts` proves both with `@kilocode/verify`; `test/db/ci-token.test.ts`
  proves the block's feed entries.
- **Checks.** The OIDC token is `RS256` under GitHub's key set, issuer
  `https://token.actions.githubusercontent.com`, exactly the environment's UTS issuer URL as its
  one audience, `exp` with 60 seconds of skew and no future `iat`. The repository and owner ids,
  GitHub environment and workflow entry select the policy; its immutable subject (or the default
  subject on a `legacySubject` policy), ref, event and the entry's pin to the token's own ref must
  match. Refusals: `invalid_request`, `invalid_scope`, `invalid_target`, `invalid_grant`, and 503
  `temporarily_unavailable` with `Retry-After` when GitHub's key set or the identity store fails.
- **GitHub key set** (`github-keys.ts`). One plain-data copy per isolate, used for at most 5
  minutes; an unknown `kid` refreshes it at most once per 5 minutes; a failed fetch is not
  retried for 10 seconds. The URL is pinned, redirects are not followed, the fetch gives up after
  5 seconds and reads at most 64 KB.
- **Audit and cost.** A token that matches no policy costs no statement. Otherwise one statement,
  `uts.exchange_ci_token` (migration 0023), checks that the account is active and writes
  `ai.kilo.uts.ci_token.issued` (with the token id, policy and run) or
  `ai.kilo.uts.ci_token.denied`, then one `signMany` call signs the token in the signer its `jti`
  picks. A token that names a policy's workflow but breaks a binding, or asks for a scope the
  policy lacks, writes a denied row at most once per policy and reason per minute in each isolate.

A job uses it like this (production issuer shown; staging uses `https://uts-staging.kiloapps.io`
for both the audience and the URL):

```yaml
jobs:
  smoke-test:
    runs-on: ubuntu-latest
    environment: smoke-test # the policy's `environment`
    permissions:
      contents: read
      id-token: write # lets the job request its OIDC token
    steps:
      - name: Get a Kilo CI token
        run: |
          set -euo pipefail
          oidc=$(curl -sSf -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https%3A%2F%2Futs.kiloapps.io" | jq -r .value)
          echo "::add-mask::$oidc"
          token=$(curl -sS --fail-with-body https://uts.kiloapps.io/token \
            --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
            --data-urlencode subject_token_type=urn:ietf:params:oauth:token-type:id_token \
            --data-urlencode "subject_token=$oidc" \
            --data-urlencode scope=kilo-gateway:inference \
            --data-urlencode resource=urn:kilo:service:kilo-gateway | jq -r .access_token)
          echo "::add-mask::$token"
          echo "KILO_API_KEY=$token" >> "$GITHUB_ENV"
```

The token lives for the policy's lifetime and cannot be refreshed; a longer job runs the step again
for a fresh OIDC token and a new CI token.

## Account API, PATs and org bot keys

Every account route takes a UTS access token for the `uts` audience with the route's scope and a
`sid` (`src/account/bearer.ts`): `EdDSA` under a `uts-token-` key that the isolate's key-set shard
holds, read through an isolate copy of the key list (one Durable Object call per isolate per 10
seconds, or per 2 seconds while tokens name a kid the copy lacks, so a flood of forged tokens costs
no call each), `typ` `at+jwt`, the issuer, 60 seconds of skew and
the claim profile, and a client that the scope registry allows for the scope (`kilo-cli` or
`kilo-web` only). A PAT names no session, so it is refused there. Each action is one statement that
reads the grant or browser session the `sid` names, so a revoked grant, an ended session or a
blocked account fails at once, with no feed lookup.

**The profile API key and released clients (decision D54).** The released CLI, extension and mobile
app send one profile API key to the gateway for inference, and to the kilo-api (reads and writes)
and Session Ingest. A UTS PAT holds one audience and one scope, so the PAT the profile page creates
serves gateway inference only (a product choice; other PAT-eligible scopes exist). Released clients
keep their legacy profile key for kilo-api and Session Ingest calls until the phase 5 client
releases; no compatibility credential exists. The criterion 4 measure counts legacy profile-key
issuance as a released-app path, labelled separately from UTS-issued credentials.

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
origin to its audience. Production lists the web app (`kilo-api`), the issuer (`uts`), the AI
gateway (`https://ai-gateway.kilo.ai`, `kilo-gateway`), the `*.kiloapps.io` origins of
ai-attribution, session-sync, notifications, events and chat, and the `*.kilosessions.ai` origins
of session ingest, data export, the git token service and the cloud agent; staging lists only
`https://staging-app.kilo.ai`, `https://staging-ai-gateway.kilo.ai` and its issuer; development
lists loopback origins only (the AI gateway on `http://localhost:3010`). The gateway's origin is
the one its deploy targets and the web app's rewrites name; a request that reaches it through
`/api/gateway` on the web app still names that origin, never one read from `Host`. An origin in
the table does not activate a service: the service proves its caller first.
`protectedResourceMetadataFor` builds a resource's RFC 9728 metadata from the same table. Another
environment's origin, a path, a trailing slash or a query answers `invalid_target`.

`kilo-gateway:inference` is the gateway's one scope: inference and the authenticated model catalog
and validation reads, for the CLI and the mobile app, 10 minutes, no step-up, no session, no
organization claim, no actor. A PAT or an org bot key may carry it. The gateway checks the
organization a request names against the subject itself.

| Route | Scope | Behaviour | SQL |
|---|---|---|---|
| `POST /account/pats` | `uts:pats.manage` | Tier B gate (a sign-in within 10 minutes, or a passkey step-up of the same session); the scope must be registered and PAT-eligible; 90 days unless `expires_in_days` (1 to 365) says otherwise; at most 100 live PATs per account, and at most 20 created per account in any hour (429 with `Retry-After`); the PAT appears once in the answer. A gate refusal answers 401 with the RFC 9470 challenge (`insufficient_user_authentication`, `max_age="600"`) | `uts.create_pat` |
| `GET /account/pats` | `uts:pats.manage` | The live PATs, newest first, with the last four characters | `uts.list_pats` |
| `DELETE /account/pats/<id>` | `uts:pats.manage` | Revokes; writes a 15-minute feed entry; 204 also when already revoked, once a feed object took the entry | `uts.revoke_pat` |
| `POST /account/orgs/<org>/bot-keys` | `uts:bot-keys.manage` | An owner or admin of the organization; tier B gate; at most 100 live keys per organization (a key flagged within 7 days counts), and at most 20 created per organization in any hour (429) | `uts.create_bot_key` |
| `GET /account/orgs/<org>/bot-keys` | `uts:bot-keys.manage` | The live keys; a flagged key shows when it stops | `uts.list_bot_keys` |
| `DELETE /account/orgs/<org>/bot-keys/<id>` | `uts:bot-keys.manage` | Revokes; 15-minute feed entry | `uts.revoke_bot_key` |
| `POST /account/orgs/<org>/bot-keys/<id>/keep` | `uts:bot-keys.manage` | Keeps a flagged key before its 7-day cutoff; tier B gate, since keeping restores long-lived access | `uts.keep_bot_key` |
| `GET /probe/pat` | `uts:probe.read` on the PAT | Answers whose PAT it is: the offline format check, a client address, 20 lookups per second per client (an IPv4 address or an IPv6 /64) per isolate, then the lookup with no cache, so a revoked PAT fails on its next use | `uts.lookup_pat` (PAT config) |

- The CLI and the web BFF `kilo-web` hold `uts:pats.manage` and `uts:bot-keys.manage` (design
  5.5). A `kilo-web` token names its browser session in `sid`: `uts.account_session` (migration
  0025) finds a live browser session of the token's subject that holds a BFF handle, or a CLI
  grant and its device session, and refuses a session of any other account. The token's `sub` and
  `sid` come from the same session row at the mint, so the BFF manages the credentials of its
  signed-in user only. A create's tier B gate, and a keep's, runs on that session, and the consumed
  pass names it. A session the legacy bridge created holds no UTS sign-in cookie, so its sign-in
  time (the web app's claim) never counts as a recent sign-in; only a passkey step-up of that
  session could pass. `uts.open_tier_a_gate_pass` answers `invalid_session` for a browser session,
  which uses `uts.open_browser_tier_a_gate_pass`. In the account audit rows `grantId` is the
  token's `sid`, and the create and keep rows and their refusals name the client (`clientId`).
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
- A refused gate writes at most one `ai.kilo.uts.gate.refused` row per grant, or per browser
  session, per minute.
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
- `uts.open_browser_tier_a_gate_pass` (migration 0020) opens the same tier A pass for the browser
  session a cookie names, with the same checks on that session's sign-in; passkey registration and
  an in-session method link consume a pass of their own browser session, which
  `uts.open_tier_a_gate_pass` (a grant's device session) cannot open. No route opens a pass or
  sends a tier A code yet: both wait for the account pages and the mail sender.
- `PatLookup` (`src/pat/entrypoint.ts`) is the lookup port of `@kilocode/verify` for Worker
  verifiers: the lowercase-hex SHA-256 in, `found`, `not_found`, `rate_limited` or `unavailable`
  out (`UtsPatLookupResultSchema`). It answers only callers its environment lists
  (`PAT_LOOKUP_CALLERS`), runs at most min(100, 3 × `PAT_LOOKUP_CONNECTIONS`) lookups at once per
  isolate (see "Deploys"), and sends one statement through the PAT config. A lookup that has not
  answered in 5 seconds, connecting included, answers `unavailable` (`pg`'s connect timeout cannot
  end a hung connect on a Workers socket), and a lookup's slot lapses after 10 seconds even if its
  promise never settles, as when Workers cancels a request whose client went away. The probe route
  uses the same cap.
- The scope registry is `UTS_SCOPE_REGISTRY` in `@kilocode/uts-contracts`; `test/repo` checks every
  entry against the rules of design 5.3 (no PAT carries a privileged, step-up, staff,
  credential-changing or session-bound scope; a privileged scope needs a step-up and lives at most
  5 minutes; a scope needs the `org` claim exactly when its subjects are organization members, in
  any role or in listed roles; no delegated token carries a privileged, step-up, staff or
  credential-changing scope; a scope limited to listed roles is neither third-party-safe nor
  PAT-eligible). It lists the account API scopes (`uts:pats.manage`, `uts:bot-keys.manage`,
  session-bound, for the CLI and the web BFF), `uts:probe.read` (PATs, and the CLI),
  `uts:security.read` (the web app's security view,
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
  private-use redirect, device attestation required). `kilo-web` authenticates with a private-key
  JWT under one of the at most two Ed25519 keys of the var `KILO_WEB_CLIENT_JWKS` (`src/bff/`);
  while the var is unset or invalid, every `kilo-web` request answers 503 with `Retry-After: 60`.
  Its code names the browser session it was approved in and has no DPoP key; the code exchange
  returns that session and an opaque handle (migration 0013), and the BFF then calls
  `POST /account/browser-sessions/{read,token,end,end-all}` and `/account/devices/revoke`
  (`@kilocode/uts-contracts` `browser-sessions.ts`). `token` takes an optional `org` (design 5.8):
  `uts.mint_web_session_token` (migration 0025) reads the subject's membership and the
  organization's SSO policy in the minting statement and binds the token only for an active member
  in a role the scope allows whose handle sign-in meets the SSO rule, else 403 `access_denied`; a
  scope that needs the `org` claim needs `org`. A member removal refuses the next mint; a token
  minted before it is not revoked and ends at its expiry, 10 minutes at most. The legacy bridge
  (RFC 8693, subject token
  `typ` `kilo-legacy-session+jwt`) is a high-risk switch: its subject token vouches for a legacy
  session of any app user. It runs only where `LEGACY_BRIDGE_ENABLED` is `true`, and verifies the
  token only under its own one or two Ed25519 keys in `KILO_WEB_BRIDGE_JWKS` (kid prefix
  `kilo-bridge-`), never under a client assertion key: while that var is unset, invalid, or shares a
  key with `KILO_WEB_CLIENT_JWKS` (`uts.legacy_bridge.key_reused`), the bridge answers 503, so
  removing the bridge key turns the bridge off; its SSO
  authority check confirms nothing until UTS holds the SSO authority data, so a bridged session
  carries no SSO provenance. `scripts/bff-e2e.ts` runs the whole surface locally with a stand-in
  signer. `test/repo` holds each confidential client to
  `private_key_jwt` and exact HTTPS redirect URIs with a path (a loopback origin in development
  only), each desktop client to a loopback path, and each mobile client to one reverse-domain
  private-use URI and attestation.

## Sign-in providers, SSO and email

The sign-in page of an authorization request (and of `/device`, `/signin/passkeys` and
`/signin/done`) offers the passkey, every configured provider, SSO and the email sign-in. Each
provider, SSO or email sign-in ends in a browser session (`__Host-uts_session`, design 5.3) and
returns to the page that offered it, so an authorization request then issues its code
(`src/signin/handoff.ts`).

In production the passkey's relying-party id is the app host (`WEBAUTHN_RP_ID`), so on the issuer
host a passkey ceremony needs the browser's WebAuthn related-origin support (design 5.14). Staging
uses its own passkey domain, the issuer host itself, so its ceremonies need no related origin. The
page script (`src/signin/script.ts`) asks `PublicKeyCredential.getClientCapabilities()`, and treats a
`SecurityError` from the ceremony the same way: without support, the passkey controls are hidden
and the page says why and points to the other methods. The add-a-passkey page refuses in the same
way, before it asks for a challenge when the browser has already answered. The passkey pages'
`connect-src` names `https://<WEBAUTHN_RP_ID>/.well-known/webauthn`, the URL the browser fetches
for the related-origin check.

| Route | Behaviour | SQL |
|---|---|---|
| `GET /signin/oauth/<provider>/start` | Stores the flow (`state` hash, binder hash, return path) and redirects to the provider; `intent=link&gate_pass=<id>` adds the method to the signed-in account instead | `uts.start_sign_in_flow` |
| `GET /signin/oauth/<provider>/callback` (`POST` for Apple, `form_post`) | Exchanges the code, checks the identity, then consumes the flow and signs in or links | `uts.complete_provider_sign_in` |
| `POST /signin/sso/start` | The address's domain picks the org's one active WorkOS connection | `uts.start_sign_in_flow` |
| `GET /signin/sso/callback` | Buys the WorkOS profile; its connection and domain must be the flow's | `uts.complete_provider_sign_in` |
| `POST /signin/email/start` | With Mailgun: refuses an address outside the recipient rule, then checks the Turnstile token; stores the email (link hash, keyed code hash), then sends it through the mail port | `uts.start_email_sign_in` |
| `POST /signin/email/code` | Checks the newest code for the address; the fifth wrong entry exhausts it; a network past 30 wrong codes an hour is refused | `uts.verify_email_code` |
| `GET /signin/email/link` | A confirmation page only, so a mail scanner changes nothing | none |
| `POST /signin/email/link` | Signs in with the link, once | `uts.complete_email_link` |

Every provider callback makes one SQL statement, after the provider calls. A flow's `state` and
binder are 32 random bytes each; the identity store keeps only their SHA-256, and the binder lives
in a `__Host-uts_flow_<16 hex>` cookie (`SameSite=None`, because Apple posts the callback from its
own site) of the browser that started the flow. The PKCE verifier and the OpenID Connect nonce are
HMAC-SHA-256 values of the binder (`src/signin/flows.ts`), so no flow secret is stored. The sign-in
forms post only from the issuer's own pages (`Origin`), so another site cannot sign a visitor into
an account it chose.

### Protocols

The endpoints are fixed in `src/signin/providers/specs.ts`, checked against each provider's
OpenID Connect discovery document or API reference; nothing is discovered per request. An ID
token is verified against the provider's key set (signature, `iss`, `aud`, `exp`, `iat` and the
flow's `nonce`); `jose` keeps each key set per isolate for 10 minutes (`cacheMaxAge`) and
refetches it on an unknown `kid` at most once per 30 seconds (`cooldownDuration`). UTS sends the
nonce to every OpenID Connect provider. Each spec's `idTokenNonce` says whether the ID token must
carry it: `required` refuses a token without it; `if_present` (LinkedIn only, whose ID token has
no `nonce`) accepts a token without it, and both refuse a token with another nonce. Without PKCE
or a nonce, the state and the flow's binder cookie still stop a forged callback. They do not stop
a stolen LinkedIn code injected into the thief's own flow: LinkedIn accepts a code for 30 minutes
(its authorization code lifetime), so that is the replay window of a code that leaks. The mint
Worker's logs keep no query string (`observability.redact_query_string`, held by the repo check),
so a callback's code never reaches the invocation logs, and the callback page sends
`Referrer-Policy: same-origin`.

| Provider | Protocol | PKCE | ID-token `nonce` | Client authentication | Scopes | Proof of the address |
|---|---|---|---|---|---|---|
| Google | OpenID Connect | S256 | required | `client_secret_post` | `openid email profile` | `email_verified` and a `@gmail.com` address or an `hd` claim |
| OpenAI | OpenID Connect, `resource` `https://api.openai.com/v1` | S256 | required | `client_secret_basic` | `openid profile email` | `email_verified` |
| Anthropic (Claude) | OpenID Connect, ES256 ID tokens | S256 | required | `private_key_jwt` in a JSON body (no client secret exists) | `openid email profile` | `email_verified`, which Claude may leave out |
| Anaconda | OpenID Connect | S256 | required | `client_secret_post` | `openid profile email` | `email_verified` |
| Apple | OpenID Connect, `response_mode=form_post` | none offered | required | ES256 client secret JWT, 5 minutes | `email` | `email_verified` (Apple sends `"true"`) |
| GitHub | OAuth 2, no OpenID Connect; `/user` and `/user/emails` | S256 | no ID token | `client_secret_post` | `read:user user:email` | the primary address is `verified` |
| GitLab | OpenID Connect | S256 | required | `client_secret_post` | `openid email` | `email_verified` |
| Discord | OAuth 2; `/users/@me` | S256 | no ID token | `client_secret_post` | `identify email` | `verified` |
| LinkedIn | OpenID Connect | none offered | if present | `client_secret_post` | `openid profile email` | `email_verified` |
| WorkOS SSO | WorkOS SSO API, `connection` set | none (confidential client) | no ID token | API key | none | the verified domain; links by email only in a domain that requires SSO (see below) |

### Accounts and linking (design 5.2)

- A known method signs in to its account. A blocked account, or an account whose address is in a
  verified domain of an org that requires SSO (for any method but SSO, passkeys included: 0009
  redefines `uts.complete_passkey_sign_in()`), is refused.
- A new method links to an existing account only when the provider proves the address and exactly
  one account holds it as its primary email, or inside a browser session of the account with an
  open tier A `method_add` pass of that session, which the link consumes and the method's row
  keeps. Any other new method on an existing address is refused (`link_required`): the user signs
  in with a method the account has and links the new one.
- SSO accepts a profile only of the flow's connection and in a domain that connection's org
  verified, and outside a domain whose org requires SSO it never links by email. Inside such a
  domain every other method is refused, so SSO settles onto the one account that holds the
  address (`linkedBy: sso_required_domain`, with a notice): otherwise a member whose account
  existed before the org required SSO would be locked out (Q48 notices).
- A new account needs a proven address, so nobody can create an account under an address they do
  not control and wait for its owner to sign in. An SSO profile counts as proven by its domain.
  Its id is `uts_` and 26 lower-case base32 characters of 128 random bits, a form no app user id
  has, so accounts imported from the app keep their ids.
- Settling a new method takes a transaction-scoped advisory lock on the address first, so two
  first sign-ins of one address settle one after the other and only one account results.
- A refusal that names an account writes at most one denied row per account per minute; a link
  writes `ai.kilo.uts.sign_in_method.linked` and an in-app notice.
- A provider or SSO callback that comes back with `error` (the user cancelled) clears the flow's
  binder cookie; the flow row expires unused.
- The SSO start is a form post; it answers with a page that navigates to WorkOS (`continuePage`)
  instead of a redirect, because a browser applies the page's `form-action` to every redirect of a
  form submission, and WorkOS redirects on to the org's identity provider.

Email: one email carries a link and, unless codes are stopped for the address, a six-digit code;
both live 10 minutes. Only the newest code of an address counts: a new email exhausts every
earlier pending code (their links keep working). The fifth wrong code entry exhausts the code
(each wrong entry writes a denied row when the address has an account), but the email's link
keeps working, so wrong entries by someone else cannot lock the owner out. At most 5 codes per
address per hour; past that cap codes stop for 1 hour. The 20th wrong entry in a day stops codes
until that day window ends, exhausts every pending code, and gives the account a notice; while
codes are stopped every code entry is refused (`codes_stopped`). While codes are stopped an email
carries only its link, and at most 5 such link-only emails go to an address in its hour
(`send_limited`, 429, nothing stored or sent; migration 0020), so an address gets at most 10
sign-in emails an hour; the code emails are never capped by it. The link page names the address
(`p…@example.com`). The email start sets a binder cookie, like a flow's; a link opened in a browser
without it says so and signs in only after a second confirmation, so a link someone else asked
for cannot sign the reader into that person's account in one click. The address and the code are
stored as HMAC-SHA-256 values under `SIGNIN_EMAIL_HASH_KEY`.

A client network (an IPv4 /24 or an IPv6 /48; an IPv4-mapped IPv6 address counts as its IPv4
address) may enter 30 wrong sign-in codes an hour over all addresses
(`uts.network_email_code_failures`, migration 0018), as for wrong device user codes. Past that,
every code entry from the network is refused before any code is read (`network_limited`, 429):
nothing is counted and no audit row is written (decision Q56), and the email's link still works,
so a network shared with the owner cannot lock the owner out. A wrong code counts against the
network first, in one upsert that adds one only while the network is under 30, so concurrent
guesses wait on the network's row and cannot pass the limit.

The start and the code entry take only a plain addr-spec in lower case
(`src/signin/email/address.ts`: no display name, comment, quoting, comma, semicolon or space; the
domain follows the SSO domain rule), so one mailbox has one spelling and one set of per-address
limits, and Mailgun, which reads `to` as an address list, cannot be handed a second address.
`mailgunEmail` checks each recipient again before it calls Mailgun: it drops every address that
is not a plain addr-spec (in any letter case), logs only how many it dropped
(`uts.mail.recipient_invalid`), sends to the rest, and answers `no_target` when none is left.

**Mail sender.** The email sign-in is offered only where a sender is wired
(`src/signin/email/delivery.ts`):

- Mailgun, where `SIGNIN_EMAIL_HASH_KEY` and every mail setting are set (Configuration below). The
  sign-in page then carries Cloudflare Turnstile's widget in the email form (its CSP adds
  `https://challenges.cloudflare.com` to `script-src` and `frame-src`), and the start, in this
  order: takes one anonymous-write slot; checks the form's `cf-turnstile-response` once with
  siteverify (`src/signin/email/turnstile.ts`: the token must pass for action `email-sign-in` on
  the issuer's host; a refused token answers 400, a siteverify that fails or does not answer within
  3 s 503, a refused secret 500); outside production refuses an address that
  `UTS_MAIL_ALLOWED_RECIPIENTS` does not list (403, no row, no message; after Turnstile, so the
  allow-list cannot be probed without passing it); stores the email; and sends one plain-text
  message (link, code, expiry; tracking off; Mailgun gets 10 s). A Mailgun 429 or 5xx answers 503,
  any other refusal 502. Log lines carry outcomes, Cloudflare's error codes and setting names,
  never the token, the key, the secret or the address.
- The development entry's recording port (`GET /__dev/mail?to=`), when no mail setting is set. It
  sends nothing, so it needs no Turnstile check.

With neither, the routes answer 404 and the page does not offer email; with a partial or invalid
mail setting they answer 500 and log `uts.signin.misconfigured` with the names.

Cost per email start with Mailgun: one siteverify call and, once it passed, one
`uts.start_email_sign_in` statement and one Mailgun `POST /v3/<domain>/messages`; no audit row and
no queue message (an unauthenticated write names no account). A refusal by the recipient rule
costs the siteverify call only; a refused address form or the anonymous-write limit makes no
network call and no statement. A code entry is still one `uts.verify_email_code` statement; the
network count adds one primary-key probe, and one upsert on a wrong code. Neither route is on a
section 3 hot path.

Open items before deploy:

- The provider, SSO and email sign-in starts are anonymous sign-in writes (`src/signin/limits.ts`):
  per isolate, 10 a minute per IPv4 address or IPv6 /48, shared with passkey challenges and device
  authorizations, and SSO starts 60 a minute in their own window, because an org's staff often
  share one egress address. A refused start answers the sign-in page's message page with 429 and
  `Retry-After`.
- Past the code cap every sign-in email carries only the link, and at most 5 such link-only emails
  go to an address in its hour (migration 0020); the Turnstile check and the anonymous-write limit
  bound the rest. The code emails themselves have no total cap, because anyone could then spend
  the owner's emails and lock the owner out; a link already sent keeps working past the link-only
  cap. A code entry without a code hash raises 22004 (migration 0022).
- The minute cron calls `uts.maintain_provider_sign_in_rows()` beside
  `uts.maintain_sign_in_rows()` (`src/audit/maintenance.ts`), so flow, email and network-count
  rows do not grow without bound.

### Configuration

A method is offered only when every value it needs is set; with some set and others missing it is
not offered and its routes answer 500 (`uts.signin.misconfigured` log line, names only).

| Method | Vars | Secrets |
|---|---|---|
| Google, OpenAI, Anaconda, GitHub, GitLab, Discord, LinkedIn | `SIGNIN_<PROVIDER>_CLIENT_ID` | `SIGNIN_<PROVIDER>_CLIENT_SECRET` |
| Apple | `SIGNIN_APPLE_CLIENT_ID` (services id), `SIGNIN_APPLE_TEAM_ID`, `SIGNIN_APPLE_KEY_ID` | `SIGNIN_APPLE_PRIVATE_KEY` (P-256, PKCS #8 PEM) |
| Anthropic | `SIGNIN_ANTHROPIC_CLIENT_ID`, `SIGNIN_ANTHROPIC_ASSERTION_{AUDIENCE,ISSUER,SUBJECT,KEY_ID}` | `SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY` (P-256) |
| WorkOS SSO | `SIGNIN_WORKOS_CLIENT_ID` | `SIGNIN_WORKOS_API_KEY` |
| Email | `UTS_MAILGUN_DOMAIN` (the sending domain), `UTS_MAIL_FROM` (`Name <local@domain>` on that domain), `UTS_TURNSTILE_SITE_KEY`; outside production also `UTS_MAIL_ALLOWED_RECIPIENTS` | `SIGNIN_EMAIL_HASH_KEY` (32 bytes, base64url), `UTS_MAILGUN_SENDING_KEY` (a Domain Sending Key: messages on that domain only), `UTS_TURNSTILE_SECRET_KEY` |

The five mail settings (`UTS_MAILGUN_SENDING_KEY`, `UTS_MAILGUN_DOMAIN`, `UTS_MAIL_FROM`,
`UTS_TURNSTILE_SITE_KEY`, `UTS_TURNSTILE_SECRET_KEY`) are one switch for the sign-in mail and the
notice email: mail never leaves without the Turnstile check guarding the form that sends it.
`SIGNIN_EMAIL_HASH_KEY` gates only the email sign-in, not notices: with the mail settings on and
the hash key missing or invalid, the sign-in routes answer 500 while notice email still goes out. The
sender must sit on the sending domain (SPF and DKIM alignment), and Mailgun is called on its US API
host. `UTS_MAIL_ALLOWED_RECIPIENTS` is a comma-separated list of exact addresses
(`tester@example.com`) and whole domains (`@example.com`, no subdomains); staging and development
must set it, and production must not (either mistake makes the mail settings misconfigured). The
three vars are the switch: the secrets alone turn nothing on, so set `SIGNIN_EMAIL_HASH_KEY`,
`UTS_MAILGUN_SENDING_KEY` and `UTS_TURNSTILE_SECRET_KEY` with `wrangler secret put` first, then
deploy the vars in `wrangler.jsonc`; vars without both secrets make the routes answer 500. The
Turnstile widget lists the issuer host (`uts-staging.kiloapps.io`, `uts.kiloapps.io`) as its
hostname.

`SIGNIN_DEV_ENDPOINTS` (development only, loopback URLs only) points providers at local
stand-ins. Each registration lists the callback of its environment's issuer:
`https://uts-staging.kiloapps.io/signin/oauth/<provider>/callback` and
`https://uts-staging.kiloapps.io/signin/sso/callback` for staging, `https://uts.kiloapps.io/...`
for production.

`scripts/provider-signin-e2e.ts` runs the whole surface locally against
`wrangler dev -c wrangler.dev.jsonc` and three stand-in providers it serves itself (OpenID Connect,
GitHub-style, WorkOS-style): sign-in
-> code -> token for each, Apple's `form_post`, the email lock, the linking refusals, and a check
that no audit row names a token, a code or an address.

## Security notices

Design 5.13 and 8.4; migration `0010_notices.sql`, code in `src/notices/`.

**Sign-in recording.** Every new session records a sign-in in the statement that creates it, by an
`AFTER INSERT` trigger: on `uts.refresh_grants` for a device sign-in (the device is the grant's
DPoP key, the network comes from its device session) and on `uts.browser_sessions` for a browser
(the device is `device_key_hash`, which the web BFF sets from the browser's per-install key; NULL
counts as a new device every time). The trigger upserts `uts.known_devices` and
`uts.known_networks` and writes `uts.sign_ins`, which keeps the newest 50 sign-ins per account. A
network is `as<number>` when the autonomous system is known, else the /24 (IPv4) or /48 (IPv6)
prefix; a row unseen for 90 days counts as new again. The `new_device_network` notice fires only
when both the device and the network are new: a new address in a known autonomous system, or a
known device on a new network, fires nothing. "New" is decided by the upsert itself, so two
concurrent sign-ins from one new device and network fire one notice. A sign-in without network
data fires nothing. The account's first sign-in sets the baseline and fires nothing; an account
has a baseline once it has a known network, a recorded sign-in or another live session, and
migration 0010 fills `known_devices` and `known_networks` from the live grants and sessions that
exist when it runs, so an account that predates it is not treated as new.

**Notices.** A `uts.notices` row is the in-app notice, which the security page always shows. Its
producer writes it in the statement of the change (the PAT and bot key statements, the sign-in
trigger, later the method, email, device, CI policy, consent and revoke statements). `details`
holds the fields the text reads (`deviceKind`, `country`, `city`, `credential`, `method`, `change`,
`actor`, `flaggedKeys`), never a link or an email address. A trigger stores the account's primary
email in `recipient_email` when the row is written; an email change puts the replaced address in
`old_email`. Both are cleared when the notice finishes.

| Kind | Channels, in order |
|---|---|
| `new_device_network`, `sign_in_method_changed`, `primary_email_changed`, `credential_created`, `device_sign_in_approved`, `ci_trust_policy_changed`, `third_party_client_approved`, `sessions_revoked`, `suspicious_sign_in`, `bot_key_flagged` | push, then email |
| `sign_in_code_stopped` | push (sign-in emails are what the stop is about) |

Email always follows push: a device that receives push may be one a thief signed in, while the
address on file is the user's. The email goes to the address of the event time, to the address
on file at sending time when that differs (so an address changed after the event cannot take the
notice away), and for an email change to the previous address, each in its own message.

No channel carries a link, and none carries text that a client or a third party chose: a device
label, a platform string or an app name is the attacker's own words when the event is an attack
(a phone number, an instruction). The text names the event, the time, the approximate place from
the network (`placeName`: letters only), and the kind of device from a closed list (a web browser,
a desktop client such as the Kilo CLI, a mobile device), and points to the security page.
`plainText` refuses anything a mail client or a phone could open as a link. Email is plain text
with Mailgun tracking off.

**Delivery.** One delivery round is three steps, each its own statement or call, and the
identity-store connection is not held while a provider answers:

1. Claim (`uts.claim_notice`, `uts.claim_credential_notice`, `uts.claim_due_notices`): `pending`
   to `sending` with a new claim id; rows another statement holds are skipped, so one round runs
   once. A claim older than 5 minutes (its Worker stopped) can be claimed again before the third
   round. A pending notice written more than 24 hours ago is never claimed. The credential claim
   reads only the account's pending notices of the last hour.
2. Send push, then email, skipping the channels an earlier round settled. Each answers `sent`,
   `no_target`, `not_configured`, `retryable_failure` or `permanent_failure`; a provider that does
   not answer within 10 seconds is a retryable failure. A push receiver answer outside its outcome
   union is a permanent failure of push for the notice, logged as `uts.notice.push_refused` and
   never retried, and email still goes out. A push call that throws is retried like a timeout
   (also logged as `uts.notice.push_refused`): a binding throws for a network or deploy fault as
   well as for a refusal, so a push-only notice is not given up after one fault.
3. Finish (`uts.finish_notice`) with the round's attempts, one `uts.notice_attempts` row each. The
   notice is `pending` again (1 minute after round 1, 5 after round 2) while a planned channel only
   failed retryably, else `delivered` when a channel sent it, else `failed`. A finish under a claim
   that is no longer current changes nothing (`stale_claim`).

A notice is tried in at most 3 rounds and for 24 hours; the in-app row stays whatever happens.
Each background pass first settles up to 500 notices past those limits (delivered when an earlier
attempt sent them, else failed), without sending them. The account API's `CredentialNotices` port
(`src/notices/credential.ts`) claims the `credential_created` notice that the create statement
wrote and delivers it at once; `sweepNotices` delivers every other due notice and the retries:
it claims 20 at a time, oldest first, and claims again while a claim comes back full, at most 5
times and never 30 seconds after the pass began (up to 100 a minute), so a burst drains instead of
waiting past the 24-hour limit. Then it runs one retention step (`uts.maintain_notice_rows`, at most 500
rows of each kind): known devices and networks unseen for 90 days, and finished notices with
their attempts 400 days after they were written.

The minute cron (`src/scheduled.ts`, `noticeStep`) runs one `sweepNotices` pass after its
maintenance steps. No deployed environment has a push provider wired yet, so push settles as
`not_configured`. Email goes through Mailgun where the mail settings are on (Configuration under
"Sign-in providers, SSO and email"), behind the recipient rule: outside production an address that
`UTS_MAIL_ALLOWED_RECIPIENTS` does not list is dropped without sending, and a message left with no
address is `no_target` (`uts.mail.recipient_refused` log line, a count only). With no mail setting
at all email settles as `not_configured` too. With a partial or invalid mail setting (a deploy
error) the step claims nothing and runs only the retention step: a round then would settle every
due notice's email as `not_configured` for good, so the notices stay pending, and go out once the
settings are fixed within their 24 hours. Every notice shows in-app either way. With the mail
settings on, the account API's credential notice port delivers a created PAT's or bot key's notice
at once (claim, one Mailgun call, finish, in `waitUntil`); otherwise it stays null and the cron
delivers the notice.

| Channel | Provider | Adapter |
|---|---|---|
| Push | Expo push through the `notifications` Worker, which holds the users' Expo push tokens and the Expo access token: its named entrypoint `SecurityNotices`, bound with the mint Worker's deployed name (`UTS_MINT_DEPLOYMENTS` in `@kilocode/uts-contracts`) as `props.caller`; RPC `dispatchSecurityNotice` `{ userId, idempotencyKey, kind, title, body }` with no presence, preference or rate-limit suppression | `notificationsServicePush` |
| Email | Mailgun messages API, plain text, tracking off, one message per address | `mailgunEmail` |

Locally both channels use `fakeTransports` (`src/notices/fake-transports.ts`), which send nothing.

**Security view.** `GET /account/security` (scope `uts:security.read`, contract
`SecurityViewSchema`) is one statement on the read replica as `uts_reader`: it checks the caller's
grant and its device session and, only for a live session, lists the newest 50 sign-ins, the live
sessions, the passkeys, sign-in methods, live PATs, third-party consents and CI trust policies, and
the newest 50 notices with their attempts and their text. The `uts_read` views leave out client
addresses, device keys, `recipient_email` and `old_email`. The device labels, platforms, user
agents and app names in the sign-in, session and credential lists are the client's own raw text:
the page must render them as escaped text, never as markup or a link. The route needs the account
API's bearer check, so the deployed entry serves it once that check is wired; the development
entry serves it with a caller check from the `Kilo-Dev-Account` and `Kilo-Dev-Grant` headers.

`scripts/notices-e2e.ts` runs the whole path against `wrangler dev -c wrangler.dev.jsonc`: real code
exchanges (baseline, new device on a new network, a second new device, the first one again),
every notice kind through the development routes, a retried email through the background pass,
and the security view before and after `/revoke`.

## Subject operations and identity import

Design 5.2 and 5.6, migrations 0014 to 0016. The web app keeps owning some account authority
until its cutover (blocks, deletions, recoveries, email changes, organization SSO and memberships). It
enqueues each write in the same transaction as the app's own write, and its outbox sends it to UTS.
Each call is one statement with its audit row (actor: the calling workload; the app's own actor
string in `requestedBy`). It answers 200 only once a vouching feed object took the entries the
statement wrote.

**Callers.** Workers bind the mint Worker's named entrypoint `SubjectRevocation` with
`props.caller` (`SUBJECT_REVOCATION_CALLERS`, empty in staging and production until a caller
proof names one). The web app calls `POST <issuer>/internal/...` with an STS token for audience
`uts`, workload `web` (`UTS_INTERNAL_WORKLOADS`), and the route's one scope:

- `/internal/subjects/revoke` and `/unblock`: `uts:subjects.revoke`;
- `/internal/subjects/end-browser-sessions`: `uts:browser-sessions.end`;
- `/internal/subjects/end-device-sessions`: `uts:device-sessions.end`;
- `/internal/subjects/revoke-api-credentials`: `uts:api-credentials.revoke`;
- `/internal/accounts/import`: `uts:accounts.import`;
- `/internal/authority/email`, `/membership`, `/sso-organization`: `uts:authority.sync`;
- `/internal/app-events/read` and `/ack`: `uts:app-events.read`.

The token check is a port (`src/subjects/service-tokens.ts`). The deployed entry has none until
the mint Worker carries `@kilocode/verify`, so every `/internal/` route answers
`503 temporarily_unavailable` with `Retry-After: 60` and writes nothing; so does every route while
`IDENTITY_STORE` is unbound. The development entry takes a stand-in bearer,
`uts-dev-sts:<workload>:<scope>`, for the local run only.

**Operations** (`@kilocode/uts-contracts` `UTS_SUBJECT_OPERATIONS`). The body is
`{ operation_id, subject, reason, actor, source_version }`; `actor` is `user:<id>` or `admin:<id>`
(no whitespace, 1-255 characters) or `system:<source>` (`[a-z0-9_.-]`, 1-64); `source_version` is
0 to 2^53 - 1. An `operation_id` is kept 7 days; a repeat answers `already_applied` and hands the
entries of the first run to the feed again.

- `revoke` with `access_block`, `account_recovery` or `account_reset`: `revoked_before = now` (70
  minutes in the feed), every browser session, device grant, third-party family, PAT, CI trust
  policy and sandbox grant revoked, each grant and session with its `revoked_sids` entry and each
  PAT with its `revoked_pat_ids` entry; an approved device code becomes denied, an authorization
  code not yet exchanged is deleted and every third-party consent is revoked (migration 0021), so
  neither code becomes a grant and the consent screen comes back; the active org bot keys the
  subject created are flagged (audit rows and org admin notices), not revoked, because a key
  belongs to its organization. `access_block` also blocks the account and lists it in
  `blocked_accounts` for 70 minutes.
- `revoke` with `account_deleted`: the same, with `revoked_before` and `blocked_accounts` kept 24
  hours; the active bot keys the account created are flagged (audit rows and org admin notices);
  then the row and everything it holds are deleted, and a deletion tombstone stays for good.
- `unblock` with `access_unblock`: `409 retry_later unblock_too_soon` with `Retry-After` (1-60)
  while the block is under 60 seconds old; then the account is active again, and an
  `unblocked_account` entry takes it out of `blocked_accounts`. Nothing revoked comes back: a
  revoked session, grant, family, PAT or CI trust policy, or an ended sandbox grant, keeps its
  status (triggers, migrations 0001 and 0014).
- `end-browser-sessions` (`staff_signout`, `workos_relink`, `scim_mailbox_move`,
  `apple_consent_revoked`): browser sessions only. `end-device-sessions`
  (`apple_consent_revoked`): CLI, IDE, extension and mobile grants only.
  `revoke-api-credentials` (`staff_api_reset`): PATs only. None writes `revoked_before`.

Outcomes: `200 applied | already_applied | no_subject`; `409 retry_later` (with `Retry-After`);
`409 refused` with `account_deleted` (an unblock of a deleted subject) or `reason_not_allowed`;
`400 invalid_request` (a malformed body, or an `operation_id` reused for another operation);
`401`/`403` for the token; `503 temporarily_unavailable` with `Retry-After`. The outbox retries
only `503`, `retry_later` and network errors.

**Source versions and tombstones.** Each kind of authority has its own high-water mark:
`uts.accounts.status_version` for block and unblock, `email_version` for the primary email, and
each membership row's `event_version`. A block, unblock, email sync or membership change older
than its own mark is superseded (`already_applied`, nothing changes); revocations and session ends
neither read nor raise a mark. An operation for a subject UTS does not hold answers `no_subject`
and writes a tombstone. `uts.import_account` reads them first: a deletion refuses the import for
good, a block imports the account blocked (unless a later unblock), a revoke sets
`revoked_before`, and an import older than any tombstone is `stale`. `uts.subject_revoked_since`
reads the account's `revoked_before` too, so a legacy session issued before a revocation stays
refused after the 70-minute feed row expired.

**Import** (`AccountImportRequestSchema`): the app user id (never `uts_`), the primary email, the
status, the verified provider identities with their link times, the SSO tie
`{ app_organization_id, workos_organization_id, workos_connection_id, role }`, the passkeys (each
with the WebAuthn user handle it was created under; the relying-party id is the Worker's), and the
source version. Every check runs before the first write: `imported` or `already_imported`;
`409 retry_later sso_connection_unknown` until the organization's SSO sync arrives; `409 refused`
with `deleted`, `stale`, `identity_taken`, `email_taken`, `passkey_taken` or
`sso_authority_mismatch` (also for a WorkOS identity without an SSO tie, on a connection of
another organization, or on an inactive connection).

**Authority sync.** `email` moves the primary email forward by version (the audit row names no
address) and deletes the subject's `email` sign-in methods of other addresses; an address another
account still holds as its primary email or `email` method answers `409 retry_later email_taken`
(`Retry-After: 30`, nothing written), so two subjects' syncs may arrive in either order;
`membership` adds, changes or (with `role: null`) removes a membership through
`uts.remove_org_member`, ordered by the subject's version, and a newer sync that changes nothing
still raises the row's version; `sso-organization` writes the SSO policy,
the WorkOS organization whose `externalId` is the app organization, its connections and its
verified domains (`verified_domains`: lower case, each once, at most 100), ordered by the
organization's own version. The domain set replaces the organization's: a domain left out is
deleted, so `POST /signin/sso/start` answers that SSO is not set up for it; the audit row counts the
domains and names none (migration 0015). Domains follow `SsoDomainSchema` in the contract and in
the table check (migration 0016), and the sync inserts connections and domains in sorted order, so
two organizations' syncs never deadlock. A connection active in another organization never moves
(`409 retry_later connection_conflict`), nor does a domain verified by another organization
(`409 retry_later domain_conflict`); both carry `Retry-After: 30`, write nothing, and apply also
when another organization's sync takes the connection or domain during this one. A sync older than
the version already applied is `already_applied` without these checks, so a late older sync never
waits on a connection or domain that moved on. UTS holds no DNS challenge for a synced domain (the
app verified it through WorkOS), so `dns_challenge_hash` is required only while a domain is
pending. The authority check behind the legacy bridge and `sso_app_organization` is
`uts.sso_app_organization` through `src/subjects/authority.ts`: verified
only when the connection is active, belongs to that WorkOS organization, maps to the app
organization, and the active account holds an active membership there.

**The user-created event.** Inserting an account with a `uts_` id writes one `uts.app_account_events`
row in the same statement (trigger `accounts_user_created`). The app reads the oldest with
`/internal/app-events/read` `{ limit }` and acknowledges with `/internal/app-events/ack`
`{ event_ids }`, which deletes them; a deleted account takes its unread event along. Each event is
`{ event_id, type: "user.created", occurred_at, account: { id, primary_email } }`; the app creates
its user row with `account.id` as the user id, idempotently.

`scripts/subjects-e2e.ts` (`UTS_E2E_BASE_URL`, `UTS_E2E_FEED_URL`, `UTS_E2E_ADMIN_URL`) plays the
outbox against the mint and feed Workers: the import cases, each operation's effect on a CLI grant,
a mobile grant, a PAT and a browser session with its feed entries, the unblock wait, a 503 while no
feed object answers, terminal deletion, the user-created event and the audit rows.

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
- `pnpm test:script`: the sign-in pages' browser script (`test/script`), run against the rendered
  pages in a fresh `node:vm` context with stand-ins for the DOM, `fetch` and WebAuthn.
- `pnpm test` runs all three; none needs Postgres. `pnpm test:postgres` runs the identity store
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
order). A change to only one of them deploys in the matrix. The feed Worker asks for the feed
objects' keys (`signerKeys({ feeds: true })`), and the mint Worker adds the `feeds` field only
then: the feed Worker of the release before feed objects asks with no request and parses the answer
strictly, so it keeps serving signer keys during the deploy window and after a rollback of either
Worker. The answer schema drops top-level fields it does not name, so a later field needs no such
step. Every grant statement calls `uts.feed_entries_of_statement()`, so apply migration 0006 to an
environment's identity store before that environment binds `IDENTITY_STORE`; the code exchange,
third-party refresh and `/revoke` fail until it is applied.

Provisioning the identity store's Hyperdrive configs for an environment: the mint Worker's var
`PAT_LOOKUP_CONNECTIONS` holds the PAT lookup config's (`IDENTITY_STORE_PAT`) connection limit, and
each isolate runs at most min(100, 3 × `PAT_LOOKUP_CONNECTIONS`) PAT lookups at once
(`patLookupsInFlight` in `src/env.ts`, design 3, "PAT lookups"). Staging sets 12 (cap 36);
production sets 32 (cap 96), the PAT config's 20 percent of `max_connections` 160. A change to the
config's connection limit changes the var in the same deploy. Staging and production refuse to
start without a valid var; development may leave it out (cap 100).

Staging and production bind all three configs in `wrangler.jsonc`; both identity stores hold
migrations 0000 to 0014. `test/repo` fails a deployed block whose Hyperdrive bindings differ from
`IDENTITY_STORE_HYPERDRIVE` in `test/repo/worker-configs.ts`, or that names a local connection
string. Apply a new migration to both stores before the deploy that needs it.

The deployed entry checks STS tokens with `@kilocode/verify` against the environment's STS issuer
(`STS_ISSUERS`), audience `uts` (`src/sts-callers.ts`). `STS_CALLER_WORKLOADS` lists the workloads
each environment admits on the broker exchange and the `/internal/` routes; production lists none.
An unreadable STS key set answers 503, never an admission.

### Provisioning per environment

| Setting | Kind | Value |
|---|---|---|
| `IDENTITY_STORE` | Hyperdrive binding | The identity store's primary config (design 5.2); unset, no OAuth or sign-in endpoint is served |
| `IDENTITY_STORE_PAT` | Hyperdrive binding | The PAT lookup config (logins `uts_pat_a`, `uts_pat_b`); unset, no PAT lookup is served |
| `IDENTITY_STORE_REPLICA` | Hyperdrive binding | The read-replica config (logins `uts_reader_a`, `uts_reader_b`) for the account views |
| `WEBAUTHN_RP_ID` | var | The relying-party id: the app host whose passkeys users hold in production (`app.kilo.ai`); the issuer host in staging (`uts-staging.kiloapps.io`), which keeps its own passkeys |
| `WEBAUTHN_ORIGINS` | var | The issuer origin; in production the app host must list it in `/.well-known/webauthn` (WebAuthn related origins, design 5.14) before its passkeys work here |
| `DEVICE_USER_CODE_KEY` | Worker secret | 32 random bytes in base64url, the HMAC key of RFC 8628 user codes; unset or malformed, the device grant is not served and every other route works (a malformed value logs `uts.signin.misconfigured` with the name on each device page request). Set with `wrangler secret put DEVICE_USER_CODE_KEY --env <env>` from a generated value, never a copied one |
| `SIGNIN_GITHUB_CLIENT_ID`, `SIGNIN_GOOGLE_CLIENT_ID`, `SIGNIN_GITLAB_CLIENT_ID`, `SIGNIN_DISCORD_CLIENT_ID`, `SIGNIN_LINKEDIN_CLIENT_ID` | var | The OAuth client ids of the GitHub, Google, GitLab, Discord and LinkedIn sign-in registrations; staging sets all five, production sets none, so production offers none of these providers (Sign-in providers, "Configuration") |
| `SIGNIN_GITHUB_CLIENT_SECRET`, `SIGNIN_GOOGLE_CLIENT_SECRET`, `SIGNIN_GITLAB_CLIENT_SECRET`, `SIGNIN_DISCORD_CLIENT_SECRET`, `SIGNIN_LINKEDIN_CLIENT_SECRET` | Worker secret | The client secrets of those registrations, set only where the matching client id is set. Copy each from the environment's `/workloads/uts` folder in the secrets manager with `wrangler secret put <name> --env <env>` reading standard input, before the deploy that adds the client id |

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
| `uts_app` | `uts_app_a`, `uts_app_b` | Primary: mint, sign-in, refresh, revoke, account API, audit relay | DML on the ungated credential tables; on gated rows (CI trust policies, third-party consents) SELECT, DELETE and UPDATE of lifecycle columns only; PATs, org bot keys and gate passes SELECT only, written only through the account functions (migration 0005); codes, grants, device sessions, third-party families and tokens, revocations and DPoP proof `jti`s only through the OAuth functions, and passkeys, browser sessions, step-ups, device codes, tickets, WebAuthn challenges, sign-in methods, email codes and wrong user-code counts only through the sign-in functions (migration 0008), keeping SELECT on them; notices SELECT only, written by the statement of a change and moved only by the notice functions (migration 0020); INSERT on chosen audit columns and SELECT on audit rows; SELECT on relay watermarks, which it moves only through `uts.advance_audit_watermark()`; `uts.maintain_audit_partitions()`, `uts.maintain_oauth_rows()`, `uts.maintain_sign_in_rows()`, `uts.maintain_provider_sign_in_rows()` and `uts.end_long_transactions()` |
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
30 seconds ago, a limit the caller cannot change. The minute cron calls it first, so such a
transaction ends within about 90 seconds (30 seconds plus the cron period). The relay's horizon is
the oldest open transaction of the whole server, so the alert on an unrelayed row older than 60
seconds covers sessions of other logins and in other databases.

### Manager login for rotation copies

After a rotation, UTS writes the new password to `/admin/identity-store` in the secrets manager as
a new secret named `<login>_<YYYYMMDD>_<HHMMSS>` (design 5.2). It logs in as `uts-rotation-<environment>`
with Infisical JWT Auth, the way STS logs in as its own identity:

- One object, `<environment>:manager-auth` in the `eu` jurisdiction (`src/dos/UtsManagerAuthDO.ts`),
  holds an ECDSA P-256 login key. It generates the key at the first login and never exports the
  private half. It is not a token signer key.
- `GET /manager-auth/.well-known/jwks.json` on the issuer host serves the public half. Before the
  first login the set is empty; while the object fails it answers 503 with `Retry-After: 30`, never
  500. An isolate keeps the key set for 60 seconds, and an empty set or a failure for 5 seconds, so
  a client that polls the route reaches the one key object at most once per window. A login JWT
  signed in an isolate drops that isolate's empty set, so its next read asks the object again. A
  manager read that reaches another isolate can still get the empty set for up to 5 seconds after
  the first login; that login is refused and the next rotation run logs in again.
- A login JWT lives 2 minutes, with issuer `<issuer>/manager-auth`, subject
  `uts:<environment>:rotation` and audience `https://eu.infisical.com/identities/<identity id>`.
  The identity ids are in `src/manager/config.ts`.
- `ManagerClient` (`src/manager/client.ts`) exchanges the JWT at
  `/api/v1/auth/jwt-auth/login` and only creates and describes secrets in `/admin/identity-store`.
  A create under the folder's change policy answers `approval_pending`.

`pnpm exec tsx scripts/manager-auth-e2e.ts` runs the mint Worker under `wrangler dev` with a
stand-in manager on loopback (`UTS_E2E_PORT`, default 9470, and +1, +2). The stand-in fetches the key
set and verifies the login JWT against it, as Infisical does. The run uses no real manager.

#### Emergency removal of the manager login key (runbook)

The login key has no rotation yet. If its storage may be exposed, or UTS must stop writing to the
manager at once:

1. Cut UTS off in Infisical: remove the JWT Auth method of `uts-rotation-<environment>`, or point
   it at another key set, and revoke the identity's access tokens. Infisical then refuses every
   login JWT this key signs; a token issued before lives at most 10 minutes. Until step 3, UTS
   cannot write recovery copies to `/admin/identity-store`.
2. Wipe the key: the Worker has no route that deletes it, so ship a reviewed change that renames
   the class in code (for example `UtsManagerAuthDO` to `UtsManagerAuthV2DO`), points the
   `UTS_MANAGER_AUTH_DO` binding of every environment at the new name, and adds one migration tag
   with `deleted_classes: ["UtsManagerAuthDO"]` and `new_sqlite_classes` for the new name. Do not
   use `renamed_classes`, which keeps the stored key. A delete migration removes every object of
   the class with its storage
   (https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/).
   The next login creates a fresh key.
3. Restore the JWT Auth method in Infisical with the same key-set URL, issuer, subject and
   audience, and check that `GET /manager-auth/.well-known/jwks.json` lists only the new `kid`
   after the first login. An isolate of the old version can serve the old set for up to 60
   seconds, and the answer allows HTTP caches the same 60 seconds.

### Login rotation

The rotation job (`src/rotation/`, run by `src/dos/UtsLoginRotationDO.ts`) gives each pool's idle
login a new password and then switches the pool's Hyperdrive config to it (design 5.2). The pools
are app (`IDENTITY_STORE`, `uts_app_a/b`), pat (`IDENTITY_STORE_PAT`, `uts_pat_a/b`) and reader
(`IDENTITY_STORE_REPLICA`, `uts_reader_a/b`).

- **Switch.** `LOGIN_ROTATION` is `off` in every deployed block of `wrangler.jsonc`, and the job has
  no schedule of its own: the minute cron calls the rotation object only where the var is `on`.
  Turning it on, and provisioning the secrets below, belong to the later rotation phase; until then
  the job runs only locally against a local Postgres and stand-ins (`scripts/rotation-e2e.ts`).
- **State.** One object, `<environment>:login-rotation` in the `eu` jurisdiction, keeps one phase
  (`idle`, `altering`, `storing`, `awaiting_approval`, `switching`, `lost`) and each login's current
  password, sealed with AES-256-GCM under a key it generated and stores beside them. Sealing keeps
  passwords out of storage dumps and traces; it does not protect against a reader of the object's
  storage. A run reads the state first and builds no client when nothing is due; it commits after
  each step, and a result whose base revision is no longer stored is dropped. A second run in the
  same object returns `busy`. If the object's storage is lost, every login is unknown to it: the
  next cycle stops at the missing seed, or a login whose seed no longer works goes to `lost`. That
  fails safe; the configs keep serving with the login they hold.
- **Pinned origins.** `ORIGIN_PINS` (`src/rotation/config.ts`) names the host, port and database
  each pool's config must hold. The job refuses the `ALTER` when the primary config's origin
  differs, and the `PATCH` when the pool's config origin differs, so a config edited to another
  host never receives a password. Staging and production pin nothing yet, so they are
  `misconfigured`; the rotation phase pins them in a reviewed change.
- **Cycle.** The due pool that switched longest ago goes first (every 30 days). The job reads the
  config's login, takes the other login of the pair, seals a new random password as pending,
  connects as that login over a direct socket to the pinned primary and runs
  `BEGIN READ WRITE; ALTER ROLE CURRENT_USER PASSWORD '<SCRAM verifier>'; COMMIT`. The password goes
  only into a SCRAM-SHA-256 exchange: if the server asks for a cleartext or MD5 password, the
  session ends before the password leaves the Worker and the step is refused. After a crash it
  tries the pending password first, then the current one. If neither logs in, the phase is `lost`
  and an error is logged each hour until a seed for that login logs in.
- **Manager.** It creates `<login>_<YYYYMMDD>_<HHMMSS>` (the UTC time of the request) in
  `/admin/identity-store`. Under the change policy it waits in `awaiting_approval`, checks with
  `describeSecret` every hour for this request's name only, and logs
  `uts.login_rotation.approval_overdue` once a day from 24 hours on. A request still missing after
  72 hours counts as rejected or expired: the job logs `uts.login_rotation.approval_expired` and
  asks again under a new name with the same password. Only the newest request counts: a secret
  admin approves the newest `<login>_…` request and rejects any older one of the same login, since
  an older one is never checked again. A retry after a lost create answer describes first, so it
  never asks twice.
- **Hyperdrive.** Only from 02:00 to 05:00 UTC and at least 5 minutes after the previous switch, it
  patches the config's user and password through the Cloudflare API, keeping its scheme, host,
  port and database, then reads the config with a GET and refuses the step if the user differs. It
  refuses to patch an origin with fields it does not rebuild (such as an Access client id), which
  the patch would drop.
- **Failures.** A timeout, 429, 5xx or lost connection waits 1 minute (never less in a deployed
  environment) and warns (`uts.login_rotation.retry`); a refusal waits 1 hour and logs an error
  (`uts.login_rotation.refused`).

Secrets (decision Q88; nothing is provisioned before the rotation phase):

| Name | Where | Value | Provisioned by |
|---|---|---|---|
| `UTS_HYPERDRIVE_SWITCH_TOKEN` | UTS STS bundle (`/workloads/uts`, policy `services/sts/policy/uts.yaml`, binding `STS` with caller `uts`) | Cloudflare API token of a dedicated account member, Hyperdrive edit only | A secret admin, per environment |
| `uts_app_a` … `uts_reader_b` | `/db-switch/uts`, one secret per login | The first password of that login | Provisioning, per environment |

Only `uts-rotation-<environment>` reads the seeds, through `ManagerClient.readLoginSeed`, with
`readValue` on `/db-switch/uts` and nowhere else; the rotation phase grants it. No STS policy reads
that folder (the `/db-switch` convention of design M8). The switch token stays in the STS bundle:
the job sends it on every Cloudflare API call, the bundle is how a Worker gets its secrets, and
moving it would widen the rotation identity's read grant beyond the seeds.

The object reads a login's seed only when it holds no password for that login, or for a `lost`
login. A secret admin deletes each seed once the job has rotated that login (the
`uts.login_rotation.altered` log names it): until then, an unrotated login keeps its provisioning
password. For a `lost` login, a secret admin writes its password back as that login's seed after a
break-glass read of `/admin/identity-store` (design 4.3), and deletes it again once the job has
rotated that login.

**Preconditions before the rotation phase turns the job on in an environment:**

1. **TLS to the direct host.** A Worker's socket verifies TLS only against the platform's public
   roots and cannot pin the Supabase CA, so the direct host may fail the handshake. A deployed
   handshake test from a Worker against the environment's direct host must pass first. The job
   never connects with `rejectUnauthorized: false`; if the test fails, the alternatives are a host
   whose certificate chains to a public root, or running the `ALTER` where the Supabase CA can be
   pinned (for example the migration proxy's Container), each recorded in design Q88.
2. **A config edit under load.** The local end-to-end run does not go through Hyperdrive: its
   clients open their own connections with the stand-in config's login. How a Hyperdrive pool
   behaves when its config's login changes is not verified here, so a real `PATCH` of a staging
   config under load, with no failed query, must pass first (design trial check 4).
3. **The switch token.** At provisioning, check the token with `GET /user/tokens/verify` and its
   policies: Hyperdrive edit only. The permission covers every Hyperdrive config in the account,
   which is why the origins are pinned. With the real `uts-rotation-<environment>` identity, also
   check the seed read: `GET /api/v4/secrets/<login>?projectId=<project>&environment=<slug>&secretPath=/db-switch/uts&viewSecretValue=true&expandSecretReferences=false&includeImports=false`
   answers 200 with `secret.secretValue` for a seed that exists and 404 for one that does not, and
   the same read of any other folder is refused.
4. **The origins.** Pin the environment's direct host, port and database for each pool in
   `ORIGIN_PINS`.

**Open item:** STS has no `uts` workload policy yet (phase 2 adds it), so `wrangler.jsonc` binds no
`STS` for now and the job, which is off, would report `misconfigured` (`missing STS`). With that
policy, add the binding to the top level and to `env.staging`: `{ "binding": "STS", "service":
"sts" (`"sts-staging"` in staging), "entrypoint": "SecretsBroker", "props": { "caller": "uts" } }`.

`pnpm exec tsx scripts/rotation-e2e.ts` runs the full a -> b -> a rotation locally: the mint Worker
under `wrangler dev`, a stand-in manager and Cloudflare API on loopback (`UTS_E2E_PORT`, default
9560, and +1 to +3), and a local Postgres (`UTS_E2E_ADMIN_URL`). Clients that loop queries must see
no failure.

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
- A security guard never compares a caller input with `<>` or `NOT` alone: a NULL makes the guard
  NULL and skips the refusal. Each SECURITY DEFINER statement refuses a missing required input
  first (`uts.require_inputs`, SQLSTATE 22004) and compares with `IS DISTINCT FROM`.
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
  most 100 live bot keys, counted behind a lock; behind the same lock an account creates at most 20
  PATs and an organization gets at most 20 bot keys in any hour (migration 0019), which bounds the
  feed entries a create-and-revoke loop can add.
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
  together; it keeps SELECT on those tables. Accounts, memberships and the SSO tables it writes not
  at all since migration 0019: only security-definer functions change them. It still writes the
  ungated credential tables directly.
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
shard (`id % 8`). Each shard publishes as its own audit stream, `uts:<environment>:<shard>`, and
`last_seq` numbers that stream's batches.

The relay (`src/audit/relay.ts`) is one Durable Object per shard (`UtsAuditRelayDO`, named
`<environment>:audit-relay:<shard>`). It finds its shard by comparing its id with the id of each
shard's name, not by `ctx.id.name`, which an alarm after an eviction or a deploy does not carry;
an object whose id is no shard's in this environment and jurisdiction refuses to run. Its alarm
runs every 5 seconds: it reads up to 500 rows past
the watermark, sends them as one gzipped `AuditBatch` to `AUDIT_QUEUE`, the environment's UTS
audit queue `kilo-audit-uts[-staging|-local]` (halving any batch the encoder refuses, so each
message stays under 60 KB), and moves the watermark after each message the queue accepted, only
from the `last_seq` it read. Only UTS sends to that queue, so the audit relay service accepts only
the 8 `uts:<environment>:<shard>` streams from it (design decision Q66). A run reads at most 10
times; one that reached that budget runs again at once. A failed run leaves the watermark in place.
What comes next depends on the failure (`src/audit/relay-schedule.ts`):

- **Retryable** (a connection, lock or statement timeout, or a queue send that threw): the next run
  waits 5 seconds, doubling per failed run in a row up to 60.
- **Permanent** (the database refused a statement, or a single row does not fit a message): the
  next run waits 60 seconds at once. The run logs `uts.audit_relay.failed` with
  `failure: "permanent"`, which pages; retrying sooner cannot help.
- **Superseded** (another runner moved the watermark first, as during an overlapping deploy):
  nothing failed, so the next run comes after the usual 5 seconds, the failure count stays as it
  was, and the run logs only a `uts.audit_relay.superseded` warning.

The object keeps its count of failed runs in a row in its storage, so the backoff holds when the
runtime evicts it between alarms; a good run deletes the count. A batch the queue took before a
failure is sent again under the same sequence numbers, and the audit relay service dedupes it
against its archive, so a shard has no gap and no lost row.

The watermark moves only through `uts.advance_audit_watermark()` (migration 0002, SECURITY
DEFINER); the app login has no UPDATE on the watermarks. The function locks the shard's row and
accepts a move only from the current `last_seq`, forward, to a row of the shard below the oldest
open transaction, and only when the sequence advances by exactly the count of the shard's rows it
passes (1 to 500, one index range read). A login that moves a watermark without sending therefore
leaves a sequence gap, which the audit relay service holds and pages, rather than a silently
skipped row.

There is no archive confirmation: UTS cannot bind the archive or the audit relay service. A
partition is dropped only when every row in it is relayed and it is past the 7-day tier, which
leaves the audit relay service days to retry on top of the queue's own retries. The watermark
marks the newest row the queue accepted (the comment on the table in `0002_audit_outbox.sql`).

The relay read for one shard has this shape (`RELAY_READ` in `src/audit/outbox.ts`;
`test/db/audit-maintenance.test.ts` checks the plan):

```sql
SELECT watermark.last_seq AS watermark_seq, event.*
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

The minute cron (`src/scheduled.ts`) arms the 8 relay objects and, on one connection, ends UTS
transactions over 30 seconds (`uts.end_long_transactions()`), runs partition maintenance, the
partition alerts, OAuth, sign-in and provider sign-in row maintenance and the lag check
(`src/audit/maintenance.ts`), then one notice sweep. Each step logs its own failure and the next
step still runs, so a partition call that gives up still leaves the kept-partition alerts and the
runway check to run. It does nothing while `IDENTITY_STORE` is unbound. Its error log lines are
the alert signals for an Axiom monitor:

| Log event | Meaning |
|---|---|
| `uts.audit_relay.lagging` | A shard's first unrelayed row is over 60 seconds old (`shard`, `ageSeconds`) |
| `uts.audit_relay.failed` | A relay run failed (`stream`, `failure`: `retryable` or `permanent`, `reason`, `failedRuns`, `retryInMs`) |
| `uts.audit_relay.not_started` | The cron could not arm a shard's relay object |
| `uts.audit_partitions.kept_unrelayed` | A partition past the 7-day tier still holds an unrelayed row |
| `uts.audit_partitions.runway_short` | Fewer than today's and the next 7 days' partitions exist |
| `uts.oauth_rows.behind`, `uts.sign_in_rows.behind`, `uts.provider_sign_in_rows.behind` | A kind still deleted a full batch on the run's last maintenance call |
| `uts.maintenance.transaction_ended` | The cron ended a UTS session whose transaction passed 30 seconds (`login`, `ageSeconds`) |
| `uts.maintenance.failed` | A cron step failed (`step`, `sqlState`, `constraint`, `table`) |

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
handles at most 5,000 rows of each kind and returns one `(kind, deleted)` row per kind. The minute
cron calls it until every count is under 5,000 (at most 20 calls per run). `uts_app` holds EXECUTE
on it; it takes no input and every step is time- or status-gated, so a caller can only do the same
work sooner. A dedicated maintenance role needs its own login and Hyperdrive config, and is not
provisioned yet. It handles:

| Rows | When | Why that is safe |
|---|---|---|
| `blocked_client_families` | A live family of a blocked client: revoked (`client_blocked`) with its feed entry, not deleted, so `deleted` counts the families this call revoked; rows a refresh holds wait for the next call (`SKIP LOCKED`) | Every read already refuses the blocked client, so the batch only makes the revocation reach the verifiers; the client's unblock waits until this reports 0 |
| `authorization_codes` | 1 hour past the code's 60-second lifetime, used or not | Until then a second use of a used code still revokes its grant |
| `third_party_refresh_tokens` | The current token of a family that is revoked or past its 90-day end | It fails anyway: every reader checks the family's status, so a family revoke writes only the family row |
| `third_party_rotated_tokens` | Past the family's 90-day end, oldest first | No token of the family can be issued or refreshed again, so no reuse check needs the tombstone. Until then a replaced token that comes back revokes the family, however long ago it was replaced |
| `revocations` | Past `feed_expires_at` | The feed no longer carries the entry |
| `dpop_proofs` | Past `expires_at` (121 seconds), read through `dpop_proofs_expires_idx` (migration 0007), so a call reads only expired proofs | No clock accepts the proof again |

It never deletes a grant, a family row, the current token of a live family, a tombstone of a
family that can still issue tokens, or a code within its lifetime (`test/db/oauth-grants.test.ts`).
At one mint per active client every 8 minutes, the DPoP rows arrive at 21, 104 and 417 per second
for 10k, 50k and 200k clients: 1,250, 6,250 and 25,000 per minute; in a steady state tombstones
age out at the rate they arrive, at most the same per third-party family, so a cron that runs
every minute makes 1 to 5 calls.

`uts.maintain_sign_in_rows()` (migration 0008) does the same for the sign-in rows, on the same
terms (5,000 per kind per call, no input, time-gated, `uts_app`), and the minute cron calls it
beside `uts.maintain_oauth_rows()`, with `uts.maintain_provider_sign_in_rows()` (migration 0009):

| Rows | When | Why that is safe |
|---|---|---|
| `webauthn_challenges`, `device_codes`, `tickets`, `step_ups` | 1 hour past their lifetime (5 minutes, 10 minutes, 60 seconds, 10 minutes), used or not | No statement accepts them after their lifetime |
| `account_user_code_failures`, `network_user_code_failures` | 1 hour after the window's first wrong code | The next wrong code after the hour starts a new window anyway |
| `browser_sessions` | 1 day after the session ended (idle end, absolute end or revocation), unless a row still refers to one of its gate passes (a passkey, PAT, bot key, CI trust policy, third-party consent or device code); cascades to its challenges, codes, step-ups and passes | An ended session never answers again; a credential's foreign key would refuse the cascade, so only such a session stays, one per credential. A pass nothing refers to, such as a device approval's once its code is deleted, keeps nothing. A kept session gets `cleanup_kept_at` and is looked at again a day later, so a call reads about a 1,440th of the kept sessions rather than all of them |

Row growth: with one sign-in per active client per 14 days, a session lives at most 31 days, so
about 2.2 session rows (about 300 bytes each) per client: 7 MB at 10k clients, 33 MB at 50k and
132 MB at 200k. The short-lived rows hold their rate times about 70 minutes, far less; a wrong
user-code count holds one row per account or client network that entered a wrong code in the last
2 hours.

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
