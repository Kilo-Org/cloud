import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  certificates,
  cleanup,
  docker,
  setupLoginSql,
  startPostgres,
  startProxy,
  waitDone,
  type Postgres,
  type ProxyContainer,
} from './docker';
import { PAIR_SQL, applyBody, concurrentIndex, migrationSet, type Login } from './fixtures';

/**
 * Member mode (production, contract §3, §6) on Supabase's image: demoted `postgres` with
 * supautils. The login is created with the create block of sql/setup-login.sql, as setup does.
 * SUPABASE_PG_IMAGE overrides the image (§11 E step 4a runs this suite on production's exact tag).
 */

const IMAGE = process.env.SUPABASE_PG_IMAGE ?? 'supabase/postgres:15.8.1.135';
/** The login's password; a sentinel the secrecy test looks for in every log and status. */
const PASSWORD = 'sentinel-pw-7f3a-member-login-0123456789abcdef';
const LOGIN: Login = {
  user: 'kilo_migration_proxy',
  password: PASSWORD,
  loginMode: 'member',
  sessionKey: 'label',
};

let db: Postgres;
let databases = 0;
const proxies: ProxyContainer[] = [];

async function newDatabase(): Promise<string> {
  databases += 1;
  const name = `member_${databases}`;
  const admin = await db.admin();
  await admin.query(`CREATE DATABASE ${name} OWNER postgres`);
  await admin.end();
  return name;
}

async function proxy(caFile?: string): Promise<ProxyContainer> {
  const started = await startProxy(caFile);
  proxies.push(started);
  return started;
}

type ApplyBody = ReturnType<typeof applyBody>;

async function apply(body: ApplyBody, container?: ProxyContainer) {
  const target = container ?? (await proxy());
  const accepted = await target.call('POST', '/apply', body);
  expect(accepted.status).toBe(202);
  return { container: target, status: await waitDone(target) };
}

const loginSession = (label: string, database = 'postgres') =>
  db.session('kilo_migration_proxy', PASSWORD, label, database);

const adminOn = (database: string) =>
  db.session('supabase_admin', ADMIN_PASSWORD, 'test-admin', database);

