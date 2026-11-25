-- Identity-store roles and database settings (design section 5.2).
--
-- Runs as the database's admin login, which needs CREATEROLE but not SUPERUSER (on Supabase this
-- is the `postgres` login) and owns the database. Roles are cluster-wide, so every role statement
-- here is safe to run again against another database in the same cluster.
--
-- Group roles carry every privilege; login roles carry none of their own:
--   uts_owner   owns the schema and every object in it; nobody logs in as it.
--   uts_app     mint, sign-in, refresh, revoke and the audit relay (primary Hyperdrive config).
--   uts_pat     PAT and org bot key lookups only (PAT Hyperdrive config).
--   uts_reader  read-only account views (replica Hyperdrive config).
-- Each group has two logins, `_a` and `_b`. UTS rotates the idle one and switches each Hyperdrive
-- config between them, so a rotation never changes the password of the login in use.

DO $roles$
DECLARE
  group_role text;
  login_suffix text;
  login_role text;
BEGIN
  FOREACH group_role IN ARRAY ARRAY['uts_owner', 'uts_app', 'uts_pat', 'uts_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = group_role) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        group_role
      );
    END IF;
  END LOOP;

  FOREACH group_role IN ARRAY ARRAY['uts_app', 'uts_pat', 'uts_reader'] LOOP
    FOREACH login_suffix IN ARRAY ARRAY['a', 'b'] LOOP
      login_role := group_role || '_' || login_suffix;
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login_role) THEN
        -- No password here: provisioning sets the first one and the rotation job sets the rest.
        EXECUTE format(
          'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
          login_role
        );
      END IF;
      EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', group_role, login_role);
      -- One stuck session must not stall the audit relay (design section 8.1), and one long
      -- statement must not hold back the relay's oldest-open-transaction horizon either.
      EXECUTE format(
        'ALTER ROLE %I SET idle_in_transaction_session_timeout = %L',
        login_role,
        '10s'
      );
      EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', login_role, '5s');
    END LOOP;
  END LOOP;

  FOREACH login_suffix IN ARRAY ARRAY['a', 'b'] LOOP
    EXECUTE format(
      'ALTER ROLE %I SET default_transaction_read_only = on',
      'uts_reader_' || login_suffix
    );
  END LOOP;

  -- The admin login runs later migrations with `SET LOCAL ROLE uts_owner`, so every object it
  -- creates belongs to the owner role. It does not inherit the owner's privileges.
  EXECUTE format('GRANT uts_owner TO %I WITH INHERIT FALSE, SET TRUE', current_user);
END
$roles$;

-- Database-wide settings. A role setting wins over these for the UTS logins; these cover every
-- other session in this database, such as an admin, migration or dashboard session. The relay's
-- horizon is the oldest open transaction of the whole server, so a session in another database
-- on the same server can still hold it back; the alert on an unrelayed row older than 60 seconds
-- covers that case.
DO $database$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L',
    current_database(),
    '10s'
  );
  -- PUBLIC keeps CONNECT, which every login needs, but loses TEMP: no role here needs temporary
  -- tables, and a temporary schema is one more place a session could stage data.
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', current_database());
END
$database$;
