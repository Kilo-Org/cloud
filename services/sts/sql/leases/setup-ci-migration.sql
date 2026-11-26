-- The `ci-migration` part of the lease setup (README "Database leases"), after setup.sql and only
-- once Igor has accepted design decision Q64. It must run as a superuser, on the primary's direct
-- endpoint:
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
CREATE ROLE kilo_lease_migration_admin LOGIN CREATEROLE CONNECTION LIMIT 4 PASSWORD :'migration_admin_password';
GRANT kilo_lease_migration TO kilo_lease_migration_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT USAGE ON SCHEMA kilo_lease TO kilo_lease_migration_admin;
GRANT EXECUTE ON FUNCTION kilo_lease.caller_template(), kilo_lease.check_username(text),
  kilo_lease.create_lease(text, text, timestamptz), kilo_lease.end_sessions(text),
  kilo_lease.revoke_lease(text)
  TO kilo_lease_migration_admin;

-- `postgres` created the replica-read login in setup.sql and so administers it: it could reset its
-- password, and so could a ci-migration lease. Only a superuser can remove that grant.
REVOKE kilo_lease_replica_admin FROM postgres;

COMMIT;
