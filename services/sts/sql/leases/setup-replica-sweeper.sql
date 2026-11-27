-- The replica-side session sweeper (README "Database leases", "Replica sessions"; design decision
-- Q63). Run it with psql against the PRIMARY's direct endpoint, as `postgres`, right after
-- setup.sql and before setup-ci-migration.sql (which moves the function below to kilo_lease_owner):
--
--   psql "<primary direct URL>" -v ON_ERROR_STOP=1 \
--     -v sweeper_password="<generated>" -f services/sts/sql/leases/setup-replica-sweeper.sql
--
-- The password goes into the Hyperdrive configuration of each replica and into Infisical `/admin`,
-- by hand, and nowhere else. Everything here reaches each replica through replication.
--
-- Why: a revocation and an expiry run on the primary and end the lease role's sessions there only.
-- A session already open on a replica stays connected after its role is dropped (its next
-- statement fails with "invalid role OID", the idle session lingers), and a session can change its
-- own timeouts. The lease object (LeaseDO) logs in to each replica once a minute as
-- `kilo_lease_sweeper` and calls kilo_lease.sweep_sessions(), which ends there the sessions of the
-- lease roles that are gone, blocked or past VALID UNTIL. It takes no role name: Infisical's own
-- expiry never tells STS, and STS never stores a lease's username.

\if :{?sweeper_password}
\else
  \echo 'set -v sweeper_password=...'
  \quit
\endif

BEGIN;

-- A replica knows a dropped role was a lease only by its row here, so the row must outlive the
-- replica sessions of its role. setup.sql's end_sessions forgot a row as soon as the role was gone
-- with no session left on the primary, which can be before the replica's next sweep. From now on
-- end_sessions marks such a row with the time it first saw the role gone and forgets it 7 days
-- later, so a sweeper that cannot reach a replica for up to 7 days still finds those sessions.
ALTER TABLE kilo_lease.lease_role ADD COLUMN gone_since timestamptz;

-- setup.sql's function with that retention; its owner, grants and callers stay.
CREATE OR REPLACE FUNCTION kilo_lease.end_sessions(username text) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.pg_stat_clear_snapshot();
  WITH caller AS (SELECT * FROM kilo_lease.caller_template()),
  leases AS (
    SELECT l.role
    FROM kilo_lease.lease_role l
    JOIN caller ON l.template = caller.template
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = l.role
    WHERE r.oid IS NULL
      OR (NOT r.rolsuper
        AND (r.rolname = username OR NOT r.rolcanlogin OR r.rolvaliduntil < pg_catalog.now()))
  ),
  -- Materialized, so the termination below runs on these sessions only. Selected by user id alone:
  -- without pg_read_all_stats (kilo_lease_owner has none) pg_stat_activity shows another role's
  -- pid and usesysid but no backend type, and every backend with a lease role's id is that lease's.
  targets AS MATERIALIZED (
    SELECT a.pid
    FROM pg_catalog.pg_stat_activity a
    WHERE a.pid <> pg_catalog.pg_backend_pid()
      AND a.usesysid IN (SELECT role FROM leases)
  ),
  marked AS (
    UPDATE kilo_lease.lease_role l
    SET gone_since = pg_catalog.now()
    FROM caller
    WHERE l.template = caller.template
      AND l.gone_since IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = l.role)
  ),
  forgotten AS (
    DELETE FROM kilo_lease.lease_role l
    USING caller
    WHERE l.template = caller.template
      AND l.gone_since < pg_catalog.now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = l.role)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.usesysid = l.role)
  )
  SELECT (count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(pid)))::integer FROM targets
$$;

-- Ends, on the node it runs on, the sessions of every recorded lease role (both templates) that no
-- longer exists, has no login (a revocation blocked it) or has passed its VALID UNTIL (an expiry
-- whose revocation did not run or failed). Nothing else: not a superuser, not a live lease, not an
-- admin login, not an application role, not a session of a dropped role that was never a lease,
-- and a role that still exists only while it is a member of the template its row names. It only
-- reads tables, so it runs on a read-only replica. Runs as its owner, `postgres` (a member of
-- pg_signal_backend on Supabase) or, after setup-ci-migration.sql, kilo_lease_owner. Returns the
-- number of sessions signalled; they exit right after.
CREATE FUNCTION kilo_lease.sweep_sessions() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH targets AS MATERIALIZED (
    SELECT a.pid
    FROM pg_catalog.pg_stat_activity a
    JOIN kilo_lease.lease_role l ON l.role = a.usesysid
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = l.role
    WHERE a.pid <> pg_catalog.pg_backend_pid()
      AND (r.oid IS NULL
        OR (NOT r.rolsuper
          AND (NOT r.rolcanlogin OR r.rolvaliduntil < pg_catalog.now())
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members m
            WHERE m.member = r.oid AND m.roleid = l.template AND NOT m.admin_option
          )))
  )
  SELECT (count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(pid)))::integer FROM targets
$$;
REVOKE ALL ON FUNCTION kilo_lease.sweep_sessions() FROM PUBLIC;

-- The login the lease object sweeps each replica with: USAGE on the schema and EXECUTE on
-- sweep_sessions, nothing else beyond what PUBLIC holds. It can end only sessions whose lease
-- already ended, never a live lease's, an application's or another login's. It logs in on the
-- primary too (Supabase gives no per-role host rule); sweep_sessions does the same there. Its
-- connection limit covers Hyperdrive's origin pool for this login (one connection a minute in
-- use). `postgres` created it and so administers it: a `ci-migration` lease acting as `postgres`
-- could reset its password, which gives nothing that lease does not already hold.
--
-- The password reaches the CREATE ROLE as in setup.sql (a transaction-local setting and EXECUTE),
-- so `log_statement = 'ddl'` does not log it (check.sh).
SELECT FROM pg_catalog.set_config('kilo_lease.sweeper_password', :'sweeper_password', true);
DO $$
BEGIN
  EXECUTE format('CREATE ROLE kilo_lease_sweeper LOGIN CONNECTION LIMIT 5 PASSWORD %L',
    pg_catalog.current_setting('kilo_lease.sweeper_password'));
  PERFORM pg_catalog.set_config('kilo_lease.sweeper_password', '', true);
END
$$;
ALTER ROLE kilo_lease_sweeper SET statement_timeout = '5s';
GRANT USAGE ON SCHEMA kilo_lease TO kilo_lease_sweeper;
GRANT EXECUTE ON FUNCTION kilo_lease.sweep_sessions() TO kilo_lease_sweeper;

COMMIT;
