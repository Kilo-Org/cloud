# UTS

The user token service (design section 5).

## Identity store

UTS keeps its credential state in a dedicated Postgres database, the identity store. Only UTS binds
its Hyperdrive configs, and those configs run with caching disabled.

### Layout

| Path | Contents |
| --- | --- |
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
  pass id.
- `refresh_grants.last_used_at` and `idle_expires_at` move at most once per grant per hour, not on
  every mint; the table leaves 10 percent of each page free (`fillfactor = 90`) for those updates.
- The app login still writes the credential tables directly. When the mint, refresh and revoke
  functions land, they become security-definer functions that write the credential row and its
  audit row together, and the app login loses direct writes on the credential tables, so no
  credential can change without its audit row.
- `IdentityStoreError` keeps only the SQLSTATE, the constraint and the table. The server's error
  detail can quote the refused row, so it never leaves `src/db/client.ts`.

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
the next 7 days, or else drops the first partition whose rows are all older than 7 days and all
relayed. Every check (one index probe per shard on the partition) runs before the one CREATE or
DROP, so the parent's `ACCESS EXCLUSIVE` lock lasts only for that DDL; a DDL that waits 200 ms for
its lock gives up, and the next call retries. The cron calls it until it returns no `created` or
`dropped` row. A partition whose name is not `audit_events_YYYYMMDD` is left alone.

The `event` column holds an `AuditEvent` from `@kilocode/sts-contracts`. `uts.is_audit_event` checks
it in the database as strictly as `AuditEventSchema` does, narrowed to UTS sources, UTS event types
and the three OCSF classes in use, because a row the relay could not parse would stall its shard. A
second CHECK refuses a token value (`kilo_pat_`, `kilo_rt_`, `kilo_bot_` or a JWT) anywhere in a
row and a bare email address as the account or the actor.

A row is at most 8 KB, so one row always fits one queue message (60 KB compressed). A full 500-row
read of real mint events does not: 500 mixed mints (1 to 4 tokens each) compress to about 70 KB and
500 four-token mints to about 86 KB (`test/db/audit-outbox.test.ts`). The relay therefore halves any
batch the encoder refuses, as the STS relay does.

#### Storage

A mint audit row takes about 1 KB of table space and about 80 bytes in its two indexes. At one mint
per active client every 8 minutes:

| Active clients | Rows per day | 7-day tier, table | 7-day tier, indexes |
| --- | --- | --- | --- |
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
| --- | --- |
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
pnpm db:up                       # start the container; prints UTS_MIGRATION_DATABASE_URL
UTS_MIGRATION_DATABASE_URL=... pnpm db:migrate
pnpm test:node                   # migrates a template database, then clones it per test file
pnpm db:down
```

`UTS_PG_PORT` (default 55432) and `UTS_PG_CONTAINER` change the port and the container name.
`UTS_TEST_ADMIN_URL` changes the admin URL of the tests, for a local server only: the test setup
changes cluster-wide roles and drops databases, so it refuses any host other than 127.0.0.1,
localhost and ::1.

### Migrations

Migrations are plain SQL, not generated by drizzle-kit, because the identity store needs roles,
grants, a partitioned table, an `xid8` column and stored functions, which drizzle-kit cannot
express. The migrator runs each file in its own transaction over a direct connection as the
database's admin login, records it with its SHA-256, and refuses to continue when an applied file
changed, disappeared, or a new file sorts before an applied one. Add new files at the end; never
edit an applied file.

An operator runs the migrator (design section 5.2): a break-glass read of the admin login's password
from `/admin/identity-store`, approved by a secret admin, and a run that raises the same alert as
SQL-editor use. The migrator and the access check refuse a host other than loopback unless the URL
carries `sslmode=verify-full` and `sslrootcert=<Supabase CA file>`, and they accept no other URL
parameter (`scripts/connection.ts`).
