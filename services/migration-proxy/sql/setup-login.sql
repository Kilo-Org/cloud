-- Production member mode only (design Q64a). Run as postgres: -v block=create | rotate.
-- The password comes from MIGRATION_PROXY_DB_PASSWORD (\getenv), never argv. It passes
-- through a transaction-local setting, so no DDL statement carries it; like the lease setup,
-- the set_config SELECT is still logged under log_statement = 'all' or pgaudit: run it with both
-- off for the session (README "Rotation"), and never with psql -a or -e, which echo it.
\set ON_ERROR_STOP 1
\getenv proxy_password MIGRATION_PROXY_DB_PASSWORD
\if :{?proxy_password}
\else
  \echo 'MIGRATION_PROXY_DB_PASSWORD is not set'
  -- A failing statement, so psql exits non-zero (ON_ERROR_STOP) instead of 0.
  DO $$ BEGIN RAISE EXCEPTION 'MIGRATION_PROXY_DB_PASSWORD is not set'; END $$;
\endif
SELECT :'block' = 'create' AS is_create, :'block' = 'rotate' AS is_rotate \gset
BEGIN;
DO $$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'run as postgres';
  END IF;
END
$$;
SELECT FROM pg_catalog.set_config('kilo_migration_proxy.password', :'proxy_password', true);
\if :is_create
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    RAISE EXCEPTION 'member mode needs PostgreSQL 15 (design Q64a residual 11)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kilo_migration_proxy') THEN
    RAISE EXCEPTION 'kilo_migration_proxy already exists';
  END IF;
  IF length(current_setting('kilo_migration_proxy.password')) < 40 THEN
    RAISE EXCEPTION 'password shorter than 40 characters';
  END IF;
  EXECUTE format('CREATE ROLE kilo_migration_proxy LOGIN NOINHERIT CONNECTION LIMIT 2 PASSWORD %L',
    current_setting('kilo_migration_proxy.password'));
  PERFORM pg_catalog.set_config('kilo_migration_proxy.password', '', true);
END
$$;
GRANT postgres TO kilo_migration_proxy;
ALTER ROLE kilo_migration_proxy SET role = 'postgres';
DO $$
DECLARE
  entry text;
BEGIN
  FOR entry IN SELECT unnest(rolconfig) FROM pg_roles WHERE rolname = 'postgres' LOOP
    IF split_part(entry, '=', 1) IN ('statement_timeout', 'lock_timeout',
                                     'idle_in_transaction_session_timeout') THEN
      EXECUTE format('ALTER ROLE kilo_migration_proxy SET %I = %L',
        split_part(entry, '=', 1), substr(entry, strpos(entry, '=') + 1));
    END IF;
  END LOOP;
END
$$;
\elif :is_rotate
DO $$
BEGIN
  IF length(current_setting('kilo_migration_proxy.password')) < 40 THEN
    RAISE EXCEPTION 'password shorter than 40 characters';
  END IF;
  EXECUTE format('ALTER ROLE kilo_migration_proxy PASSWORD %L',
    current_setting('kilo_migration_proxy.password'));
  PERFORM pg_catalog.set_config('kilo_migration_proxy.password', '', true);
END
$$;
\else
  \echo 'block must be create or rotate'
  ROLLBACK;
  \quit
\endif
COMMIT;
SELECT rolname, rolinherit, rolconnlimit, rolcanlogin, rolconfig
  FROM pg_roles WHERE rolname = 'kilo_migration_proxy';
SELECT roleid::regrole AS role, member::regrole, grantor::regrole, admin_option
  FROM pg_auth_members WHERE member = 'kilo_migration_proxy'::regrole;
