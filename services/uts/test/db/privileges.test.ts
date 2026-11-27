import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDENTITY_STORE_TABLES } from '../../src/db/rows';
import { LOGIN_ROLES } from './connection';
import {
  RELAY_READ,
  TestDatabase,
  insertAccount,
  insertAudit,
  insertGatePass,
  loginPassword,
  randomHash,
  sqlStateOf,
} from './harness';

const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Tables the app login writes only through security-definer functions: the OAuth grant functions
 * (migration 0004), the account functions (migration 0005), the sign-in functions (migration
 * 0008), the notice and sign-in functions and triggers (migration 0010) and the third-party
 * client functions (migration 0021).
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
  'passkey_credentials',
  'browser_sessions',
  'step_ups',
  'device_codes',
  'tickets',
  'webauthn_challenges',
  'sign_in_methods',
  'email_codes',
  'email_code_limits',
  'account_user_code_failures',
  'network_user_code_failures',
  'notice_attempts',
  'known_devices',
  'known_networks',
  'sign_ins',
  'third_party_clients',
  'third_party_consents',
  'notices',
  'accounts',
  'sso_connections',
  'sso_domains',
  'org_sso_policies',
  'org_memberships',
];

/**
 * Tables the app login cannot even read: only the sign-in functions reach the flows, and only the
 * subject operation, import and app-event functions (migration 0014) reach the rest.
 */
const FUNCTION_ONLY_TABLES = [
  'sign_in_flows',
  'subject_operations',
  'subject_tombstones',
  'app_account_events',
];

/** A column each table has, for the refused UPDATE; `status` unless named here. */
const UPDATE_COLUMN: Partial<Record<string, string>> = {
  third_party_refresh_tokens: 'token_hash',
  third_party_rotated_tokens: 'family_id',
  revocations: 'kind',
  dpop_proofs: 'jti',
  passkey_credentials: 'name',
  step_ups: 'purpose',
  sign_in_methods: 'provider',
  email_code_limits: 'sent_in_hour',
  account_user_code_failures: 'failures',
  network_user_code_failures: 'failures',
  notice_attempts: 'outcome',
  known_devices: 'last_seen_at',
  known_networks: 'last_seen_at',
  sign_ins: 'new_device',
  notices: 'delivery',
  org_sso_policies: 'enforcement',
};

let db: TestDatabase;
let todayPartition: string;

