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
- RFC 9728 protected-resource metadata is not served yet: UTS becomes a protected resource with the
  account API, which publishes its own document at `/.well-known/oauth-protected-resource` then.
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
  and then answers every call with `misconfigured`, a deploy error that no retry fixes;
- publishes the public halves under `uts-token-<signer>-<RFC 7638 thumbprint>`;
- signs with `sign(claims)`: a compact JWS with header `alg: EdDSA`, `typ: at+jwt`, `kid`. It refuses
  a claim set with another issuer or environment, an `iat` more than 60 seconds from now, or an
  `exp` more than 1 hour ahead, the longest UTS token lifetime. `src/keys/claims.ts` is the
  signer's admission check; the published claim contract is phase 2's `AccessTokenClaimsSchema`
  (`@kilocode/sts-contracts`), and every claim set the signer accepts also passes it. A mint signs
  its 1 to 8 tokens in one `signMany(claims[])` call: each claim set passes the same check, one
  refused set refuses the batch, and all tokens carry the same `kid`;
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
  the revocation-feed entry: verifiers reject the `kid` until `revokeUntil`. The feed carries such
  an entry as kind `kid` in `uts.revocations` ("Revocation feed" below). No route calls
  `removeKid` yet: it stays unreachable until the operator route exists, which writes that entry,
  audits and alerts on each removal;
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
feed isolates spread evenly over the 8 shards. Each shard holds, as plain data in memory:

- a copy of its last combined answer, served for 2 seconds, with one read in flight; a request
  that needs that read polls for it. The 16 signer objects therefore see at most 8 reads per 2
  seconds, however many feed isolates ask;
- every signer's last good keys. A signer whose call fails, or whose object refuses to load,
  answers those keys with their own `readAt` while they are under 24 hours old, and its failure
  after that; each failure is logged with the read time of the keys that stood in.

Every signer call of a read, retries included, ends within 5 seconds, and every entrypoint call to
its shard, retries included, within 8 seconds, so a hung object cannot hold a read past the feed
Worker's 10-second read guard. Each RPC result, from a signer and from a shard, is copied out and
disposed. A shard stores nothing: a restarted shard reads the signers again.

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
and any drift in the UTS configs (names, `eu` jurisdiction, placement, traces).

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
  its KV storage with the signer's 30-day rotation and published next key (`uts-feed-<n>-<thumbprint>`),
  only while its last good backfill started under 60 seconds ago, and over more than 50,000 live
  entries never; a head is signed again once 5 seconds old or when the list changed;
- serves its current list and the 4 before it by hash.

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
cd services/uts && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
cd services/uts-feed && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
curl -s http://localhost:8801/.well-known/jwks.json
```

The local revocation-feed run (`scripts/feed-e2e.ts`) needs the mint Worker with `IDENTITY_STORE`
(below), the feed Worker and the verifier Worker of `services/uts-feed/test/fixtures/e2e` running
together, with `UTS_E2E_BASE_URL`, `UTS_E2E_FEED_URL`, `UTS_E2E_READER_URL` and
`UTS_E2E_ADMIN_URL` set. It checks that a revoke reaches the feed within 11 seconds, that the
backfill adds an entry no publish carried, that the feed serves from feed object 1 while
`POST /__dev/feed/stop` (development only, `src/dev-feed.ts`) stops feed object 0 for 90 seconds,
that the head stays under 11 seconds old, and that every head verifies under a feed key of the key
set, over HTTPS and over the `FeedReader` binding.

Development only: `POST http://localhost:8800/__dev/sign` with `{ "grantId": "...", "claims": {...} }`
signs a claim set through the signer the grant picks. The route lives in `src/dev-index.ts`, which
only the `local` block runs (`test/repo` fails a deployed block that runs it), and the claim set
must name the development issuer. The same entry wires the development sign-in hand-off
(`src/dev.ts`): it approves every authorization request for the synthetic account `dev:uts-local`.

The local block binds the local identity store as `IDENTITY_STORE`. The UTS logins have no password
in the repository, so give `uts_app_a` one and pass the URL to wrangler:

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE=postgres://uts_app_a:<password>@127.0.0.1:55432/uts \
  pnpm exec wrangler dev --env local
UTS_E2E_BASE_URL=http://127.0.0.1:8800/ UTS_E2E_ADMIN_URL=... UTS_E2E_APP_URL=... \
  pnpm exec tsx scripts/oauth-e2e.ts
