-- One-time database setup for the Infisical dynamic secret `replica-read`, and the helpers both
-- lease kinds use (services/sts/README.md, "Database leases"). Run it with psql against the
-- PRIMARY's direct endpoint (not Supavisor), as `postgres` (the role that owns the database and
-- the application schema on Supabase), on PostgreSQL 16 or later:
--
--   psql "<primary direct URL>" -v ON_ERROR_STOP=1 \
--     -v replica_admin_password="<generated>" -f services/sts/sql/leases/setup.sql
--
-- The password goes into the Infisical dynamic secret once, by hand, and nowhere else. Roles are
-- created on the primary; a replica receives them through replication. `ci-migration` needs
-- setup-ci-migration.sql afterwards, which only a superuser can run. `replica-read` also needs
-- setup-replica-sweeper.sql right after this file (before setup-ci-migration.sql).

\if :{?replica_admin_password}
\else
  \echo 'set -v replica_admin_password=...'
  \quit
\endif

BEGIN;

-- Functions `postgres` creates from now on are no longer executable by PUBLIC. This default is
-- database-wide: it covers every schema, not only `public` (a per-schema default cannot remove
-- PUBLIC's global one), so a later function that PUBLIC must run needs its own GRANT. Supabase's
-- own defaults keep EXECUTE for `anon`, `authenticated` and `service_role` on functions in `public`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Today's SECURITY DEFINER functions in `public` that `postgres` owns (they run with its rights),
-- except an extension's own: PUBLIC loses EXECUTE. An invoker function runs with the caller's
-- rights, so it stays. `postgres` can revoke only the grants it made, so functions other roles own
-- stay as they are; report.sql lists what remains.
DO $$
DECLARE
  routine regprocedure;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proowner = 'postgres'::regrole
      AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC', routine);
  END LOOP;
END
$$;

-- replica-read: every lease role is a member of this role. SELECT on the application schema,
-- today's tables and every table `postgres` creates later; no other grant.
CREATE ROLE kilo_lease_replica_read NOLOGIN;
GRANT USAGE ON SCHEMA public TO kilo_lease_replica_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kilo_lease_replica_read;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO kilo_lease_replica_read;

-- The login Infisical creates and drops replica-read lease roles with (setup-ci-migration.sql
-- makes a separate one for ci-migration, so a leaked replica login can never create a migration
-- role). CREATEROLE lets it create, alter and drop the roles it created; ADMIN on its template
-- role (without INHERIT or SET) lets it grant that membership and gives it none of the template's
-- rights. It holds no lease role's rights either: kilo_lease.revoke_lease grants it a lease role,
-- for DROP OWNED, only inside the revocation that drops the role. It cannot end another role's
-- session: kilo_lease.end_sessions below ends only lease sessions.
--
-- The password reaches the CREATE ROLE through a transaction-local setting and EXECUTE, so no
-- top-level DDL statement carries it and `log_statement = 'ddl'` does not log it (check.sh). It is
-- still logged under `log_statement = 'all'`, pgaudit or `log_min_duration_statement`, and as the
-- statement or context of an error. The SELECT returns no column, so psql does not print it.
SELECT FROM pg_catalog.set_config('kilo_lease.admin_password', :'replica_admin_password', true);
DO $$
BEGIN
  EXECUTE format('CREATE ROLE kilo_lease_replica_admin LOGIN CREATEROLE CONNECTION LIMIT 4 PASSWORD %L',
    pg_catalog.current_setting('kilo_lease.admin_password'));
  PERFORM pg_catalog.set_config('kilo_lease.admin_password', '', true);
END
$$;
GRANT kilo_lease_replica_read TO kilo_lease_replica_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

-- This login's creation statement carries each lease password as a literal (Infisical's PostgreSQL
-- engine has no bind parameters). None of its statements reaches the server log, whatever the
-- server-wide settings: these role settings are superuser-only parameters, which Supabase lets
-- `postgres` set per role (supautils; https://supabase.com/docs/guides/database/postgres/postgres-log-config),
-- and the login itself cannot change them. pgaudit and auto_explain get the same when loaded.
-- setup-ci-migration.sql, run as a superuser, also hides its statements from pg_stat_activity.
ALTER ROLE kilo_lease_replica_admin SET log_statement = 'none';
ALTER ROLE kilo_lease_replica_admin SET log_min_duration_statement = -1;
ALTER ROLE kilo_lease_replica_admin SET log_min_error_statement = 'panic';
DO $$
BEGIN
  IF pg_catalog.current_setting('pgaudit.log', true) IS NOT NULL THEN
    ALTER ROLE kilo_lease_replica_admin SET pgaudit.log = 'none';
  END IF;
  IF pg_catalog.current_setting('auto_explain.log_min_duration', true) IS NOT NULL THEN
    ALTER ROLE kilo_lease_replica_admin SET auto_explain.log_min_duration = -1;
  END IF;
END
$$;

-- The lease statements' helpers. Each knows its caller's template by `session_user`, which a
-- session cannot change without superuser rights: replica admin -> kilo_lease_replica_read and
-- names `lease_rr_<20 of [a-z0-9]>`; migration admin -> kilo_lease_migration and `lease_cm_...`.
-- `postgres` owns the schema, its table and its functions here; setup-ci-migration.sql moves them
-- to kilo_lease_owner before any lease can act as `postgres`, so such a lease cannot replace them.
-- With setup.sql alone no lease acts as `postgres`, and whoever holds `postgres` already holds
-- every right a replica-read lease has.
CREATE SCHEMA kilo_lease;

-- The lease's template and name prefix for the calling admin login; an error for any other login.
CREATE FUNCTION kilo_lease.caller_template(OUT template regrole, OUT prefix text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF session_user = 'kilo_lease_replica_admin' THEN
    template := 'kilo_lease_replica_read'::regrole;
    prefix := 'lease_rr_';
  ELSIF session_user = 'kilo_lease_migration_admin' THEN
    template := 'kilo_lease_migration'::regrole;
    prefix := 'lease_cm_';
  ELSE
    RAISE EXCEPTION 'kilo_lease helpers serve the lease admin logins only, not %', session_user;
  END IF;
END
$$;

-- Refuses a lease username outside `<prefix>[a-z0-9]{20}`, the Infisical username template's
-- shape, before the creation statement quotes it.
CREATE FUNCTION kilo_lease.check_username(username text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  expected text := (kilo_lease.caller_template()).prefix;
BEGIN
  IF username !~ ('^' || expected || '[a-z0-9]{20}$') THEN
    RAISE EXCEPTION 'lease username % is not %[a-z0-9]{20}', username, expected;
  END IF;
END
$$;

-- Every lease role an admin login created, by OID, with its template; owned by the schema's owner,
-- and no login may write it except through kilo_lease.track_lease. A session whose role no longer exists is
-- ended only when its OID is here, so a revocation never ends a session of a role that was never a
-- lease (PostgreSQL leaves an ordinary role's sessions open when the role is dropped). A row goes
-- once its role is gone and no session of it remains.
CREATE TABLE kilo_lease.lease_role (
  role oid PRIMARY KEY,
  template regrole NOT NULL
);

-- Records `username`, a role the calling admin login just created in its template. Runs as the
-- schema's owner; refuses any other role.
CREATE FUNCTION kilo_lease.track_lease(username text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  caller record;
  lease oid;
BEGIN
  PERFORM kilo_lease.check_username(username);
  SELECT * INTO caller FROM kilo_lease.caller_template();
  SELECT r.oid INTO lease
  FROM pg_catalog.pg_roles r
  JOIN pg_catalog.pg_auth_members m ON m.member = r.oid AND m.roleid = caller.template AND NOT m.admin_option
  WHERE r.rolname = username AND NOT r.rolsuper;
  IF lease IS NULL THEN
    RAISE EXCEPTION 'lease role % is not in %', username, caller.template;
  END IF;
  INSERT INTO kilo_lease.lease_role (role, template) VALUES (lease, caller.template)
  ON CONFLICT (role) DO UPDATE SET template = EXCLUDED.template;
END
$$;

-- Ends, on this node, the sessions of the lease roles of the caller's template (kilo_lease.lease_role)
-- that are `username`, have no login (a revocation blocked them), have passed their VALID UNTIL, or
-- no longer exist. Nothing else: not a superuser, not an admin login, not an application role, not
-- a session of a dropped role that was never a lease. Runs as its owner, `postgres` (which Supabase
-- makes a member of pg_signal_backend) or, after setup-ci-migration.sql, kilo_lease_owner (granted
-- pg_signal_backend there). Returns the number of sessions signalled; they exit right after. It
-- drops the transaction's activity snapshot first, so a second call in the same revocation sees
-- the logins that landed since the first, and it forgets the rows of roles that are gone with no
-- session left. setup-replica-sweeper.sql replaces it with one that keeps such a row 7 days, so a
-- replica's sweep still knows the dropped role was a lease.
CREATE FUNCTION kilo_lease.end_sessions(username text) RETURNS integer
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
  forgotten AS (
    DELETE FROM kilo_lease.lease_role l
    USING caller
    WHERE l.template = caller.template
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = l.role)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.usesysid = l.role)
  )
  SELECT (count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(pid)))::integer FROM targets
$$;

-- The creation statement (replica-read.create.sql, ci-migration.create.sql): the lease role, in the
-- caller's template, with its connection limit and settings, recorded in kilo_lease.lease_role. The
-- CREATE ROLE runs here through EXECUTE, so the statement Infisical sends is a SELECT, and the
-- admin login's role settings keep that SELECT out of the server log. A failed CREATE ROLE is
-- raised again without its text, so the password is not in the error's context either; the
-- transaction then rolls back, so a password in any error belongs to a role that never existed.
-- Runs as the admin login.
CREATE FUNCTION kilo_lease.create_lease(username text, password text, valid_until timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  caller record;
BEGIN
  PERFORM kilo_lease.check_username(username);
  SELECT * INTO caller FROM kilo_lease.caller_template();
  BEGIN
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L VALID UNTIL %L CONNECTION LIMIT %s IN ROLE %I',
      username, password, valid_until, CASE WHEN caller.prefix = 'lease_rr_' THEN 4 ELSE 2 END,
      caller.template);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'lease role % was not created: %', username, SQLERRM USING ERRCODE = SQLSTATE;
  END;
  IF caller.prefix = 'lease_rr_' THEN
    EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', username);
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', username, '60s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', username, '60s');
    EXECUTE format('ALTER ROLE %I SET idle_session_timeout = %L', username, '15min');
  ELSE
    EXECUTE format('ALTER ROLE %I SET role = %L', username, 'postgres');
  END IF;
  PERFORM kilo_lease.track_lease(username);
END
$$;

-- The revocation statement (revoke.sql) is two transactions in one Infisical call: it splits the
-- text on ';' and runs the parts on one connection inside its own BEGIN and COMMIT, so the
-- `COMMIT;BEGIN;` between the two calls commits the first.
--
-- 1. kilo_lease.block_lease: no new login (NOLOGIN, VALID UNTIL -infinity), committed before
--    anything else, then end the sessions. From that commit on no login of the role can succeed.
-- 2. kilo_lease.revoke_lease: refuses a role that still has its login (a revocation statement that
--    skipped the first part), waits a second for a login that passed its checks before the block
--    committed to show in pg_stat_activity, ends the sessions, takes the lease role's rights for
--    this transaction (DROP OWNED needs them; the grant goes with the role), drops what the role
--    owns and the rights it granted in this database, ends the sessions again, drops the role.
--
-- So the drop commits with no session of the role left. When the drop fails (an object in another
-- database, a right `postgres` granted to it), the grant is undone and the role stays without
-- login, its sessions ended, and report.sql lists it; the revocation still succeeds. A role that
-- is already gone is a no-op, so a repeated revocation succeeds.
CREATE FUNCTION kilo_lease.block_lease(username text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM kilo_lease.check_username(username);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = username AND rolcanlogin) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN VALID UNTIL %L', username, '-infinity');
  END IF;
  PERFORM kilo_lease.end_sessions(username);
END
$$;

CREATE FUNCTION kilo_lease.revoke_lease(username text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM kilo_lease.check_username(username);
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = username) THEN
    PERFORM kilo_lease.end_sessions(username);
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = username AND rolcanlogin) THEN
    RAISE EXCEPTION 'lease role % still has its login: revoke.sql runs kilo_lease.block_lease and commits first', username;
  END IF;
  PERFORM pg_catalog.pg_sleep(1);
  PERFORM kilo_lease.end_sessions(username);
  BEGIN
    EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', username, session_user);
    EXECUTE format('DROP OWNED BY %I', username);
    PERFORM kilo_lease.end_sessions(username);
    EXECUTE format('DROP ROLE %I', username);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'lease role % is kept without login: %', username, SQLERRM;
    RETURN false;
  END;
  RETURN true;
END
$$;

REVOKE ALL ON ALL ROUTINES IN SCHEMA kilo_lease FROM PUBLIC;
GRANT USAGE ON SCHEMA kilo_lease TO kilo_lease_replica_admin;
GRANT EXECUTE ON FUNCTION kilo_lease.caller_template(), kilo_lease.check_username(text),
  kilo_lease.track_lease(text), kilo_lease.create_lease(text, text, timestamptz),
  kilo_lease.end_sessions(text), kilo_lease.block_lease(text), kilo_lease.revoke_lease(text)
  TO kilo_lease_replica_admin;

COMMIT;

\ir report.sql
