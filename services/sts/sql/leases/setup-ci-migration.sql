-- The `ci-migration` part of the lease setup (README "Database leases"), after setup.sql and
-- setup-replica-sweeper.sql; Igor accepted design decision Q64 on 2026-11-26. It must run as a
-- superuser, on the primary's direct endpoint:
--
--   psql "<primary direct URL>" -v ON_ERROR_STOP=1 \
--     -v migration_admin_password="<generated>" -f services/sts/sql/leases/setup-ci-migration.sql
--
-- Why a superuser: on PostgreSQL 16 and later no role holds ADMIN on itself, so only a superuser
-- can grant membership in `postgres`; and every role `postgres` creates has `postgres` as an
-- administering member, so a template or a login that `postgres` created and that is a member of
-- `postgres` would be a membership cycle. On Supabase the superuser is `supabase_admin`, which a
-- customer does not hold.

\if :{?migration_admin_password}
\else
  \echo 'set -v migration_admin_password=...'
  \quit
\endif

BEGIN;

-- Lease roles of this template may SET ROLE postgres and inherit none of its rights, so a
-- migration's objects can only be created as `postgres`, and the lease role itself owns nothing it
-- made.
CREATE ROLE kilo_lease_migration NOLOGIN;
GRANT postgres TO kilo_lease_migration WITH INHERIT FALSE, SET TRUE;

-- The login Infisical creates and drops migration lease roles with: CREATEROLE, and ADMIN on its
-- template without INHERIT or SET. Created here, not by `postgres`, so a ci-migration lease (which
-- can act as `postgres`) cannot reset its password.
-- The password goes through a transaction-local setting and EXECUTE, as in setup.sql, so
-- `log_statement = 'ddl'` does not log it.
SELECT FROM pg_catalog.set_config('kilo_lease.admin_password', :'migration_admin_password', true);
DO $$
BEGIN
  EXECUTE format('CREATE ROLE kilo_lease_migration_admin LOGIN CREATEROLE CONNECTION LIMIT 4 PASSWORD %L',
    pg_catalog.current_setting('kilo_lease.admin_password'));
  PERFORM pg_catalog.set_config('kilo_lease.admin_password', '', true);
END
$$;
GRANT kilo_lease_migration TO kilo_lease_migration_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
-- Its creation statement carries lease passwords, as the replica login's does: none of its
-- statements reaches the server log (setup.sql explains the settings).
ALTER ROLE kilo_lease_migration_admin SET log_statement = 'none';
ALTER ROLE kilo_lease_migration_admin SET log_min_duration_statement = -1;
ALTER ROLE kilo_lease_migration_admin SET log_min_error_statement = 'panic';
DO $$
BEGIN
  IF pg_catalog.current_setting('pgaudit.log', true) IS NOT NULL THEN
    ALTER ROLE kilo_lease_migration_admin SET pgaudit.log = 'none';
  END IF;
  IF pg_catalog.current_setting('auto_explain.log_min_duration', true) IS NOT NULL THEN
    ALTER ROLE kilo_lease_migration_admin SET auto_explain.log_min_duration = -1;
  END IF;
END
$$;
-- A ci-migration lease acts as `postgres`, a member of pg_monitor and so of pg_read_all_stats,
-- which reads every session's query text in pg_stat_activity. With activity tracking off for both
-- admin logins, pg_stat_activity holds no query text of theirs, so such a lease cannot read a
-- password from a creation statement while it runs. Setting this parameter on a role takes a
-- superuser, which is why it is here and not in setup.sql.
ALTER ROLE kilo_lease_migration_admin SET track_activities = off;
ALTER ROLE kilo_lease_replica_admin SET track_activities = off;
GRANT USAGE ON SCHEMA kilo_lease TO kilo_lease_migration_admin;
GRANT EXECUTE ON FUNCTION kilo_lease.caller_template(), kilo_lease.check_username(text),
  kilo_lease.track_lease(text), kilo_lease.create_lease(text, text, timestamptz),
  kilo_lease.end_sessions(text), kilo_lease.block_lease(text), kilo_lease.revoke_lease(text)
  TO kilo_lease_migration_admin;

-- `postgres` created the replica-read login in setup.sql and so administers it: it could reset its
-- password, and so could a ci-migration lease. Only a superuser can remove that grant.
REVOKE kilo_lease_replica_admin FROM postgres;

-- `postgres` owns the kilo_lease schema, its table and its functions after setup.sql, so a
-- ci-migration lease acting as it could replace kilo_lease.create_lease with one that records the
-- passwords of later leases. They move to kilo_lease_owner: no login, created here by the
-- superuser, so `postgres` neither is nor administers it, and a member of pg_signal_backend, which
-- end_sessions runs with. The grants above stay; `postgres` can no longer replace, add or take
-- over a function there (check.sh).
CREATE ROLE kilo_lease_owner NOLOGIN;
GRANT pg_signal_backend TO kilo_lease_owner;
ALTER SCHEMA kilo_lease OWNER TO kilo_lease_owner;
ALTER TABLE kilo_lease.lease_role OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.caller_template() OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.check_username(text) OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.track_lease(text) OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.end_sessions(text) OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.create_lease(text, text, timestamptz) OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.block_lease(text) OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.revoke_lease(text) OWNER TO kilo_lease_owner;
ALTER FUNCTION kilo_lease.sweep_sessions() OWNER TO kilo_lease_owner;

COMMIT;
