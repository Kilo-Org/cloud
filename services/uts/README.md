# UTS

The user token service (design section 5).

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
| `uts_app` | `uts_app_a`, `uts_app_b` | Primary: mint, sign-in, refresh, revoke, audit relay | DML on the ungated credential tables; on gated rows (gate passes, PATs, org bot keys, CI trust policies, third-party consents, device approvals) SELECT, DELETE and UPDATE of lifecycle columns only; INSERT on chosen audit columns and SELECT on audit rows; SELECT on relay watermarks, which it moves only through `uts.advance_audit_watermark()`; `uts.maintain_audit_partitions()` and `uts.end_long_transactions()` |
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
30 seconds ago, a limit the caller cannot change. The minute cron and each audit relay run call it,
so a UTS session holds the relay back for at most about 35 seconds. The relay's horizon is the
oldest open transaction of the whole server, so the alert on an unrelayed row older than 60 seconds
covers sessions of other logins and in other databases.

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
  released pass can serve nothing. These write steps have no grant: the SECURITY DEFINER statements
  of the account API call them and write the audit row and the notice in the same statement.
- A PAT bound to an organization, and every org bot key, needs an active membership (owner or
  admin for a bot key). The write step holds the membership row `FOR SHARE` until commit, so a
  member removal that runs at the same time waits for the new credential and then revokes or
  flags it with the member's others. An account holds at most 100 live PATs and an organization
  at most 100 live bot keys, counted behind a lock.
- The app login can still revoke, flag, keep, deny and record use of gated rows, through column
  grants that leave out the holder, the hash, the scope, the lifetime and the pass, so an update
  cannot turn a row into a different credential. A revoked PAT, bot key, CI trust policy or
  consent, and a denied or consumed device code, keep their status (`uts.refuse_reopening`).
- Every new org bot key needs a gate pass (a `BEFORE INSERT` trigger refuses one without). Deleting
  the creator's account flags the creator's active keys, as member removal does (design section
  5.8), so they stop after 7 days unless an org admin keeps them. `created_by` keeps the creator's
  id as history; only `gate_pass_id` becomes NULL when the account's passes go with it.
- `refresh_grants.last_used_at` and `idle_expires_at` move at most once per grant per hour, not on
  every mint; the table leaves 10 percent of each page free (`fillfactor = 90`) for those updates.
- A third-party refresh token names the token it replaced (`parent_id`). Deleting an old rotated
  token sets its child's `parent_id` to NULL, so cleanup never takes the family's current token.
- Time limits compare with `statement_timestamp()` where a statement can run late in a transaction
  (the PAT and bot key lookups), and spell 7 days as 168 hours where the session's time zone could
  stretch or shorten calendar days (the flagged bot key cutoff, partition maintenance).
- The app login still writes the ungated credential tables directly. When the mint, refresh and
  revoke functions land, they become security-definer functions that write the credential row and
  its audit row together, and the app login loses direct writes on those tables, so no credential
  can change without its audit row. The account-deletion function is one of them: in the same
  statement, before the delete, it collects the active bot keys the account created (the keys the
  delete trigger is about to flag) and writes a bot-key-flagged audit row and the org-admin notices
  for each (design sections 5.8 and 8.1).
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

### Hot-path index probes

Each hot-path read reaches its credential through one unique-index probe on the hash, plus
primary-key probes for the rows that hang off it (`test/db/index-probes.test.ts` checks the plans):

| Read | Indexes |
|---|---|
| Mint and first-party refresh | `refresh_grants_token_hash_key`, then `accounts_pkey`, `org_memberships_pkey`, `org_sso_policies_pkey` |
| Third-party refresh | `third_party_refresh_tokens_token_hash_key`, then `third_party_grant_families_pkey` |
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
