import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  setupLoginSql,
  startPostgres,
  startProxy,
  waitDone,
  type Postgres,
} from './docker';
import { PAIR_SQL, applyBody, concurrentIndex, migrationSet, type Login } from './fixtures';

/**
 * Direct mode (staging, contract §3) on Supabase's 17.6 image, where `postgres` cannot grant its
 * own role: the proxy logs in as `postgres` itself, in pid mode.
 */

const IMAGE = 'supabase/postgres:17.6.1.127';
const PASSWORD = 'sentinel-pw-direct-0123456789abcdef0123456789';
const LOGIN: Login = {
  user: 'postgres',
  password: PASSWORD,
  loginMode: 'direct',
  sessionKey: 'pid',
};

let db: Postgres;

async function apply(body: ReturnType<typeof applyBody>) {
  const container = await startProxy();
  expect((await container.call('POST', '/apply', body)).status).toBe(202);
  return await waitDone(container);
}

async function alive(pid: number): Promise<boolean> {
  const admin = await db.admin();
  const result = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
  await admin.end();
  return result.rows.length > 0;
}

beforeAll(async () => {
  db = await startPostgres(IMAGE, 'direct');
  const admin = await db.admin();
  await admin.query(`ALTER ROLE postgres PASSWORD '${PASSWORD}'`);
  await admin.query('CREATE DATABASE direct_1 OWNER postgres');
  await admin.end();
});

afterAll(() => {
  cleanup();
});

describe(`direct mode on ${IMAGE}`, () => {
  it('refuses the member create block, and postgres cannot grant itself (42501)', async () => {
    let refused = '';
    try {
      db.psql(
        ['-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'block=create', '-f', '-'],
        {
          MIGRATION_PROXY_DB_PASSWORD: PASSWORD,
        },
        setupLoginSql()
      );
    } catch (error) {
      refused = String((error as { stderr?: string }).stderr ?? error);
    }
    expect(refused).toContain('member mode needs PostgreSQL 15');
    // Without the block's version guard, the grant itself is what 17 refuses.
    const admin = await db.admin();
    await admin.query(
      "CREATE ROLE kilo_migration_proxy LOGIN NOINHERIT CONNECTION LIMIT 2 PASSWORD 'login-without-grant-0123456789abcdef0123'"
    );
    await admin.end();
    const owner = await db.session('postgres', PASSWORD, 'test');
    const grant = await owner.query('GRANT postgres TO kilo_migration_proxy').then(
      () => null,
      (error: { code?: string }) => error.code
    );
    await owner.end();
    expect(grant).toBe('42501');
  });

  it('fails the member probe for a login without the grant: wrong_role', async () => {
    const status = await apply(
      applyBody(
        {
          user: 'kilo_migration_proxy',
          password: 'login-without-grant-0123456789abcdef0123',
          loginMode: 'member',
          sessionKey: 'label',
        },
        'direct_1',
        migrationSet([{ tag: '0001_a', sql: 'SELECT 1;' }])
      )
    );
    expect(status.failure).toMatchObject({ code: 'probe_failed', reason: 'wrong_role' });
  });

  it('applies as postgres, ending only recorded pairs; a labelled foreign postgres session survives', async () => {
    const recorded = await db.session('postgres', PASSWORD, 'kilo-migration-proxy:lost-run');
    const pair = (await recorded.query<{ pid: number; backendStart: string }>(PAIR_SQL)).rows[0];
    const foreign = await db.session('postgres', PASSWORD, 'kilo-migration-proxy:not-ours');
    const foreignPid =
      (await foreign.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
    if (pair === undefined) throw new Error('no pair');
    const set = migrationSet([
      {
        tag: '0001_widgets',
        sql: 'CREATE TABLE "widgets" ("id" serial PRIMARY KEY, "x" integer);',
      },
      { tag: '0002_widgets_x', sql: concurrentIndex('widgets', 'widgets_x_idx', 'x') },
    ]);
    const status = await apply(applyBody(LOGIN, 'direct_1', set, { recordedPairs: [pair] }));
    expect(status.failure).toBeNull();
    expect(status.applied.map(item => item.tag)).toEqual(['0001_widgets', '0002_widgets_x']);
    expect(status.cleanup?.terminated).toBe(1);
    // Every other postgres session (the foreign one and this suite's) counts, and none is ended.
    expect(status.cleanup?.unexpected).toBeGreaterThanOrEqual(1);
    expect(await alive(pair.pid)).toBe(false);
    expect(await alive(foreignPid)).toBe(true);
    await foreign.end();
  });
});
