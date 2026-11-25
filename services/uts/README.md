# UTS: the user token service

UTS is the OAuth 2.1 authorization server for every token with a user subject. It runs as two
Cloudflare Workers:

| Worker | Package | Hostname (production / staging) | Placement | Serves |
|---|---|---|---|---|
| Mint Worker `uts` | `services/uts` | `uts.kiloapps.io` / `uts-staging.kiloapps.io` | `aws:eu-central-1` | Issuer metadata; later sign-in, token and account endpoints. Binds the signer objects |
| Feed Worker `uts-feed` | `services/uts-feed` | `uts-feed.kiloapps.io` / `uts-feed-staging.kiloapps.io` | none | The UTS key set; later the revocation feed and the bootstrap endpoint |

The issuer, key set URL and local ports of each environment live in
`@kilocode/uts-contracts` (`UTS_ENDPOINTS`); verifiers read them from there.

## Mint Worker

- `GET /.well-known/oauth-authorization-server` serves RFC 8414 metadata: `issuer`, `jwks_uri`
  (on the feed Worker), and empty `response_types_supported` and `grant_types_supported`. An
  endpoint joins the document in the change that makes it answer, so no listed endpoint returns 404.
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
  (a trace would record bound SQL values); no method returns a private key;
- refuses to create keys under any other name or in any other jurisdiction than its environment's;
- publishes the public halves under `uts-token-<signer>-<RFC 7638 thumbprint>`;
- signs with `sign(claims)`: a compact JWS with header `alg: EdDSA`, `typ: at+jwt`, `kid`. It refuses
  a claim set with another issuer or environment, an `iat` more than 60 seconds from now, or an
  `exp` more than 1 hour ahead, the longest UTS token lifetime. `src/keys/claims.ts` is the
  signer's admission check; the published claim contract is phase 2's `AccessTokenClaimsSchema`
  (`@kilocode/sts-contracts`), and every claim set the signer accepts also passes it;
- rotates by alarm: a key signs for 30 days; the next key is published 7 days before it signs (a
  new object publishes its first two keys at once, the second 30 days ahead); a late alarm never
  shortens that lead; a retired key stays published for 1 hour and 10 minutes, until the last token
  it signed has been expired for 10 minutes;
- removes a key at once with `removeKid(kid)`, an internal emergency operation. A removed current
  key is replaced by the published next key. The result is the revocation-feed entry: verifiers
  reject the `kid` until `revokeUntil`. The revocation feed writes it once that feed exists.

### The internal entrypoint

`SignerKeys.publicKeys()` returns every signer's published keys. It answers only the caller
`props.caller = <feed Worker deployed name>` for its own environment and refuses every other
binding. `test/repo/worker-configs.test.ts` fails any Worker config outside the two UTS Workers that
names a UTS Durable Object class or binds the mint Worker, any feed binding whose caller is not the
feed block's own name, and any drift in the UTS configs (names, `eu` jurisdiction, placement,
traces).

## Local development

```sh
cd services/uts && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
cd services/uts-feed && pnpm exec wrangler dev --env local --persist-to ../../.wrangler-uts
curl -s http://localhost:8801/.well-known/jwks.json
```

Development only: `POST http://localhost:8800/__dev/sign` with `{ "grantId": "...", "claims": {...} }`
signs a claim set through the signer the grant picks. The route lives in `src/dev-index.ts`, which
only the `local` block runs (`test/repo` fails a deployed block that runs it), and the claim set
must name the development issuer.

## Tests

- `pnpm test:workers`: unit and runtime tests in the Workers pool (`vitest.config.ts`,
  `wrangler.test.jsonc`): key lifecycle with time travel, signing and verification with `jose`, key
  persistence across restarts, rotation and removal by alarm, the caller check, metadata.
- `pnpm test:node`: the repository config check (`test/repo`) and the identity store tests
  (`test/db`, see "Local database and tests").

## Staging checks that need real Cloudflare

workerd implements neither jurisdictions nor placement, so these run after the first staging
deploy of both Workers. Start a tail of the mint Worker first; it records the first key-set read,
which creates all 16 signer objects:

