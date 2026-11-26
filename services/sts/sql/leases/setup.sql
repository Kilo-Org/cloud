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
-- setup-ci-migration.sql afterwards, which only a superuser can run.

\if :{?replica_admin_password}
\else
  \echo 'set -v replica_admin_password=...'
  \quit
\endif

BEGIN;

-- Functions `postgres` creates from now on are no longer executable by PUBLIC (a per-schema
-- default cannot remove PUBLIC's global one). Supabase's own defaults keep EXECUTE for `anon`,
-- `authenticated` and `service_role` on functions in `public`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Today's functions in `public` that `postgres` owns and that could write or run with their
-- owner's rights (SECURITY DEFINER or VOLATILE), except an extension's own: PUBLIC loses EXECUTE.
-- `postgres` can revoke only the grants it made, so functions other roles own stay as they are;
-- report.sql lists what remains.
DO $$
DECLARE
  routine regprocedure;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proowner = 'postgres'::regrole
      AND (p.prosecdef OR p.provolatile = 'v')
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
-- rights. It cannot end another role's session: kilo_lease.end_sessions below ends only lease
-- sessions.
CREATE ROLE kilo_lease_replica_admin LOGIN CREATEROLE CONNECTION LIMIT 4 PASSWORD :'replica_admin_password';
GRANT kilo_lease_replica_read TO kilo_lease_replica_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

-- The lease statements' helpers. Each knows its caller's template by `session_user`, which a
-- session cannot change without superuser rights: replica admin -> kilo_lease_replica_read and
-- names `lease_rr_<20 of [a-z0-9]>`; migration admin -> kilo_lease_migration and `lease_cm_...`.
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

-- Ends, on this node, the sessions of `username` when it is a lease role of the caller's template,
-- the sessions of every lease role of that template whose VALID UNTIL has passed, and every session
-- whose role no longer exists (a login that landed while an earlier revocation committed). Nothing
-- else: not a superuser, not an admin login, not an application role. Runs as `postgres`, which
-- Supabase makes a member of pg_signal_backend. Returns the number of sessions signalled; they
-- exit right after. It drops the transaction's activity snapshot first, so a second call in the
-- same revocation sees the logins that landed since the first.
CREATE FUNCTION kilo_lease.end_sessions(username text) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.pg_stat_clear_snapshot();
  WITH caller AS (SELECT * FROM kilo_lease.caller_template()),
  lease_roles AS (
    SELECT r.oid
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    JOIN caller ON m.roleid = caller.template
    WHERE NOT m.admin_option
      AND NOT r.rolsuper
      AND starts_with(r.rolname, caller.prefix)
      AND (r.rolname = username OR r.rolvaliduntil < pg_catalog.now())
  ),
  -- Materialized, so the termination below runs on these sessions only.
  targets AS MATERIALIZED (
    SELECT a.pid
    FROM pg_catalog.pg_stat_activity a
    WHERE a.pid <> pg_catalog.pg_backend_pid()
      AND a.backend_type = 'client backend'
      AND (
        a.usesysid IN (SELECT oid FROM lease_roles)
        OR (a.usesysid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = a.usesysid))
      )
  )
  SELECT (count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(pid)))::integer FROM targets
$$;

-- The revocation statement (revoke.sql). In order: no new login (committed with the transaction),
-- end the sessions, drop what the role owns and the rights it granted in this database, end the
-- sessions again (a login that landed meanwhile), drop the role. When the drop fails (an object in
-- another database, a right `postgres` granted to it), the role stays without login, its sessions
-- ended, and report.sql lists it; the revocation still succeeds, so the lease is never left with a
-- usable role. A role that is already gone is a no-op, so a repeated revocation succeeds.
CREATE FUNCTION kilo_lease.revoke_lease(username text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM kilo_lease.check_username(username);
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = username) THEN
    PERFORM kilo_lease.end_sessions(username);
    RETURN true;
  END IF;
  EXECUTE format('ALTER ROLE %I NOLOGIN VALID UNTIL %L', username, '-infinity');
  PERFORM kilo_lease.end_sessions(username);
  BEGIN
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
  kilo_lease.end_sessions(text), kilo_lease.revoke_lease(text)
  TO kilo_lease_replica_admin;

COMMIT;

\ir report.sql
