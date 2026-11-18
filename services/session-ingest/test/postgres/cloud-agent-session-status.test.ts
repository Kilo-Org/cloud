import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb } from '@kilocode/db/client';
import type * as DbClient from '@kilocode/db/client';
import type * as SessionEvents from '../../src/session-events';
import { sql } from 'drizzle-orm';
import { applyMetadataChanges } from '../../src/ingest/metadata';
import { notifyUserSessionEvent } from '../../src/session-events';

vi.mock('@kilocode/db/client', async importOriginal => ({
  ...(await importOriginal<typeof DbClient>()),
  getWorkerDb: vi.fn(),
}));
vi.mock('../../src/dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../../src/session-events', async importOriginal => ({
  ...(await importOriginal<typeof SessionEvents>()),
  notifyUserSessionEvent: vi.fn(),
}));
vi.mock('../../src/remote-session-notifications', () => ({ refreshGlanceableSessions: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const userId = 'oauth/cloud-agent-status-test';
const runtimeId = 'workspace_11111111-1111-4111-8111-111111111111';
const env = { HYPERDRIVE: { connectionString: 'unused' } } as never;
let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (
    !connectionString ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)
  )
    throw new Error('Status tests require a local POSTGRES_URL');
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      title text,
      status text,
      status_updated_at timestamptz,
      status_transition_id text,
      parent_session_id text,
      cloud_agent_session_id text,
      cloud_agent_session_scope_id text,
      cloud_agent_worktree_id text,
      git_url text,
      git_branch text,
      pr_url text,
      organization_id uuid,
      created_on_platform text NOT NULL DEFAULT 'cloud-agent-web',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  vi.mocked(notifyUserSessionEvent).mockClear();
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (session_id, kilo_user_id, cloud_agent_session_id)
    VALUES ('session', ${userId}, ${runtimeId})
  `);
});

function publish(
  status: string,
  transitionId: string,
  options: { userId?: string; runtimeId?: string; occurredAt?: string } = {}
) {
  return applyMetadataChanges(
    env,
    options.userId ?? userId,
    'session',
    new Map([
      ['status', status],
      ['statusOccurredAt', options.occurredAt ?? '2026-11-09T12:00:00.000Z'],
      ['statusTransitionId', transitionId],
    ]),
    undefined,
    options.runtimeId ?? runtimeId
  );
}

async function storedStatus() {
  const { rows } = await client.db.execute<{ status: string; status_transition_id: string }>(sql`
    SELECT status, status_transition_id FROM pg_temp.cli_sessions_v2 WHERE session_id = 'session'
  `);
  return rows[0];
}

describe('Cloud Agent status projection in PostgreSQL', () => {
  it('updates one row and emits one user event when the catalog contains 100 sessions', async () => {
    await client.db.execute(sql`
      INSERT INTO pg_temp.cli_sessions_v2 (session_id, kilo_user_id, cloud_agent_session_id)
      SELECT 'other-' || n, ${userId}, 'workspace_other-' || n FROM generate_series(1, 99) n
    `);
    await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const { rows } = await client.db.execute<{ total: number; busy: number }>(sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'busy')::int AS busy
      FROM pg_temp.cli_sessions_v2
    `);
    expect(rows).toEqual([{ total: 100, busy: 1 }]);
    expect(notifyUserSessionEvent).toHaveBeenCalledTimes(1);
  });

  it('does not let a delayed busy update overwrite idle, including equal timestamps and duplicates', async () => {
    await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await publish('idle', '01ARZ3NDEKTSV4RRFFQ69G5FAW');
    vi.mocked(notifyUserSessionEvent).mockClear();
    await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await publish('idle', '01ARZ3NDEKTSV4RRFFQ69G5FAW');
    expect(await storedStatus()).toEqual({
      status: 'idle',
      status_transition_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    });
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  it('orders concurrent publications by the durable producer cursor', async () => {
    await Promise.all([
      publish('idle', '01ARZ3NDEKTSV4RRFFQ69G5FAW'),
      publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    ]);
    expect((await storedStatus())?.status).toBe('idle');
  });

  it('refreshes SQL recency without broadcasting another event for unchanged active status', async () => {
    await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    vi.mocked(notifyUserSessionEvent).mockClear();
    await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAW', { occurredAt: '2026-11-09T12:01:00.000Z' });
    expect(await storedStatus()).toEqual({
      status: 'busy',
      status_transition_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    });
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  it('uses existing user notifications and normalizes PostgreSQL timestamps to ISO', async () => {
    await publish('question', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      userId,
      expect.objectContaining({
        type: 'session.status.updated',
        data: expect.objectContaining({
          source: 'v2',
          status: 'question',
          statusUpdatedAt: '2026-11-09T12:00:00.000Z',
        }),
      }),
      undefined
    );
  });

  it.each([{ userId: 'oauth/another-user' }, { runtimeId: 'workspace_other' }])(
    'rejects a mismatched owner %j',
    async options => {
      await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV', options);
      expect((await storedStatus())?.status).toBeNull();
      expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    }
  );

  it('cannot recreate a deleted session', async () => {
    await client.db.execute(sql`DELETE FROM pg_temp.cli_sessions_v2 WHERE session_id = 'session'`);
    await publish('busy', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(await storedStatus()).toBeUndefined();
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });
});
