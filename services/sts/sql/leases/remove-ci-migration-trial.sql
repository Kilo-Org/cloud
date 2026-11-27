-- Removes what the `ci-migration` trial left in one environment (README "Removing the ci-migration
-- trial"): the migration admin login, its template role, its `lease_cm_` lease roles, and
-- `kilo_lease_owner`, which setup-ci-migration.sql made the owner of the `kilo_lease` objects.
-- Run the listing first; it changes nothing:
--
--   psql "<primary direct URL>" -v ON_ERROR_STOP=1 -v list_only=1 -f services/sts/sql/leases/remove-ci-migration-trial.sql
--
-- Then, if it lists any role, run it again without `list_only`, as a superuser when
-- `kilo_lease_owner` exists (REASSIGN OWNED needs membership in it, which `postgres` lacks), else as
-- `postgres`. Revoke every `ci-migration` lease first (none is live once STS has no such grant).

SELECT rolname, rolcanlogin
FROM pg_roles
WHERE rolname IN ('kilo_lease_migration_admin', 'kilo_lease_migration', 'kilo_lease_owner')
  OR rolname LIKE 'lease\_cm\_%'
ORDER BY rolname;

\if :{?list_only}
  \quit
\endif

BEGIN;

-- 1. Give everything kilo_lease_owner owns (the kilo_lease schema, its table and functions) back
--    to postgres.
DO $$
BEGIN
  IF to_regrole('kilo_lease_owner') IS NOT NULL THEN
    REASSIGN OWNED BY kilo_lease_owner TO postgres;
  END IF;
END
$$;

-- 2. Drop the lease roles of the template (with what they own and were granted), then the admin
--    login, the template and kilo_lease_owner (with the rights granted to them).
DO $$
DECLARE
  role_name text;
BEGIN
  FOR role_name IN
    SELECT rolname FROM pg_roles WHERE rolname LIKE 'lease\_cm\_%'
    UNION ALL
    SELECT unnest(ARRAY['kilo_lease_migration_admin', 'kilo_lease_migration', 'kilo_lease_owner'])
  LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('DROP OWNED BY %I', role_name);
      EXECUTE format('DROP ROLE %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- 3. postgres owns every kilo_lease object again; anything else stops here and rolls back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace = 'kilo_lease'::regnamespace AND proowner <> 'postgres'::regrole
    UNION ALL
    SELECT 1 FROM pg_class WHERE relnamespace = 'kilo_lease'::regnamespace AND relowner <> 'postgres'::regrole
    UNION ALL
    SELECT 1 FROM pg_namespace WHERE nspname = 'kilo_lease' AND nspowner <> 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'a kilo_lease object is not owned by postgres';
  END IF;
END
$$;

COMMIT;

\ir report.sql