beforeAll(async () => {
  db = await TestDatabase.create();
  todayPartition = `audit_events_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
});
afterEach(() => db.endConnections());
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

  it.each(LOGIN_ROLES)('set a 10-second transaction limit for %s', async login => {
    const client = await db.connect(login);
    const result = await client.query<{ transaction_timeout: string }>('SHOW transaction_timeout');
    expect(result.rows[0].transaction_timeout).toBe('10s');
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
    // The transaction limit would end the session at the same time; this test shows the idle one.
    await client.query('SET transaction_timeout = 0');
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM uts.accounts LIMIT 1');
    const started = Date.now();
    const error = await terminated;
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    expect(error).toBeInstanceOf(pg.DatabaseError);
    expect(error instanceof pg.DatabaseError ? error.code : undefined).toBe('25P03');
  }, 20_000);

  it('terminate a session whose transaction lasts 10 seconds, even when it is never idle long', async () => {
    const client = await db.connect('uts_app_a');
    const { promise: terminated, resolve } = Promise.withResolvers<unknown>();
    client.on('error', resolve);
    await client.query('BEGIN');
    const started = Date.now();
    let ended: unknown;
    void terminated.then(error => {
      ended = error;
    });
    // The server's own clock drives the transaction limit, so the pauses are real time. Short
    // statements with short pauses keep the statement and idle limits from firing.
    while (ended === undefined && Date.now() - started < 15_000) {
      await client.query('SELECT 1').catch((error: unknown) => {
        ended = error;
      });
      await sleep(1_000);
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    expect(Date.now() - started).toBeLessThan(13_000);
    const error = await terminated;
    expect(error instanceof pg.DatabaseError ? error.code : undefined).toBe('25P04');
  }, 20_000);

  it('end a UTS session that lifted its own limits once its transaction passes the limit', async () => {
    const stuck = await db.connect('uts_app_b');
    const { promise: terminated, resolve } = Promise.withResolvers<unknown>();
    stuck.on('error', resolve);
    await stuck.query(
      `SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0;
       SET transaction_timeout = 0`
    );
    await stuck.query('BEGIN');
    const row = await insertAudit(stuck);
    const pid = await stuck.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

    // The open transaction holds every shard's read back.
    const relay = await db.connect('uts_app_a');
    const horizon = async () => {
      const result = await relay.query<{ xmin: bigint }>(
        'SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin'
      );
      return result.rows[0].xmin;
    };
    expect(await horizon()).toBeLessThanOrEqual(row.txid);
    // The app role's entry point keeps its fixed 30-second limit, so this young session stays.
    expect((await relay.query('SELECT * FROM uts.end_long_transactions()')).rows).toEqual([]);

    // Every other UTS session ends its transaction within 10 seconds, so a limit just above that
    // can end only a session that lifted its own limits. The limit is measured on the server's
    // clock, so the wait is real time.
    await sleep(11_500);
    const owner = await db.connectAsOwner();
    const ended = await owner.query<{ pid: number; login: string }>(
      `SELECT pid, login FROM uts.end_long_transactions_after(interval '11 seconds')`
    );
    expect(ended.rows).toEqual([{ pid: pid.rows[0].pid, login: 'uts_app_b' }]);
    const error = await terminated;
    expect(error instanceof pg.DatabaseError ? error.code : undefined).toBe('57P01');

    await vi.waitFor(async () => expect(await horizon()).toBeGreaterThan(row.txid), {
      timeout: 5_000,
      interval: 100,
    });
    // The rolled-back row never reaches the relay.
    const read = await relay.query<{ id: bigint }>(RELAY_READ, [row.shard, 500]);
    expect(read.rows.map(item => item.id)).not.toContain(row.id);
  }, 25_000);

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
  it('reads a PAT but cannot write it, and a revoked PAT stays revoked', async () => {
    const owner = await db.connectAsOwner();
    const accountId = await insertAccount(owner);
    const pat = await owner.query<{ id: string }>(
      `INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')
       RETURNING id`,
      [accountId, randomHash(), await insertGatePass(owner, accountId, 'pat_create')]
    );
    const app = await db.connect(login);
    const read = await app.query('SELECT id FROM uts.personal_access_tokens WHERE id = $1', [
      pat.rows[0].id,
    ]);
    expect(read.rowCount).toBe(1);
    // PATs change only through the account functions (migration 0005).
    expect(
      await sqlStateOf(() =>
        app.query(
          `UPDATE uts.personal_access_tokens
           SET status = 'revoked', revoked_at = now(), revoke_reason = 'user_revoke'
           WHERE id = $1`,
          [pat.rows[0].id]
        )
      )
    ).toBe('42501');
    await owner.query(
      `UPDATE uts.personal_access_tokens
       SET status = 'revoked', revoked_at = now(), revoke_reason = 'user_revoke'
       WHERE id = $1`,
      [pat.rows[0].id]
    );
    expect(
      await sqlStateOf(() =>
        owner.query(
          `UPDATE uts.personal_access_tokens
           SET status = 'active', revoked_at = NULL, revoke_reason = NULL
           WHERE id = $1`,
          [pat.rows[0].id]
        )
      )
    ).toBe('23514');
  });

  it('runs OAuth and sign-in row maintenance', async () => {
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
    const signIn = await app.query<{ kind: string }>(
      'SELECT kind FROM uts.maintain_sign_in_rows()'
    );
    expect(signIn.rows.map(row => row.kind)).toEqual([
      'webauthn_challenges',
      'device_codes',
      'tickets',
      'step_ups',
      'account_user_code_failures',
      'network_user_code_failures',
      'browser_sessions',
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
    ['move a watermark directly', 'UPDATE uts.audit_relay_watermarks SET last_id = last_id + 1'],
    [
      'call partition maintenance with a chosen time',
      `SELECT uts.audit_partition_maintenance_at(now() + interval '30 days', 7)`,
    ],
    [
      'end transactions with a chosen limit',
      `SELECT * FROM uts.end_long_transactions_after(interval '1 second')`,
    ],
    ['call the PAT lookup', `SELECT * FROM uts.lookup_pat('\\x00')`],
    ['read the migration record', 'SELECT * FROM uts_migrations.applied'],
    ['write a gate pass', `INSERT INTO uts.gate_passes (tier) VALUES ('b')`],
    ['reopen a gate pass', `UPDATE uts.gate_passes SET status = 'open', consumed_at = NULL`],
    ['delete a gate pass', 'DELETE FROM uts.gate_passes'],
    ['insert a PAT', `INSERT INTO uts.personal_access_tokens (name) VALUES ('ci')`],
    ['insert an org bot key', `INSERT INTO uts.org_bot_keys (name) VALUES ('bot')`],
    ['insert a CI trust policy', `INSERT INTO uts.ci_trust_policies (repository_id) VALUES (1)`],
    ['insert a third-party consent', 'INSERT INTO uts.third_party_consents (org_id) VALUES (NULL)'],
    [
      'insert an approved device code',
      `INSERT INTO uts.device_codes (status, approved_at) VALUES ('approved', now())`,
    ],
    ['approve a device code', `UPDATE uts.device_codes SET approved_at = now()`],
    ['detach a bot key from its pass', 'UPDATE uts.org_bot_keys SET gate_pass_id = NULL'],
    ['give a PAT another hash', `UPDATE uts.personal_access_tokens SET token_hash = token_hash`],
    ['extend a PAT', `UPDATE uts.personal_access_tokens SET expires_at = expires_at`],
    ['widen a CI trust policy', `UPDATE uts.ci_trust_policies SET ref_pattern = NULL`],
    ['widen a consent', `UPDATE uts.third_party_consents SET scopes = scopes`],
    [
      'call the gated PAT write step',
      `SELECT * FROM uts.write_gated_pat('a', NULL, 'n', '\\x00', 'abcd', 'gateway:models.read', NULL, 1)`,
    ],
    [
      'call the gated bot key write step',
      `SELECT * FROM uts.write_gated_bot_key('a', NULL, NULL, 'n', '\\x00', 'abcd', 'gateway:models.read', 1)`,
    ],
    ['compute tier B checks', `SELECT uts.tier_b_checks('a', NULL, NULL)`],
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
      // Closed here: this file opens a connection per test, and these cases alone are dozens.
      try {
        await app.query(`SELECT 1 FROM uts.${table} LIMIT 1`);
        const column = UPDATE_COLUMN[table] ?? 'status';
        for (const statement of [
          `INSERT INTO uts.${table} DEFAULT VALUES`,
          `UPDATE uts.${table} SET ${column} = ${column} WHERE false`,
          `DELETE FROM uts.${table} WHERE false`,
        ]) {
          expect(await sqlStateOf(() => app.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      } finally {
        await app.end();
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
    [
      'read a session without the sign-in functions',
      `SELECT * FROM uts.live_browser_session('\\x00')`,
    ],
    [
      'move a passkey counter without the sign-in functions',
      `SELECT uts.use_passkey(gen_random_uuid(), NULL, 0, 1, false)`,
    ],
    [
      'open a gate refusal row without the sign-in functions',
      `SELECT uts.audit_session_gate_refusal('development', 'a', gen_random_uuid(), 'device_approve', 'x')`,
    ],
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
    const owner = await db.connectAsOwner();
    const accountId = await insertAccount(owner);
    const patHash = randomHash();
    await owner.query(
      `INSERT INTO uts.personal_access_tokens
         (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES ($1, 'ci', $2, 'abcd', 'gateway', 'gateway:models.read', $3, now() + interval '90 days')`,
      [accountId, patHash, await insertGatePass(owner, accountId, 'pat_create')]
    );
    const botHash = randomHash();
    await owner.query(
      `INSERT INTO uts.org_bot_keys
         (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
       VALUES (gen_random_uuid(), $1, 'bot', $2, 'wxyz', 'gateway', 'gateway:models.read', $3,
               now() + interval '90 days')`,
      [accountId, botHash, await insertGatePass(owner, accountId, 'bot_key_create')]
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
    const accountId = await insertAccount(await db.connectAsOwner());
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

    // Gated tables (0003_access.sql): no INSERT, and UPDATE only on lifecycle columns. PATs and org
    // bot keys lose even those in 0005, like gate passes, device codes in 0008 and third-party
    // consents in 0021: only the account, sign-in and consent functions write them.
    const gatedUpdates: Record<string, string[]> = {
      ci_trust_policies: ['revoked_at', 'status', 'updated_at'],
    };
    const credentialTables = Object.keys(IDENTITY_STORE_TABLES).filter(
      table =>
        table !== 'audit_events' &&
        table !== 'audit_relay_watermarks' &&
        !(table in gatedUpdates) &&
        !FUNCTION_ONLY_TABLES.includes(table)
    );
    const views = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'uts_read'::regnamespace AND relkind = 'v'`
    );
    const app = (relation: string, privilege: string) => ({
      grantee: 'uts_app',
      relation,
      privilege,
    });
    const expected = [
      ...credentialTables.flatMap(table =>
        (FUNCTION_WRITTEN_TABLES.includes(table)
          ? ['SELECT']
          : ['DELETE', 'INSERT', 'SELECT', 'UPDATE']
        ).map(privilege => app(`uts.${table}`, privilege))
      ),
      ...Object.entries(gatedUpdates).flatMap(([table, columns]) => [
        app(`uts.${table}`, 'DELETE'),
        app(`uts.${table}`, 'SELECT'),
        ...columns.map(column => app(`uts.${table}(${column})`, 'UPDATE')),
      ]),
      app('uts.audit_events', 'SELECT'),
      ...['account_id', 'event', 'event_id', 'event_type'].map(column =>
        app(`uts.audit_events(${column})`, 'INSERT')
      ),
      app('uts.audit_relay_watermarks', 'SELECT'),
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
      { routine: 'ack_app_account_events', grantee: 'uts_app' },
      { routine: 'advance_audit_watermark', grantee: 'uts_app' },
      { routine: 'apply_subject_operation', grantee: 'uts_app' },
      { routine: 'bridge_legacy_session', grantee: 'uts_app' },
      { routine: 'claim_credential_notice', grantee: 'uts_app' },
      { routine: 'claim_due_notices', grantee: 'uts_app' },
      { routine: 'claim_notice', grantee: 'uts_app' },
      { routine: 'complete_email_link', grantee: 'uts_app' },
      { routine: 'complete_passkey_sign_in', grantee: 'uts_app' },
      { routine: 'complete_passkey_step_up', grantee: 'uts_app' },
      { routine: 'complete_provider_sign_in', grantee: 'uts_app' },
      { routine: 'create_bot_key', grantee: 'uts_app' },
      { routine: 'create_device_code', grantee: 'uts_app' },
      { routine: 'create_pat', grantee: 'uts_app' },
      { routine: 'create_webauthn_challenge', grantee: 'uts_app' },
      { routine: 'decide_device_code', grantee: 'uts_app' },
      { routine: 'end_all_web_sessions', grantee: 'uts_app' },
      { routine: 'end_long_transactions', grantee: 'uts_app' },
      { routine: 'end_web_session', grantee: 'uts_app' },
      { routine: 'exchange_authorization_code', grantee: 'uts_app' },
      { routine: 'exchange_delegated_token', grantee: 'uts_app' },
      { routine: 'exchange_device_code', grantee: 'uts_app' },
      { routine: 'exchange_web_code', grantee: 'uts_app' },
      { routine: 'extend_third_party_client', grantee: 'uts_app' },
      { routine: 'feed_entries_of_statement', grantee: 'uts_app' },
      { routine: 'finish_notice', grantee: 'uts_app' },
      { routine: 'grant_third_party_consent', grantee: 'uts_app' },
      { routine: 'import_account', grantee: 'uts_app' },
      { routine: 'introspect_refresh_token', grantee: 'uts_app' },
      { routine: 'is_audit_event', grantee: 'uts_app' },
      { routine: 'is_scope', grantee: 'uts_app' },
      { routine: 'is_scope_set', grantee: 'uts_app' },
      { routine: 'issue_authorization_code', grantee: 'uts_app' },
      { routine: 'issue_ticket', grantee: 'uts_app' },
      { routine: 'keep_bot_key', grantee: 'uts_app' },
      { routine: 'list_bot_keys', grantee: 'uts_app' },
      { routine: 'list_pats', grantee: 'uts_app' },
      { routine: 'list_third_party_consents', grantee: 'uts_app' },
      { routine: 'live_feed_entries', grantee: 'uts_app' },
      { routine: 'live_feed_entries_of_refresh_token', grantee: 'uts_app' },
      { routine: 'lookup_bot_key', grantee: 'uts_pat' },
      { routine: 'lookup_pat', grantee: 'uts_pat' },
      { routine: 'maintain_audit_partitions', grantee: 'uts_app' },
      { routine: 'maintain_notice_rows', grantee: 'uts_app' },
      { routine: 'maintain_oauth_rows', grantee: 'uts_app' },
      { routine: 'maintain_provider_sign_in_rows', grantee: 'uts_app' },
      { routine: 'maintain_sign_in_rows', grantee: 'uts_app' },
      { routine: 'maintain_subject_operation_rows', grantee: 'uts_app' },
      { routine: 'maintain_third_party_client_rows', grantee: 'uts_app' },
      { routine: 'mint_web_session_token', grantee: 'uts_app' },
      { routine: 'open_browser_tier_a_gate_pass', grantee: 'uts_app' },
      { routine: 'open_tier_a_gate_pass', grantee: 'uts_app' },
      { routine: 'read_app_account_events', grantee: 'uts_app' },
      { routine: 'read_browser_session', grantee: 'uts_app' },
      { routine: 'read_device_code', grantee: 'uts_app' },
      { routine: 'read_passkey_assertion', grantee: 'uts_app' },
      { routine: 'read_web_session', grantee: 'uts_app' },
      { routine: 'record_passkey_failure', grantee: 'uts_app' },
      { routine: 'redeem_ticket', grantee: 'uts_app' },
      { routine: 'refresh_first_party', grantee: 'uts_app' },
      { routine: 'refresh_third_party', grantee: 'uts_app' },
      { routine: 'register_passkey', grantee: 'uts_app' },
      { routine: 'remove_org_member', grantee: 'uts_app' },
      { routine: 'revoke_bot_key', grantee: 'uts_app' },
      { routine: 'revoke_pat', grantee: 'uts_app' },
      { routine: 'revoke_refresh_token', grantee: 'uts_app' },
      { routine: 'revoke_web_device', grantee: 'uts_app' },
      { routine: 'save_third_party_client', grantee: 'uts_app' },
      { routine: 'sso_app_organization', grantee: 'uts_app' },
      { routine: 'start_email_sign_in', grantee: 'uts_app' },
      { routine: 'start_sign_in_flow', grantee: 'uts_app' },
      { routine: 'sync_org_membership', grantee: 'uts_app' },
      { routine: 'sync_primary_email', grantee: 'uts_app' },
      { routine: 'sync_sso_organization', grantee: 'uts_app' },
      { routine: 'verify_email_code', grantee: 'uts_app' },
      { routine: 'withdraw_third_party_consent', grantee: 'uts_app' },
    ]);
  });
});