```

`scripts/oauth-e2e.ts` runs code, token, refresh, third-party rotation, reuse (the family is
revoked), revoke and introspect, prints the audit rows (token ids only), checks that no token value
reached an audit row, and times the mint path.

## OAuth endpoints

| Endpoint | Behaviour | SQL |
|---|---|---|
| `GET /authorize` | Code with PKCE `S256`; `resource` is `urn:kilo:service:<audience>`; a first-party client binds the code to `dpop_jkt`; `state` and `iss` (RFC 9207) go back; a bad client or redirect URI is shown, never redirected; sign-in and consent come from the `AuthorizationHandoff` hook | `uts.issue_authorization_code` |
| `POST /token` `authorization_code` | First party: DPoP proof, device session and `kilo_rt_` grant (desktop 30 days idle, 180 days total; mobile 60 and 365). Third party: grant family and its first rotating token. A first-party retry of the same request while the code's 60-second lifetime lasts gets the same grant and a new refresh token (below); any other second use of a code, a third-party one included, revokes the grant | `uts.exchange_authorization_code` |
| `POST /token` `refresh_token` | First party: DPoP proof matched to the grant key; last use moves at most once per hour. Third party: rotation, 60-second grace, reuse after the grace revokes the family and writes a feed entry; a token rotated more than 30 days ago is deleted and then unknown | `uts.refresh_first_party`, `uts.refresh_third_party` |
| `POST /revoke` | RFC 7009; revokes the grant or family, writes the feed entry; a token issued to another client answers 200 like an unknown token and writes a denied row (at most one per grant per minute); an access token is `unsupported_token_type` | `uts.revoke_refresh_token` |
| `POST /introspect` | RFC 7662 for refresh credentials, to their own client (first party with a DPoP proof); `active: false` for anything else | `uts.introspect_refresh_token` (no audit row) |

Each call verifies at most one DPoP proof before the grant read. The grant statement records the
proof's `jti` in `uts.dpop_proofs` under the grant (primary key grant id and `jti`), so a second
use of the proof fails that statement with `dpop_replay`, which answers `invalid_dpop_proof`. A
first-party refresh or introspection records it under the grant the token names; a code exchange
under the grant the code creates, whose id the endpoint derives from the code
(`grantIdOfCode`), so every attempt with one code names one grant. A row stays 121 seconds: a
proof's `iat` is at most 60 seconds ahead and it is accepted until 60 seconds after its `iat`. The
statement records a `jti` only once the grant and the key match, so a caller without the device
key adds no row. A first-party refresh grant names its grant id (`kilo_rt_<grant id><32 random
bytes>`), so the endpoint knows the grant and its signer before the statement. One call mints one
access token per scope, up to 8, each with one audience; one `signMany` call to the signer the
grant id picks signs all of them, and `issued_tokens` lists them. The claims are exactly
`iss exp aud sub client_id iat jti scope org act req sid auth_time amr env`
(`UtsAccessTokenClaimsSchema`). A dependency that does not answer gives 503 with `Retry-After`; a
failure no retry fixes gives 500.

The tokens are signed after the statement commits. When signing fails (or the response is lost),
a first-party client sends the same code exchange again with a new DPoP proof. While the code's
60-second lifetime lasts, the same client, redirect URI, PKCE verifier and DPoP key get the grant
the first attempt created, new access tokens and a new refresh token, and the code does not count
as reused: the device key and a fresh proof show the same client instance. Only hashes are
stored, so the newest refresh token wins: the grant's token hash is replaced, and the earlier
token is unknown from then on. A third-party client has only its PKCE verifier, so any second use
of its code revokes the family (OAuth 2.1 section 4.1.2); a third-party client that lost its
response authorizes again, and its consent stands, so it sees no consent screen. A consumed code
with another client, redirect URI, verifier or key, or after its lifetime, still revokes the
grant. The audit row of a mint lists the `jti` of each token the call is about to sign: after a
failed signing no token carries those ids, and the retry's row (`token.issued`, `rotation`
`code_retry`) lists the ids of the tokens it signs.

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
  caller check; unit tests cover feed entries, list serialization and the feed ledger.
- `pnpm test:repo`: the repository config check (`test/repo`), with no database.
- `pnpm test` runs both; neither needs Postgres. `pnpm test:postgres` runs the identity store
  tests (`test/db`, see "Local database and tests"), the OAuth grant functions and the DPoP `jti`
  check included.

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

Expect `200`, `cache-control: max-age=300, stale-if-error=86400`, `32`, and metadata naming
`https://uts-staging.kiloapps.io` and the feed key set.

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
objects' keys, which an older feed Worker refuses as an invalid answer and so keeps serving its held
keys until it is deployed too.

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
| `uts_owner` | none | none | Owns the objects; the admin login acts as it during migrations |
| `uts_app` | `uts_app_a`, `uts_app_b` | Primary: mint, sign-in, refresh, revoke, audit relay | DML on the credential tables except codes, grants, device sessions, third-party families and tokens, revocations and DPoP proof `jti`s, which it reads and writes only through the OAuth functions; INSERT on chosen audit columns and SELECT on audit rows; SELECT and UPDATE on relay watermarks; `uts.maintain_audit_partitions()` and `uts.maintain_oauth_rows()` |
| `uts_pat` | `uts_pat_a`, `uts_pat_b` | PAT lookups | `uts.lookup_pat(bytea)` and `uts.lookup_bot_key(bytea)` only |
| `uts_reader` | `uts_reader_a`, `uts_reader_b` | Replica: account views | SELECT on the `uts_read` views; read-only transactions by default |