```sh
cd services/uts
pnpm exec wrangler tail uts-staging --format json > /tmp/uts-staging-tail.json &
curl -sS -D - https://uts-feed-staging.kiloapps.io/.well-known/jwks.json -o /tmp/jwks.json
jq '.keys | length' /tmp/jwks.json
curl -sS https://uts-staging.kiloapps.io/.well-known/oauth-authorization-server
```

Expect `200`, `cache-control: max-age=300, stale-if-error=86400`, `32`, and metadata naming
`https://uts-staging.kiloapps.io` and the feed key set.

1. **`eu` jurisdiction and location hint together (design 5.7).** Each object logs
   `uts.signer.bootstrapped` once, when it creates its keys, with its jurisdiction and the data
   center it runs in; an object outside `eu` throws instead of creating keys:

   ```sh
   jq -r '.logs[]?.message[]? | select(type == "string" and contains("uts.signer.bootstrapped"))' /tmp/uts-staging-tail.json | jq -c '{signer, jurisdiction, colo}'
   ```

   Expect 16 lines, each `"jurisdiction":"eu"` and a `colo` in western Europe (the `weur` hint),
   such as `FRA`, `AMS` or `CDG`.

2. **Key persistence across real restarts (design 5.7).** A deploy restarts every object. Record
   the kids, redeploy the mint Worker, wait over a minute for the feed Worker's read to expire, and
   compare; the tail must show no new `uts.signer.bootstrapped` line:

   ```sh
   jq -r '.keys[].kid' /tmp/jwks.json | sort > /tmp/kids-before
   pnpm exec wrangler deploy --env staging
   sleep 70
   curl -sS https://uts-feed-staging.kiloapps.io/.well-known/jwks.json | jq -r '.keys[].kid' | sort | diff /tmp/kids-before - && echo same
   ```

3. **The mint path runs in the placed region (design 5.2).** Cloudflare adds a `cf-placement`
   request header (`remote-<colo>` or `local-<colo>`) to every request of a placed Worker:

   ```sh
   curl -sS -o /dev/null https://uts-staging.kiloapps.io/.well-known/oauth-authorization-server
   jq -r 'select(.event.request.url? | tostring | contains("oauth-authorization-server")) | .event.request.headers["cf-placement"]' /tmp/uts-staging-tail.json
   ```

   Expect `remote-FRA` (or `local-FRA` for a request that entered in Frankfurt).

## Deploys

Both Workers deploy through `.github/workflows/deploy-workers.yml`, which discovers every
`services/*/wrangler.jsonc`. The feed Worker's service binding names the mint Worker, so the first
deploy of an environment deploys `services/uts` before `services/uts-feed`.

## Identity store

UTS keeps its credential state in a dedicated Postgres database, the identity store. Only UTS binds
its Hyperdrive configs, and those configs run with caching disabled.

### Layout

| Path | Contents |
| --- | --- |
| `migrations/` | Ordered SQL migrations, `NNNN_name.sql` |
| `scripts/migrator.ts` | Applies the migrations and records each file's SHA-256 |
| `scripts/migrate.ts` | Command-line entry point for the migrator |
| `scripts/local-db.sh` | Local Postgres 17 container for development and tests |
| `src/db/` | Worker access through Hyperdrive with `pg`: client, row schemas, enums, PAT lookups |
| `test/db/` | Node tests that run against the local Postgres |

### Schemas and roles

| Schema | Owner | Contents |
| --- | --- | --- |
| `uts` | `uts_owner` | Every table, type and function |
| `uts_read` | `uts_owner` | Read-only account views without hashes, keys or client addresses |
| `uts_migrations` | admin login | The migrator's record of applied files |

| Role | Logins | Hyperdrive config | Privileges |
| --- | --- | --- | --- |
| `uts_owner` | none | none | Owns the objects; the admin login acts as it during migrations |
| `uts_app` | `uts_app_a`, `uts_app_b` | Primary: mint, sign-in, refresh, revoke, audit relay | DML on the credential tables; INSERT on chosen audit columns and SELECT on audit rows; SELECT and UPDATE on relay watermarks; `uts.maintain_audit_partitions()` |
| `uts_pat` | `uts_pat_a`, `uts_pat_b` | PAT lookups | `uts.lookup_pat(bytea)` and `uts.lookup_bot_key(bytea)` only |
| `uts_reader` | `uts_reader_a`, `uts_reader_b` | Replica: account views | SELECT on the `uts_read` views; read-only transactions by default |

