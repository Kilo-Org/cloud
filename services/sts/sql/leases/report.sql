-- What a `replica-read` lease role can do in this database beyond its SELECT grants, mostly through
-- the grants PostgreSQL and the installed extensions make to PUBLIC (README "Database leases").
-- setup.sql ends with it; run it again after a migration adds a function or an extension:
--
--   psql "<primary direct URL>" -f services/sts/sql/leases/report.sql
--
-- One row per finding, `kind|object|detail`, then `summary|...`. Every summary count must be 0
-- before the first lease; `temporary`, `large objects` and `advisory locks` rows are PUBLIC grants
-- only a superuser can revoke, which revocation and the connection limit bound instead.

WITH t AS (SELECT 'kilo_lease_replica_read'::regrole AS role),
usable_schemas AS (
  SELECT n.oid, n.nspname
  FROM pg_namespace n, t
  WHERE has_schema_privilege(t.role, n.oid, 'USAGE')
),
findings AS (
  -- Schemas other than the system catalogs.
  SELECT 'schema' AS kind, n.nspname::text AS object,
    CASE WHEN has_schema_privilege(t.role, n.oid, 'CREATE') THEN 'usage, create' ELSE 'usage' END AS detail,
    CASE WHEN has_schema_privilege(t.role, n.oid, 'CREATE') THEN 'create' END AS counts
  FROM usable_schemas n, t
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'

  -- Databases it can connect to, and what it holds there.
  UNION ALL
  SELECT 'database', d.datname::text,
    concat_ws(', ',
      'connect',
      CASE WHEN has_database_privilege(t.role, d.oid, 'TEMPORARY') THEN 'temporary' END,
      CASE WHEN has_database_privilege(t.role, d.oid, 'CREATE') THEN 'create' END)
      || CASE WHEN EXISTS (
        SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT') THEN ' (connect from PUBLIC)' ELSE '' END,
    CASE WHEN has_database_privilege(t.role, d.oid, 'CREATE') THEN 'create' END
  FROM pg_database d, t
  WHERE d.datallowconn AND has_database_privilege(t.role, d.oid, 'CONNECT')

  -- Tables, views and sequences it can change.
  UNION ALL
  SELECT 'writable', format('%I.%I', n.nspname, c.relname),
    concat_ws(', ',
      CASE WHEN c.relkind <> 'S' AND has_table_privilege(t.role, c.oid, 'INSERT') THEN 'insert' END,
      CASE WHEN c.relkind <> 'S' AND has_table_privilege(t.role, c.oid, 'UPDATE') THEN 'update' END,
      CASE WHEN c.relkind <> 'S' AND has_table_privilege(t.role, c.oid, 'DELETE') THEN 'delete' END,
      CASE WHEN c.relkind <> 'S' AND has_table_privilege(t.role, c.oid, 'TRUNCATE') THEN 'truncate' END,
      CASE WHEN c.relkind = 'S' AND has_sequence_privilege(t.role, c.oid, 'USAGE, UPDATE') THEN 'nextval' END),
    'writable'
  FROM pg_class c
  JOIN usable_schemas n ON n.oid = c.relnamespace, t
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND (
      (c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(t.role, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))
      OR (c.relkind = 'S' AND has_sequence_privilege(t.role, c.oid, 'USAGE, UPDATE'))
    )

  -- Relations it can read outside `public`, per schema.
  UNION ALL
  SELECT 'readable', n.nspname::text, count(*)::text || ' relations', NULL
  FROM pg_class c
  JOIN usable_schemas n ON n.oid = c.relnamespace, t
  WHERE n.nspname NOT IN ('public', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND has_table_privilege(t.role, c.oid, 'SELECT')
  GROUP BY n.nspname

  -- Functions that run with their owner's rights, in any schema it can use.
  UNION ALL
  SELECT 'definer', p.oid::regprocedure::text, 'security definer, owner ' || p.proowner::regrole::text, 'definer'
  FROM pg_proc p
  JOIN usable_schemas n ON n.oid = p.pronamespace, t
  WHERE p.prosecdef AND has_function_privilege(t.role, p.oid, 'EXECUTE')

  -- Functions that may write or reach outside the database, outside the system catalogs. One in SQL
  -- or PL/pgSQL runs with the lease's own rights and so is listed, not counted; one in C (an
  -- extension's, such as pg_net's) can do what its code does, and counts.
  UNION ALL
  SELECT 'volatile', p.oid::regprocedure::text,
    'volatile, owner ' || p.proowner::regrole::text
      || coalesce(', extension ' || (
        SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          AND d.refclassid = 'pg_extension'::regclass), '')
      || CASE WHEN l.lanname IN ('sql', 'plpgsql') THEN ', ' || l.lanname || ' with the caller''s rights' ELSE '' END,
    CASE WHEN l.lanname NOT IN ('sql', 'plpgsql') THEN 'volatile' END
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang
  JOIN usable_schemas n ON n.oid = p.pronamespace, t
  WHERE NOT p.prosecdef AND p.provolatile = 'v' AND p.prokind IN ('f', 'p')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND has_function_privilege(t.role, p.oid, 'EXECUTE')

  -- System functions that write or hold locks, granted to PUBLIC by PostgreSQL itself.
  UNION ALL
  SELECT 'catalog', 'large objects',
    string_agg(p.proname::text, ', ' ORDER BY p.proname::text) || ': it can create, write and delete its own large objects; revocation drops them',
    NULL
  FROM pg_proc p, t
  WHERE p.pronamespace = 'pg_catalog'::regnamespace
    AND p.proname IN ('lo_create', 'lo_creat', 'lo_from_bytea', 'lo_put', 'lowrite', 'lo_import', 'lo_unlink')
    AND has_function_privilege(t.role, p.oid, 'EXECUTE')
  HAVING count(*) > 0
  UNION ALL
  SELECT 'catalog', 'advisory locks',
    'pg_advisory_lock and the rest: it can take any advisory lock key, the application''s included', NULL
  FROM t
  WHERE has_function_privilege(t.role, 'pg_catalog.pg_advisory_lock(bigint)', 'EXECUTE')

  -- Installed extensions that reach outside the database, run jobs or touch files.
  UNION ALL
  SELECT 'extension', e.extname::text,
    'schema ' || n.nspname || CASE WHEN has_schema_privilege(t.role, n.oid, 'USAGE') THEN ' (usable)' ELSE ' (no usage)' END,
    CASE WHEN has_schema_privilege(t.role, n.oid, 'USAGE') THEN 'outbound' END
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace, t
  WHERE e.extname IN ('dblink', 'postgres_fdw', 'pg_net', 'http', 'wrappers', 'pg_cron', 'pg_background',
    'file_fdw', 'adminpack', 'plpython3u', 'plperlu', 'pltclu', 'plv8')

  -- Roles it is a member of (it should be none).
  UNION ALL
  SELECT 'member_of', m.roleid::regrole::text, 'membership', 'member_of'
  FROM pg_auth_members m, t
  WHERE m.member = t.role

  -- Lease roles a revocation kept without login, because they could not be dropped.
  UNION ALL
  SELECT 'leftover', r.rolname::text, 'revoked lease role kept without login; drop it by hand', 'leftover'
  FROM pg_roles r
  JOIN pg_auth_members m ON m.member = r.oid AND NOT m.admin_option
  WHERE m.roleid IN (to_regrole('kilo_lease_replica_read'), to_regrole('kilo_lease_migration'))
    AND NOT r.rolcanlogin
)
SELECT kind, object, detail FROM (
  SELECT kind, object, detail, 0 AS part FROM findings
  UNION ALL
  SELECT 'summary', 'replica-read', format(
    'create=%s writable=%s definer=%s volatile=%s outbound=%s member_of=%s leftover=%s',
    count(*) FILTER (WHERE counts = 'create'),
    count(*) FILTER (WHERE counts = 'writable'),
    count(*) FILTER (WHERE counts = 'definer'),
    count(*) FILTER (WHERE counts = 'volatile'),
    count(*) FILTER (WHERE counts = 'outbound'),
    count(*) FILTER (WHERE counts = 'member_of'),
    count(*) FILTER (WHERE counts = 'leftover')), 1
  FROM findings
) rows
ORDER BY part, kind, object;