Each group has two logins. UTS rotates the password of the idle login and then switches each
Hyperdrive config to it, so the login in use never changes. Every login ends a transaction that
stays idle for 10 seconds (`idle_in_transaction_session_timeout`) and cancels a statement that runs
for 5 seconds (`statement_timeout`), so one stuck session or one long statement cannot hold back the
audit relay. The database itself sets the same idle limit for every other session (admin,
migration, dashboard). The relay's horizon is the oldest open transaction of the whole server, so
the alert on an unrelayed row older than 60 seconds covers sessions in other databases.

### Platform roles

The UTS role matrix does not cover the roles the platform brings. `PUBLIC` keeps `CONNECT` on the
database but has no `TEMP`. Members of `pg_read_all_data` and `pg_write_all_data` can read or write
every table, so a deploy runs `pnpm db:check-access` (`scripts/check-platform-access.ts`) with the
migration connection. It lists the members of both roles and fails when `anon`, `authenticated` or
`service_role` holds any privilege on `uts`, `uts_read` or `uts_migrations`, or on anything in them,
whether granted directly, through `PUBLIC` or through an inherited role.

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
- Every new org bot key needs a gate pass (a `BEFORE INSERT` trigger refuses one without). Deleting
  the creator's account flags the creator's active keys, as member removal does (design section
  5.8), so they stop after 7 days unless an org admin keeps them. `created_by` keeps the creator's
  id as history; only `gate_pass_id` becomes NULL when the account's passes go with it.
- `refresh_grants.last_used_at` and `idle_expires_at` move at most once per grant per hour, not on
  every mint; the table leaves 10 percent of each page free (`fillfactor = 90`) for those updates.
- The app login writes authorization codes, refresh grants, device sessions, third-party families
  and tokens, revocations and DPoP proof `jti`s only through the security-definer OAuth functions
  (migration 0004), which write the credential rows and their audit row together; it keeps SELECT
  on those tables.
  The account-deletion function will be one more such function: in the same statement, before the
  delete, it collects the active bot keys the account created (the keys the delete trigger is about
  to flag) and writes a bot-key-flagged audit row and the org-admin notices for each (design
  sections 5.8 and 8.1).
- `IdentityStoreError` keeps only the SQLSTATE, the constraint, the table, and for a failed
  connection the system error code (`ECONNREFUSED`, `ETIMEDOUT`, ...). The server's error detail can
  quote the refused row, so it never leaves `src/db/client.ts`.

### Audit outbox

`uts.audit_events` is partitioned by UTC day. Each row records its transaction id (`xid8`) and its
shard (`id % 8`). The relay advances `uts.audit_relay_watermarks` once the archive confirms a batch.
Each shard publishes as its own audit stream, and `last_seq` numbers that stream's batches.

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
the next 7 days. Otherwise it takes the first partition whose rows are all older than 7 days and all
relayed: it truncates it while it holds data, which locks only that partition (no insert reaches an
old day), and drops it once it is empty. Every check (one index probe per shard on the partition)
runs before the one CREATE, TRUNCATE or DROP. The DROP is the only step that takes the parent's
`ACCESS EXCLUSIVE` lock, and it only removes empty files; a DDL that waits 200 ms for its lock gives
up, and the next call retries. The cron calls it until it returns no `created`, `truncated` or
`dropped` row. A partition whose name is not `audit_events_YYYYMMDD` is left alone.

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