/** Real Postgres and Docker processes: the suite polls for the state it waits on. */
async function until(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function alive(pid: number): Promise<boolean> {
  const admin = await db.admin();
  const result = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
  await admin.end();
  return result.rows.length > 0;
}

/** The pid of the login's session running a statement that starts with `prefix`, once it does. */
async function activePid(prefix: string, waitEventType?: string): Promise<number> {
  let pid: number | undefined;
  await until(async () => {
    const admin = await db.admin();
    const result = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE usename = 'kilo_migration_proxy' AND state = 'active'
         AND ltrim(query, E' \\n') LIKE $1 || '%' AND ($2::text IS NULL OR wait_event_type = $2)`,
      [prefix, waitEventType ?? null]
    );
    await admin.end();
    pid = result.rows[0]?.pid;
    return pid !== undefined;
  }, `a session running ${prefix}`);
  if (pid === undefined) throw new Error('unreachable');
  return pid;
}

beforeAll(async () => {
  certificates();
  db = await startPostgres(IMAGE, 'member');
});

afterAll(() => {
  cleanup();
});

describe(`member mode on ${IMAGE}`, () => {
  it('creates the login with the create block of sql/setup-login.sql, as postgres', () => {
    const output = db.psql(
      [
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'block=create',
        '-At',
        '-F',
        '|',
        '-f',
        '-',
      ],
      { MIGRATION_PROXY_DB_PASSWORD: PASSWORD },
      setupLoginSql()
    );
    const lines = output
      .split('\n')
      .filter(line => line.startsWith('kilo_migration_proxy|') || line.startsWith('postgres|'));
    expect(lines[0]).toMatch(/^kilo_migration_proxy\|f\|2\|t\|\{role=postgres.*\}$/);
    expect(lines[1]).toBe('postgres|kilo_migration_proxy|postgres|f');
    expect(output).not.toContain(PASSWORD);
  });

  it('acts as postgres; RESET ROLE stays postgres, SET ROLE NONE gives the login', async () => {
    const client = await loginSession('test-roles');
    const user = async () =>
      (await client.query<{ u: string; s: string }>('SELECT current_user AS u, session_user AS s'))
        .rows[0];
    expect(await user()).toEqual({ u: 'postgres', s: 'kilo_migration_proxy' });
    await client.query('RESET ROLE');
    expect((await user())?.u).toBe('postgres');
    await client.query('SET ROLE NONE');
    expect((await user())?.u).toBe('kilo_migration_proxy');
    await client.query('SET ROLE postgres');
    expect((await user())?.u).toBe('postgres');
    await client.end();
  });

  it('applies a CONCURRENTLY migration with COMMIT;/BEGIN; and SET statement_timeout = 0, as postgres', async () => {
    const database = await newDatabase();
    const set = migrationSet([
      {
        tag: '0001_widgets',
        sql: 'CREATE TABLE "widgets" ("id" serial PRIMARY KEY, "x" integer);',
      },
      { tag: '0002_widgets_x', sql: concurrentIndex('widgets', 'widgets_x_idx', 'x') },
    ]);
    const { status } = await apply(applyBody(LOGIN, database, set));
    expect(status.failure).toBeNull();
    expect(status.pending).toEqual(['0001_widgets', '0002_widgets_x']);
    expect(status.applied.map(item => item.tag)).toEqual(['0001_widgets', '0002_widgets_x']);
    expect(status.applied.map(item => item.createdAt)).toEqual(
      set.entries.map(entry => entry.when)
    );
    expect(status.cleanup).toEqual({ terminated: 0, unexpected: 0 });
    expect(status.pair?.pid).toBeGreaterThan(0);
    expect(status.pair?.backendStart).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);

    const admin = await db.admin();
    await admin.query(`SELECT 1`);
    await admin.end();
    const check = await loginSession('test-check', database);
    const index = await check.query<{ valid: boolean; owner: string }>(
      `SELECT i.indisvalid AS valid, pg_get_userbyid(c.relowner) AS owner
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'widgets_x_idx'`
    );
    expect(index.rows).toEqual([{ valid: true, owner: 'postgres' }]);
    const table = await check.query<{ owner: string }>(
      "SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'widgets'"
    );
    expect(table.rows).toEqual([{ owner: 'postgres' }]);
    const rows = await check.query<{ n: string }>(
      'SELECT count(*) AS n FROM drizzle.__drizzle_migrations'
    );
    expect(rows.rows[0]?.n).toBe('2');
    await check.end();

    // A second run finds nothing pending.
    const again = await apply(applyBody(LOGIN, database, set));
    expect(again.status).toMatchObject({ failure: null, pending: [], applied: [] });
  });

  it('reports a failed statement with its sqlstate and the first pending tag without a row', async () => {
    const database = await newDatabase();
    const set = migrationSet([
      { tag: '0001_ok', sql: 'CREATE TABLE "ok" ("id" integer);' },
      {
        tag: '0002_dup',
        sql: 'CREATE TABLE "dup" ("id" integer);\n--> statement-breakpoint\nCREATE TABLE "dup" ("id" integer);',
      },
    ]);
    const { status, container } = await apply(applyBody(LOGIN, database, set));
    // One transaction: the failure rolls back 0001 too, so it is the first pending without a row.
    expect(status.failure).toEqual({
      code: 'migration_failed',
      reason: null,
      sqlstate: '42P07',
      migrationTag: '0001_ok',
      indexes: [],
    });
    expect(status.applied).toEqual([]);
    const logs = container.logs();
    expect(logs).toContain('"sqlstate":"42P07"');
    expect(logs).toContain('relation \\"dup\\" already exists');
    expect(logs).not.toContain('CREATE TABLE');
  });

  it('ends a labelled leftover with no recorded pair and counts it unexpected (R3-M1)', async () => {
    const database = await newDatabase();
    const leftover = await loginSession('kilo-migration-proxy:lost-run');
    const { pid } = (await leftover.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0] ?? { pid: 0 };
    const { status } = await apply(
      applyBody(LOGIN, database, migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]))
    );
    expect(status.failure).toBeNull();
    expect(status.cleanup).toEqual({ terminated: 1, unexpected: 1 });
    expect(await alive(pid)).toBe(false);
  });

  it('ends a labelled leftover with a recorded pair without counting it', async () => {
    const database = await newDatabase();
    const leftover = await loginSession('kilo-migration-proxy:lost-run');
    const pair = (await leftover.query<{ pid: number; backendStart: string }>(PAIR_SQL)).rows[0];
    if (pair === undefined) throw new Error('no pair');
    const { status } = await apply(
      applyBody(LOGIN, database, migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]), {
        recordedPairs: [pair],
      })
    );
    expect(status.cleanup).toEqual({ terminated: 1, unexpected: 0 });
    expect(await alive(pair.pid)).toBe(false);
  });

  it('leaves an unlabelled session of the login alone and counts it unexpected', async () => {
    const database = await newDatabase();
    const other = await loginSession('psql');
    const { pid } = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0] ?? { pid: 0 };
    const { status } = await apply(
      applyBody(LOGIN, database, migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]))
    );
    expect(status.failure).toBeNull();
    expect(status.cleanup).toEqual({ terminated: 0, unexpected: 1 });
    expect(await alive(pid)).toBe(true);
    await other.end();
  });

  it('fails leftover_not_ended when pg_terminate_backend(pid, 30000) times out', async () => {
    const database = await newDatabase();
    const stuck = await loginSession('kilo-migration-proxy:stuck');
    const { pid } = (await stuck.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0] ?? { pid: 0 };
    // A stopped backend cannot act on SIGTERM, so it outlives the 30 s wait.
    db.exec('kill', '-STOP', String(pid));
    try {
      const { status } = await apply(
        applyBody(LOGIN, database, migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]))
      );
      expect(status.failure).toMatchObject({ code: 'leftover_not_ended' });
      expect(status.applied).toEqual([]);
    } finally {
      db.exec('kill', '-CONT', String(pid));
    }
  }, 120_000);

  it('fails lock_busy while another session holds the run lock', async () => {
    const database = await newDatabase();
    const holder = await adminOn(database);
    await holder.query('SELECT pg_advisory_lock(7420310552)');
    const { status } = await apply(
      applyBody(LOGIN, database, migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]))
    );
    expect(status.failure).toMatchObject({ code: 'lock_busy' });
    await holder.end();
  });

  it('refuses the postgres login in member mode: wrong_role (the third production barrier)', async () => {
    const admin = await db.admin();
    await admin.query(`ALTER ROLE postgres PASSWORD '${PASSWORD}'`);
    await admin.end();
    const database = await newDatabase();
    const { status } = await apply(
      applyBody(
        { ...LOGIN, user: 'postgres' },
        database,
        migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }])
      )
    );
    expect(status.failure).toMatchObject({ code: 'probe_failed', reason: 'wrong_role' });
    expect(status.pair).toBeNull();
  });

  it('refuses a pending file outside the reviewed set: migration_not_reviewed', async () => {
    const database = await newDatabase();
    const set = migrationSet([
      { tag: '0001_a', sql: 'CREATE TABLE "a" ("id" integer);' },
      { tag: '0002_b', sql: 'CREATE TABLE "b" ("id" integer);' },
    ]);
    const { status } = await apply(
      applyBody(LOGIN, database, set, { reviewed: set.reviewed.slice(0, 1) })
    );
    expect(status.failure).toMatchObject({
      code: 'migration_not_reviewed',
      migrationTag: '0002_b',
    });
    expect(status.applied).toEqual([]);
  });

  it('refuses pending entries out of when order: journal_order_invalid', async () => {
    const database = await newDatabase();
    const set = migrationSet([
      { tag: '0001_a', sql: 'SELECT 1;', when: 1_900_000_010_000 },
      { tag: '0002_b', sql: 'SELECT 2;', when: 1_900_000_005_000 },
    ]);
    const { status } = await apply(applyBody(LOGIN, database, set));
    expect(status.failure).toMatchObject({ code: 'journal_order_invalid', migrationTag: '0002_b' });
  });

  it('survives a container killed mid-build: the next run ends the leftover and rebuilds the index', async () => {
    const database = await newDatabase();
    // Fixed `when` values: the second set must extend the journal the first run recorded.
    const base = [
      {
        tag: '0001_widgets',
        sql: 'CREATE TABLE "widgets" ("id" serial PRIMARY KEY, "x" integer);',
        when: 1_950_000_001_000,
      },
    ];
    const first = await apply(applyBody(LOGIN, database, migrationSet(base)));
    expect(first.status.failure).toBeNull();

    const blocker = await adminOn(database);
    await blocker.query('BEGIN');
    await blocker.query('INSERT INTO widgets (x) VALUES (1)');

    const set = migrationSet([
      ...base,
      {
        tag: '0002_widgets_x',
        sql: concurrentIndex('widgets', 'widgets_x_idx', 'x'),
        when: 1_950_000_002_000,
      },
    ]);
    const killed = await proxy();
    expect((await killed.call('POST', '/apply', applyBody(LOGIN, database, set))).status).toBe(202);
    const buildPid = await activePid('CREATE INDEX CONCURRENTLY', 'Lock');
    const pair = (await killed.call('GET', '/status')).body.pair;
    killed.kill();
    // A blocked CONCURRENTLY build does not notice its client is gone.
    expect(await alive(buildPid)).toBe(true);

    const next = await proxy();
    expect(
      (
        await next.call(
          'POST',
          '/apply',
          applyBody(LOGIN, database, set, { recordedPairs: pair === null ? [] : [pair] })
        )
      ).status
    ).toBe(202);
    await until(async () => !(await alive(buildPid)), 'the next run to end the leftover build');
    expect(await alive(buildPid)).toBe(false);
    await blocker.query('ROLLBACK');
    await blocker.end();
    const status = await waitDone(next);
    expect(status.failure).toBeNull();
    expect(status.cleanup).toEqual({ terminated: 1, unexpected: 0 });
    expect(status.applied.map(item => item.tag)).toEqual(['0002_widgets_x']);
    const admin = await adminOn(database);
    const index = await admin.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'widgets_x_idx'`
    );
    await admin.end();
    expect(index.rows).toEqual([{ valid: true }]);
  });

  it('refuses a stray invalid index no pending migration rebuilds: invalid_index_present', async () => {
    const database = await newDatabase();
    const admin = await adminOn(database);
    await admin.query('CREATE TABLE dupes (v integer)');
    await admin.query('INSERT INTO dupes VALUES (1), (1)');
    await admin.query('CREATE UNIQUE INDEX CONCURRENTLY stray_idx ON dupes (v)').catch(() => null);
    await admin.end();
    const { status } = await apply(
      applyBody(
        LOGIN,
        database,
        migrationSet([{ tag: '0001_a', sql: concurrentIndex('dupes', 'other_idx', 'v') }])
      )
    );
    expect(status.failure).toMatchObject({ code: 'invalid_index_present', indexes: ['stray_idx'] });
  });

  it('cancels the running statement on POST /cancel: 57014', async () => {
    const database = await newDatabase();
    const container = await proxy();
    const body = applyBody(
      LOGIN,
      database,
      migrationSet([{ tag: '0001_sleep', sql: 'SELECT pg_sleep(120);' }])
    );
    expect((await container.call('POST', '/apply', body)).status).toBe(202);
    await activePid('SELECT pg_sleep(120)');
    expect((await container.call('POST', '/cancel')).status).toBe(202);
    const status = await waitDone(container, 30_000);
    expect(status.failure).toMatchObject({ code: 'migration_failed', sqlstate: '57014' });
  });

  it('reports a session ended under a migration with a SQLSTATE, not as an unknown failure', async () => {
    const database = await newDatabase();
    const container = await proxy();
    const body = applyBody(
      LOGIN,
      database,
      migrationSet([{ tag: '0001_sleep', sql: 'SELECT pg_sleep(120);' }])
    );
    expect((await container.call('POST', '/apply', body)).status).toBe(202);
    const sleeper = await activePid('SELECT pg_sleep(120)');
    const admin = await db.admin();
    await admin.query('SELECT pg_terminate_backend($1)', [sleeper]);
    await admin.end();
    const status = await waitDone(container, 30_000);
    // Found by the local e2e: drizzle wrapped the driver's "Connection terminated" error, so the
    // failure carried no SQLSTATE and counted as permanent.
    expect(status.failure).toMatchObject({ code: 'migration_failed', migrationTag: '0001_sleep' });
    expect(['08006', '57P01']).toContain(status.failure?.sqlstate);
  });

  it('cancels and exits on SIGTERM', async () => {
    const database = await newDatabase();
    const container = await proxy();
    const body = applyBody(
      LOGIN,
      database,
      migrationSet([{ tag: '0001_sleep', sql: 'SELECT pg_sleep(120);' }])
    );
    expect((await container.call('POST', '/apply', body)).status).toBe(202);
    const sleeper = await activePid('SELECT pg_sleep(120)');
    const started = Date.now();
    container.stop();
    expect(Date.now() - started).toBeLessThan(14_000);
    expect(container.logs()).toContain('"event":"sigterm"');
    await until(async () => !(await alive(sleeper)), 'the cancelled session to go');
  });

  it('fails tls_verify_failed against a CA that did not sign the server', async () => {
    const database = await newDatabase();
    const { status } = await apply(
      applyBody(LOGIN, database, migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }])),
      await proxy(certificates().otherCa)
    );
    expect(status.failure).toMatchObject({ code: 'probe_failed', reason: 'tls_verify_failed' });
  });

  it('never logs or echoes the password, user or host (§2 secrecy)', async () => {
    const database = await newDatabase();
    const set = migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]);
    const sentinelHost = await apply(
      applyBody(LOGIN, database, set, { host: 'sentinel-host-7f3a.invalid' })
    );
    expect(sentinelHost.status.failure).toMatchObject({
      code: 'probe_failed',
      reason: 'connect_timeout',
    });
    const sentinelUser = await apply(
      applyBody(
        { ...LOGIN, user: 'sentinel_user_7f3a', password: 'sentinel-pw-7f3a-other' },
        database,
        set
      )
    );
    expect(sentinelUser.status.failure).toMatchObject({
      code: 'probe_failed',
      reason: 'auth_failed',
    });
    const real = await apply(applyBody(LOGIN, database, set));
    expect(real.status.failure).toBeNull();
    for (const container of [
      sentinelHost.container,
      sentinelUser.container,
      real.container,
      ...proxies,
    ]) {
      const text =
        container.logs() +
        JSON.stringify((await container.call('GET', '/status').catch(() => ({ body: null }))).body);
      expect(text).not.toContain('sentinel-pw-7f3a');
      expect(text).not.toContain('sentinel_user_7f3a');
      expect(text).not.toContain('sentinel-host-7f3a');
      expect(text).not.toContain('kilo_migration_proxy');
      expect(text).not.toContain('db.test');
    }
  });

  it('samples: a labelled session without a recorded pair is unexpected, with one leftover, and a reused pid is unexpected (R3-M1)', async () => {
    const container = await proxy();
    const sample = async (recordedPairs: { pid: number; backendStart: string }[]) =>
      (
        await container.call('POST', '/sample', {
          sampleId: crypto.randomUUID(),
          target: { host: 'db.test', port: 5432, database: 'postgres' },
          ...LOGIN,
          recordedPairs,
        })
      ).body;
    const labelled = await loginSession('kilo-migration-proxy:old');
    const pair = (await labelled.query<{ pid: number; backendStart: string }>(PAIR_SQL)).rows[0];
    if (pair === undefined) throw new Error('no pair');
    expect(await sample([])).toMatchObject({ result: 'ok', unexpected: 1, leftover: 0 });
    expect(await sample([pair])).toMatchObject({ result: 'ok', unexpected: 0, leftover: 1 });
    const reused = { pid: pair.pid, backendStart: '2026-01-01T00:00:00.000000Z' };
    expect(await sample([reused])).toMatchObject({ result: 'ok', unexpected: 1, leftover: 0 });
    await labelled.end();
    const unlabelled = await loginSession('');
    expect(await sample([])).toMatchObject({ result: 'ok', unexpected: 1, leftover: 0 });
    await unlabelled.end();
    const refused = (
      await container.call('POST', '/sample', {
        sampleId: crypto.randomUUID(),
        target: { host: 'db.test', port: 5432, database: 'postgres' },
        ...LOGIN,
        password: 'wrong-password',
        recordedPairs: [],
      })
    ).body;
    expect(refused).toMatchObject({ result: 'failed', reason: 'auth_failed' });
  });

  it('fails not_primary on a standby (last: it turns the server into one)', async () => {
    db.exec('touch', '/var/lib/postgresql/data/standby.signal');
    db.exec('chown', 'postgres', '/var/lib/postgresql/data/standby.signal');
    docker('restart', db.name);
    // The restart moves the published port, so ask from inside the container.
    await until(
      async () => {
        try {
          return db.psql(['-U', 'supabase_admin', '-Atc', 'SELECT pg_is_in_recovery()']) === 't';
        } catch {
          return false;
        }
      },
      'the standby',
      120_000
    );
    const { status } = await apply(
      applyBody(LOGIN, 'postgres', migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }]))
    );
    expect(status.failure).toMatchObject({ code: 'probe_failed', reason: 'not_primary' });
  }, 180_000);
});
