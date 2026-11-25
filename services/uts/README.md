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