Third-party refresh tokens are the other table that grows with traffic. A token row with its six
indexes takes about 300 bytes. Each refresh rotates the token, and `uts.maintain_oauth_rows()`
deletes a rotated token 30 days after its rotation (below), so a family keeps at most 30 days / 8
minutes = 5,400 rotated tokens plus its current one. As an upper bound, with every family
refreshing every 8 minutes for 30 days:

| Active third-party families | Token rows | Table and indexes |
|---|---|---|
| 10k | 54M | ~16 GB |
| 50k | 270M | ~81 GB |
| 200k | 1.08B | ~324 GB |

### OAuth row maintenance

The app login cannot delete credential rows, so `uts.maintain_oauth_rows()` (SECURITY DEFINER)
removes the rows no statement reads again. Each call deletes at most 5,000 rows of each kind and
returns one `(kind, deleted)` row per kind. Like `uts.maintain_audit_partitions()`, it has no
caller in this service yet: the UTS cron that slice 3.9 adds calls both, this one until every
count is under 5,000. `uts_app` holds EXECUTE on it by choice until then; it takes no input and
every delete is time-gated, so a caller can only remove dead rows sooner. Slice 3.9 moves it to a
dedicated maintenance role. It deletes:

| Rows | When | Why that is safe |
|---|---|---|
| `authorization_codes` | 1 hour past the code's 60-second lifetime, used or not | Until then a second use of a used code still revokes its grant |
| `third_party_refresh_tokens` | Every token of a family that is revoked or past its 90-day end | Each such token fails anyway: every reader checks the family's status, so a family revoke writes only the family row |
| `rotated_refresh_tokens` | A rotated token of a live family 30 days after its rotation, the longest idle window a token has, oldest first | Reuse detection covers tokens rotated within 30 days; an older one is then unknown (`invalid_grant`) instead of revoking the family. A thief who rotates a stolen token is still caught when the real client next presents its own token, rotated minutes before. Oldest first, a token's child is mostly in the same batch |
| `revocations` | Past `feed_expires_at` | The feed no longer carries the entry |
| `dpop_proofs` | Past `expires_at` (121 seconds) | No clock accepts the proof again |

`parent_id` is `ON DELETE SET NULL`, so the order of a batch never decides what it deletes: each
deleted token whose child stays gives that child one `parent_id` update. Rotated tokens go oldest
first, so that is mostly one update per family per batch.

It never deletes a grant, a family row, a family's current token, or a code within its lifetime
(`test/db/oauth-grants.test.ts`). At one mint per active client every 8 minutes, the DPoP rows
arrive at 21, 104 and 417 per second for 10k, 50k and 200k clients: 1,250, 6,250 and 25,000 per
minute, and rotated third-party tokens age out at the same rate per third-party family, so a cron
that runs every minute makes 1 to 5 calls.

### Third-party grace window

A rotated third-party token stays usable for 60 seconds (OAuth 2.1 section 4.3.3), so a client
that lost a response can retry. A presentation inside the grace rotates the family's current
token, so two holders can briefly hold tokens of one family: a client and a thief who presents a
just-rotated token inside the grace each get a token, and the legitimate client's current token
is rotated away. Reuse is then detected when either side later presents a rotated token after
its grace: the whole family is revoked and a feed entry is written (`test/db/oauth-grants.test.ts`,
"third-party grace window"). First-party grants do not rotate; their DPoP key is the sender
constraint.

### Hot-path index probes

Each hot-path read reaches its credential through one unique-index probe on the hash, plus
primary-key probes for the rows that hang off it (`test/db/index-probes.test.ts` checks the plans):

| Read | Indexes |
|---|---|
| Mint and first-party refresh (`uts.read_refresh_grant`) | `refresh_grants_token_hash_key`, then `device_sessions_pkey`, `accounts_pkey`, `org_memberships_pkey`, `org_sso_policies_pkey` |
| Third-party refresh (`uts.read_third_party_refresh_token`) | `third_party_refresh_tokens_token_hash_key`, then `third_party_grant_families_pkey`, `third_party_consents_pkey`, `accounts_pkey`, `org_memberships_pkey`, `org_sso_policies_pkey` |
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
