-- One-time database setup for the Infisical dynamic secrets `replica-read` and `ci-migration`
-- (services/sts/README.md, "Database leases"). Run it with psql against the PRIMARY's direct
-- endpoint (not Supavisor), as the role that owns the application schema (`postgres` on Supabase),
-- on PostgreSQL 16 or later:
--
--   psql "<primary direct URL>" -v ON_ERROR_STOP=1 \
--     -v replica_admin_password="<generated>" -v migration_admin_password="<generated>" \
--     -f services/sts/sql/leases/setup.sql
--
-- The two passwords go into the two Infisical dynamic secrets once, by hand, and nowhere else.
-- Roles are created on the primary; a replica receives them through replication.

\if :{?replica_admin_password}
\else
  \echo 'set -v replica_admin_password=...'
  \quit
\endif
\if :{?migration_admin_password}
\else
  \echo 'set -v migration_admin_password=...'
  \quit
\endif

BEGIN;

-- replica-read: every lease role is a member of this role and holds nothing else. SELECT on the
-- application schema, today's tables and every table the owner creates later; no other right.
CREATE ROLE kilo_lease_replica_read NOLOGIN;
GRANT USAGE ON SCHEMA public TO kilo_lease_replica_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kilo_lease_replica_read;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO kilo_lease_replica_read;

-- ci-migration: a lease role runs as `postgres` (its creation statement sets `role`), so the
-- objects a migration creates belong to `postgres`, as today, and the lease role owns nothing that
-- would stop DROP ROLE. This is owner-level DDL, CREATE EXTENSION included: a lease is `postgres`
-- for its lifetime (README, "Risks").
CREATE ROLE kilo_lease_migration NOLOGIN;
GRANT postgres TO kilo_lease_migration WITH INHERIT TRUE, SET TRUE;

-- The logins Infisical creates and drops lease roles with, one per dynamic secret, so a leaked
-- replica login can never create a migration role. CREATEROLE lets each create, alter and drop the
-- roles it created; ADMIN on its own template role (without INHERIT or SET) lets it grant that
-- membership and gives it none of the template's rights; pg_signal_backend lets the revocation
-- statement end a lease role's sessions.
CREATE ROLE kilo_lease_replica_admin LOGIN CREATEROLE CONNECTION LIMIT 4 PASSWORD :'replica_admin_password';
GRANT kilo_lease_replica_read TO kilo_lease_replica_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT pg_signal_backend TO kilo_lease_replica_admin;

CREATE ROLE kilo_lease_migration_admin LOGIN CREATEROLE CONNECTION LIMIT 4 PASSWORD :'migration_admin_password';
GRANT kilo_lease_migration TO kilo_lease_migration_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT pg_signal_backend TO kilo_lease_migration_admin;

COMMIT;

-- Expect false and 0: the replica template can create nothing and write to no table (a grant to
-- PUBLIC would show here).
SELECT
  has_schema_privilege('kilo_lease_replica_read', 'public', 'CREATE') AS replica_can_create,
  count(*) FILTER (
    WHERE has_table_privilege('kilo_lease_replica_read', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
  ) AS replica_writable_tables
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f');