Each group has two logins. UTS rotates the password of the idle login and then switches each
Hyperdrive config to it, so the login in use never changes. Every login ends a transaction that
stays idle for 10 seconds (`idle_in_transaction_session_timeout`), so one stuck session cannot hold
back the audit relay.

### Rules for statements

- A Worker sends one SQL statement per call and never opens a multi-statement transaction through
  Hyperdrive. A mint, refresh or revoke is one statement that calls a stored function, which writes
  the credential row and its audit row together.
- Opaque values (refresh grants, PATs, bot keys, codes, tickets, session cookies) are stored only as
  32-byte hashes. A PAT or org bot key also keeps its last four characters for display; its prefix
  (`kilo_pat_`, `kilo_bot_`) is fixed by its table, so no column stores it.
- Each lifecycle has one status enum, and a CHECK constraint ties every status to the columns it
  needs. Lifetimes from design section 5.3 are CHECK constraints too.

### Audit outbox

`uts.audit_events` is partitioned by UTC day. Each row records its transaction id (`xid8`) and its
shard (`id % 8`). The relay reads one shard past its watermark, below the oldest open transaction,
in (`txid`, `id`) order, and advances `uts.audit_relay_watermarks` once the archive confirms a
batch. Each shard publishes as its own audit stream, and `last_seq` numbers that stream's batches.
`uts.maintain_audit_partitions()` creates the next 7 days of partitions and drops a partition only
when its rows are all older than 7 days and every shard's watermark is past them.

The `event` column holds an `AuditEvent` from `@kilocode/sts-contracts`. `uts.is_audit_event` checks
it in the database as strictly as `AuditEventSchema` does, narrowed to UTS sources, UTS event types
and the three OCSF classes in use, because a row the relay could not parse would stall its shard.
A row is at most 8 KB, so one row always fits one queue message (60 KB compressed); the relay
splits a 500-row batch that does not.

### Hot-path index probes

Each hot-path read reaches its credential through one unique-index probe on the hash, plus
primary-key probes for the rows that hang off it (`test/db/index-probes.test.ts` checks the plans):

| Read | Indexes |
| --- | --- |
| Mint and first-party refresh | `refresh_grants_token_hash_key`, then `accounts_pkey`, `org_memberships_pkey`, `org_sso_policies_pkey` |
| Third-party refresh | `third_party_refresh_tokens_token_hash_key`, then `third_party_grant_families_pkey` |
| PAT lookup (`uts.lookup_pat`) | `personal_access_tokens_token_hash_key`, then `accounts_pkey` |
| Org bot key lookup (`uts.lookup_bot_key`) | `org_bot_keys_token_hash_key` |
| Web session check | `browser_sessions_token_hash_key` |

### Local database and tests

The local container runs Postgres 17.12 (`postgres:17.12`), the Postgres 17 release of the target
Supabase project. Its admin login has `CREATEROLE` and `CREATEDB` but not `SUPERUSER`, like
Supabase's `postgres` login, so the migrations are proven not to need a superuser. All local
passwords are synthetic.

```sh
pnpm db:up                       # start the container; prints UTS_MIGRATION_DATABASE_URL
UTS_MIGRATION_DATABASE_URL=... pnpm db:migrate
pnpm test:node                   # migrates a template database, then clones it per test file
pnpm db:down
```

`UTS_PG_PORT` (default 55432) and `UTS_PG_CONTAINER` change the port and the container name.
`UTS_TEST_ADMIN_URL` points the tests at another server.

### Migrations

Migrations are plain SQL, not generated by drizzle-kit, because the identity store needs roles,
grants, a partitioned table, an `xid8` column and stored functions, which drizzle-kit cannot
express. The migrator runs each file in its own transaction over a direct connection as the
database's admin login, records it with its SHA-256, and refuses to continue when an applied file
changed, disappeared, or a new file sorts before an applied one. Add new files at the end; never
edit an applied file.
