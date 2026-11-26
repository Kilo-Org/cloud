import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_STORE_TABLES } from '../../src/db/rows';
import { LOGIN_ROLES } from './connection';
import {
  TestDatabase,
  insertAccount,
  insertAudit,
  insertBrowserSession,
  insertGatePass,
  loginPassword,
  randomHash,
  sqlStateOf,
} from './harness';

const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Tables the app login writes only through security-definer functions: the OAuth grant functions
 * (migration 0004) and the account functions (migration 0005).
 */
const FUNCTION_WRITTEN_TABLES = [
  'authorization_codes',
  'refresh_grants',
  'device_sessions',
  'third_party_grant_families',
  'third_party_refresh_tokens',
  'third_party_rotated_tokens',
  'revocations',
  'dpop_proofs',
  'personal_access_tokens',
  'org_bot_keys',
  'gate_passes',
];

/** A column each table has, for the refused UPDATE; `status` unless named here. */
const UPDATE_COLUMN: Partial<Record<string, string>> = {
  third_party_refresh_tokens: 'token_hash',
  third_party_rotated_tokens: 'family_id',
  revocations: 'kind',
  dpop_proofs: 'jti',
};

let db: TestDatabase;
let todayPartition: string;

beforeAll(async () => {
  db = await TestDatabase.create();
  todayPartition = `audit_events_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
});
afterAll(() => db.drop());

describe('role attributes', () => {
  it('give no role superuser, role creation, database creation, replication or RLS bypass', async () => {
    const admin = await db.connect();
    const roles = await admin.query<{ rolname: string; rolcanlogin: boolean; elevated: boolean }>(
      `SELECT rolname, rolcanlogin,
              rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls AS elevated
       FROM pg_roles WHERE rolname LIKE 'uts\\_%' AND rolname <> 'uts_admin'
       ORDER BY rolname`
    );
    expect(roles.rows).toEqual(
      [
        ...['uts_app', 'uts_owner', 'uts_pat', 'uts_reader'].map(rolname => ({
          rolname,
          rolcanlogin: false,
          elevated: false,
        })),
        ...LOGIN_ROLES.map(rolname => ({ rolname, rolcanlogin: true, elevated: false })),
      ].sort((a, b) => a.rolname.localeCompare(b.rolname))
    );
  });

  it.each(LOGIN_ROLES)('set a 10-second idle-in-transaction limit for %s', async login => {
    const client = await db.connect(login);
    const result = await client.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout'
    );
    expect(result.rows[0].idle_in_transaction_session_timeout).toBe('10s');
  });

  it.each(LOGIN_ROLES)('set a 5-second statement limit for %s', async login => {
    const client = await db.connect(login);
    const result = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(result.rows[0].statement_timeout).toBe('5s');
  });

  it('cancel a statement that runs for 5 seconds', async () => {
    const client = await db.connect('uts_pat_a');
    const started = Date.now();
    expect(await sqlStateOf(() => client.query('SELECT pg_sleep(6)'))).toBe('57014');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 10_000);

  it('terminate a session whose transaction stays idle for 10 seconds', async () => {
    const client = await db.connect('uts_app_a');
    const { promise: terminated, resolve } = Promise.withResolvers<unknown>();
    // The server's error arrives first; the closed socket then reports a second one.
    client.on('error', resolve);
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM uts.accounts LIMIT 1');
    const started = Date.now();
    const error = await terminated;
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    expect(error).toBeInstanceOf(pg.DatabaseError);
    expect(error instanceof pg.DatabaseError ? error.code : undefined).toBe('25P03');
  }, 20_000);

  it.each(['uts_reader_a', 'uts_reader_b'] as const)(
    'start %s in read-only transactions',
    async login => {
      const client = await db.connect(login);
      const result = await client.query<{ default_transaction_read_only: string }>(
        'SHOW default_transaction_read_only'
      );
      expect(result.rows[0].default_transaction_read_only).toBe('on');
    }
  );
});

describe.each(['uts_app_a', 'uts_app_b'] as const)('app login %s', login => {
  it('reads and writes the credential tables it owns directly', async () => {
    const app = await db.connect(login);
    const accountId = await insertAccount(app);
    await insertBrowserSession(app, accountId);
    const result = await app.query(
      `INSERT INTO uts.notices (account_id, kind) VALUES ($1, 'sessions_revoked') RETURNING id`,
      [accountId]
    );
    expect(result.rowCount).toBe(1);
    await app.query('SELECT 1 FROM uts.personal_access_tokens LIMIT 1');
  });

  it('runs OAuth row maintenance', async () => {
    const app = await db.connect(login);
    const maintenance = await app.query<{ kind: string }>(
      'SELECT kind FROM uts.maintain_oauth_rows()'
    );
    expect(maintenance.rows.map(row => row.kind)).toEqual([
      'blocked_client_families',
      'authorization_codes',
      'third_party_refresh_tokens',
      'third_party_rotated_tokens',
      'revocations',
      'dpop_proofs',
    ]);
  });

  it('inserts audit rows and runs partition maintenance', async () => {
    const app = await db.connect(login);
    await insertAudit(app);
    const maintenance = await app.query('SELECT * FROM uts.maintain_audit_partitions()');
    expect(maintenance.rows).toEqual([]);
  });

  it.each([
    ['create a role', 'CREATE ROLE uts_intruder'],
    [
      'change the other app login',
      `ALTER ROLE ${login === 'uts_app_a' ? 'uts_app_b' : 'uts_app_a'} PASSWORD 'other'`,
    ],
    ['change a PAT login', `ALTER ROLE uts_pat_a PASSWORD 'other'`],
    ['grant itself role creation', 'ALTER ROLE CURRENT_USER CREATEROLE'],
    ['grant itself the owner role', 'GRANT uts_owner TO CURRENT_USER'],
    ['grant itself the PAT role', 'GRANT uts_pat TO CURRENT_USER'],
    ['create a table', 'CREATE TABLE uts.intruder (id int)'],
    ['drop a table', 'DROP TABLE uts.accounts'],
    ['alter a table', 'ALTER TABLE uts.accounts ADD COLUMN note text'],
    ['truncate a table', 'TRUNCATE uts.revocations'],
    ['update an audit row', `UPDATE uts.audit_events SET event_type = 'ai.kilo.uts.changed'`],
    ['delete an audit row', 'DELETE FROM uts.audit_events'],
    [
      'set the transaction id of an audit row',
      `INSERT INTO uts.audit_events (txid, event_id, event_type, event)
       VALUES ('1', gen_random_uuid(), 'ai.kilo.uts.test', '{}')`,
    ],
    [
      'backdate an audit row',
      `INSERT INTO uts.audit_events (created_at, event_id, event_type, event)
       VALUES (now() - interval '8 days', gen_random_uuid(), 'ai.kilo.uts.test', '{}')`,
    ],
    ['insert a watermark row', 'INSERT INTO uts.audit_relay_watermarks (shard) VALUES (0)'],
    ['delete a watermark row', 'DELETE FROM uts.audit_relay_watermarks'],
    [
      'call partition maintenance with a chosen time',
      `SELECT uts.audit_partition_maintenance_at(now() + interval '30 days', 7)`,
    ],
    ['call the PAT lookup', `SELECT * FROM uts.lookup_pat('\\x00')`],
    ['read the migration record', 'SELECT * FROM uts_migrations.applied'],
  ])('cannot %s', async (_name, statement) => {
    const app = await db.connect(login);
    expect(await sqlStateOf(() => app.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot read an audit partition directly', async () => {
    const app = await db.connect(login);
    expect(await sqlStateOf(() => app.query(`SELECT * FROM uts.${todayPartition}`))).toBe(
      INSUFFICIENT_PRIVILEGE
    );
  });

  it.each(FUNCTION_WRITTEN_TABLES)(
    'cannot insert, update or delete uts.%s directly, only read it',
    async table => {
      const app = await db.connect(login);
      await app.query(`SELECT 1 FROM uts.${table} LIMIT 1`);
      const column = UPDATE_COLUMN[table] ?? 'status';
      for (const statement of [
        `INSERT INTO uts.${table} DEFAULT VALUES`,
        `UPDATE uts.${table} SET ${column} = ${column} WHERE false`,
        `DELETE FROM uts.${table} WHERE false`,
      ]) {
        expect(await sqlStateOf(() => app.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }
  );

  it.each([
    [
      'revoke a grant without its audit row',
      `SELECT uts.end_grant('first_party', gen_random_uuid(), 'sign_out')`,
    ],
    [
      'write an audit row through the OAuth writer',
      `SELECT uts.write_audit_event('development', 'ai.kilo.uts.test', 6003, 1, 'success', NULL, 'a', '{}')`,
    ],
    ['read a grant through the hot-path read', `SELECT * FROM uts.read_refresh_grant('\\x00')`],
  ])('cannot %s', async (_name, statement) => {
    const app = await db.connect(login);
    expect(await sqlStateOf(() => app.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('changes its own password, which the rotation job needs', async () => {
    const app = await db.connect(login);
    await app.query(`ALTER ROLE CURRENT_USER PASSWORD ${pg.escapeLiteral(loginPassword())}`);
  });
});

describe.each(['uts_pat_a', 'uts_pat_b'] as const)('PAT login %s', login => {
  it('finds an active PAT and an active bot key by hash', async () => {
    const app = await db.connectAsOwner();
    const accountId = await insertAccount(app);
    const patHash = randomHash();
    await app.query(
      `INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')`,
      [accountId, patHash, await insertGatePass(app, accountId, 'pat_create')]
    );
    const botHash = randomHash();
    await app.query(
      `INSERT INTO uts.org_bot_keys
         (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES (gen_random_uuid(), $1, 'bot', $2, 'wxyz', 'gateway', 'gateway:models.read', $3,
               now() + interval '90 days')`,
      [accountId, botHash, await insertGatePass(app, accountId, 'bot_key_create')]
    );

    const pat = await db.connect(login);
    const patRows = await pat.query('SELECT account_id FROM uts.lookup_pat($1)', [patHash]);
    expect(patRows.rows).toEqual([{ account_id: accountId }]);
    const botRows = await pat.query('SELECT audience FROM uts.lookup_bot_key($1)', [botHash]);
    expect(botRows.rows).toEqual([{ audience: 'gateway' }]);
  });

  it.each([
    'uts.refresh_grants',
    'uts.browser_sessions',
    'uts.device_sessions',
    'uts.personal_access_tokens',
    'uts.org_bot_keys',
    'uts.authorization_codes',
    'uts.accounts',
    'uts.audit_events',
    'uts_read.accounts',
  ])('cannot read %s', async table => {
    const pat = await db.connect(login);
    expect(await sqlStateOf(() => pat.query(`SELECT * FROM ${table}`))).toBe(
      INSUFFICIENT_PRIVILEGE
    );
  });

  it.each([
    ['revoke a PAT', `UPDATE uts.personal_access_tokens SET status = 'revoked'`],
    ['run partition maintenance', 'SELECT * FROM uts.maintain_audit_partitions()'],
    ['create a table', 'CREATE TABLE uts.intruder (id int)'],
    ['create a table in the public schema', 'CREATE TABLE public.intruder (id int)'],
    ['check an audit event', `SELECT uts.is_audit_event('{}')`],
  ])('cannot %s', async (_name, statement) => {
    const pat = await db.connect(login);
    expect(await sqlStateOf(() => pat.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe.each(['uts_reader_a', 'uts_reader_b'] as const)('reader login %s', login => {
  it('reads the account views', async () => {
    const app = await db.connect('uts_app_a');
    const accountId = await insertAccount(app);
    const reader = await db.connect(login);
    const result = await reader.query('SELECT id, status FROM uts_read.accounts WHERE id = $1', [
      accountId,
    ]);
    expect(result.rows).toEqual([{ id: accountId, status: 'active' }]);
  });

  it.each(['uts.accounts', 'uts.refresh_grants', 'uts.personal_access_tokens', 'uts.audit_events'])(
    'cannot read %s',
    async table => {
      const reader = await db.connect(login);
      expect(await sqlStateOf(() => reader.query(`SELECT * FROM ${table}`))).toBe(
        INSUFFICIENT_PRIVILEGE
      );
    }
  );

  it('cannot write through a view, even in a read-write transaction', async () => {
    const reader = await db.connect(login);
    await reader.query('BEGIN READ WRITE');
    try {
      expect(
        await sqlStateOf(() => reader.query(`UPDATE uts_read.accounts SET status = 'blocked'`))
      ).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await reader.query('ROLLBACK');
    }
  });

  it('cannot call the PAT lookup', async () => {
    const reader = await db.connect(login);
    expect(await sqlStateOf(() => reader.query(`SELECT * FROM uts.lookup_pat('\\x00')`))).toBe(
      INSUFFICIENT_PRIVILEGE
    );
  });
});

describe('reader views', () => {
  it('expose no hash, DPoP key, public key or client address', async () => {
    const admin = await db.connect();
    const result = await admin.query<{ column: string }>(
      `SELECT table_name || '.' || column_name AS column FROM information_schema.columns
       WHERE table_schema = 'uts_read'
         AND (column_name LIKE '%hash%' OR column_name IN ('dpop_jkt', 'public_key', 'credential_id',
              'client_ip', 'last_used_ip', 'provider_subject', 'document'))`
    );
    expect(result.rows).toEqual([]);
  });
});

describe('schemas', () => {
  it('grant USAGE only to the group roles that need it, and nothing to PUBLIC', async () => {
    const admin = await db.connect();
    const result = await admin.query<{ schema: string; grantee: string; privilege: string }>(
      `SELECT nspname::text AS schema, coalesce(grantee.rolname::text, 'PUBLIC') AS grantee,
              acl.privilege_type AS privilege
       FROM pg_namespace
       CROSS JOIN LATERAL aclexplode(coalesce(nspacl, acldefault('n', nspowner))) AS acl
       LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
       WHERE nspname IN ('uts', 'uts_read', 'uts_migrations') AND acl.grantee <> nspowner
       ORDER BY 1, 2, 3`
    );
    expect(result.rows).toEqual([
      { schema: 'uts', grantee: 'uts_app', privilege: 'USAGE' },
      { schema: 'uts', grantee: 'uts_pat', privilege: 'USAGE' },
      { schema: 'uts_read', grantee: 'uts_reader', privilege: 'USAGE' },
    ]);
  });
});

describe('table privileges', () => {
  it('match the matrix for every group role, column grants included', async () => {
    const admin = await db.connect();
    const result = await admin.query<{ grantee: string; relation: string; privilege: string }>(
      `SELECT grantee, relation, privilege FROM (
         SELECT coalesce(grantee.rolname::text, 'PUBLIC') AS grantee,
                namespace.nspname || '.' || class.relname AS relation,
                acl.privilege_type AS privilege
         FROM pg_class AS class
         JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
         CROSS JOIN LATERAL aclexplode(coalesce(class.relacl, acldefault('r', class.relowner))) AS acl
         LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
         WHERE namespace.nspname IN ('uts', 'uts_read') AND class.relkind IN ('r', 'p', 'v')
           AND acl.grantee <> class.relowner
         UNION ALL
         SELECT coalesce(grantee.rolname::text, 'PUBLIC'),
                namespace.nspname || '.' || class.relname || '(' || attribute.attname || ')',
                acl.privilege_type
         FROM pg_attribute AS attribute
         JOIN pg_class AS class ON class.oid = attribute.attrelid
         JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
         CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
         LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
         WHERE namespace.nspname IN ('uts', 'uts_read') AND attribute.attacl IS NOT NULL
       ) AS grants`
    );

    const credentialTables = Object.keys(IDENTITY_STORE_TABLES).filter(
      table => table !== 'audit_events' && table !== 'audit_relay_watermarks'
    );
    const views = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'uts_read'::regnamespace AND relkind = 'v'`
    );
    const expected = [
      ...credentialTables.flatMap(table =>
        (FUNCTION_WRITTEN_TABLES.includes(table)
          ? ['SELECT']
          : ['DELETE', 'INSERT', 'SELECT', 'UPDATE']
        ).map(privilege => ({ grantee: 'uts_app', relation: `uts.${table}`, privilege }))
      ),
      { grantee: 'uts_app', relation: 'uts.audit_events', privilege: 'SELECT' },
      ...['account_id', 'event', 'event_id', 'event_type'].map(column => ({
        grantee: 'uts_app',
        relation: `uts.audit_events(${column})`,
        privilege: 'INSERT',
      })),
      { grantee: 'uts_app', relation: 'uts.audit_relay_watermarks', privilege: 'SELECT' },
      ...['last_id', 'last_seq', 'last_txid', 'updated_at'].map(column => ({
        grantee: 'uts_app',
        relation: `uts.audit_relay_watermarks(${column})`,
        privilege: 'UPDATE',
      })),
      ...views.rows.map(view => ({
        grantee: 'uts_reader',
        relation: `uts_read.${view.relname}`,
        privilege: 'SELECT',
      })),
    ];
    const key = (grant: { grantee: string; relation: string; privilege: string }) =>
      `${grant.grantee} ${grant.relation} ${grant.privilege}`;
    expect(views.rows.length).toBeGreaterThan(0);
    expect(result.rows.map(key).sort()).toEqual(expected.map(key).sort());
  });
});

describe('functions', () => {
  it('grant EXECUTE to no role except the ones each migration names', async () => {
    const admin = await db.connect();
    const result = await admin.query<{ routine: string; grantee: string }>(
      `SELECT p.proname AS routine, coalesce(grantee.rolname, 'PUBLIC') AS grantee
       FROM pg_proc AS p
       CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
       LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
       WHERE p.pronamespace = 'uts'::regnamespace AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee <> 'uts_owner'::regrole
       ORDER BY 1, 2`
    );
    expect(result.rows).toEqual([
      { routine: 'create_bot_key', grantee: 'uts_app' },
      { routine: 'create_pat', grantee: 'uts_app' },
      { routine: 'exchange_authorization_code', grantee: 'uts_app' },
      { routine: 'introspect_refresh_token', grantee: 'uts_app' },
      { routine: 'is_audit_event', grantee: 'uts_app' },
      { routine: 'is_scope', grantee: 'uts_app' },
      { routine: 'is_scope_set', grantee: 'uts_app' },
      { routine: 'issue_authorization_code', grantee: 'uts_app' },
      { routine: 'keep_bot_key', grantee: 'uts_app' },
      { routine: 'list_bot_keys', grantee: 'uts_app' },
      { routine: 'list_pats', grantee: 'uts_app' },
      { routine: 'lookup_bot_key', grantee: 'uts_pat' },
      { routine: 'lookup_pat', grantee: 'uts_pat' },
      { routine: 'maintain_audit_partitions', grantee: 'uts_app' },
      { routine: 'maintain_oauth_rows', grantee: 'uts_app' },
      { routine: 'open_tier_a_gate_pass', grantee: 'uts_app' },
      { routine: 'refresh_first_party', grantee: 'uts_app' },
      { routine: 'refresh_third_party', grantee: 'uts_app' },
      { routine: 'remove_org_member', grantee: 'uts_app' },
      { routine: 'revoke_bot_key', grantee: 'uts_app' },
      { routine: 'revoke_pat', grantee: 'uts_app' },
      { routine: 'revoke_refresh_token', grantee: 'uts_app' },
    ]);
  });
});
