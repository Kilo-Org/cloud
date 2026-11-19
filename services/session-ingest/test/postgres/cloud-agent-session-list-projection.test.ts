import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb, type DrizzleClient } from '@kilocode/db/client';
import type * as DbClient from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type { PublishCloudAgentSessionStatusParams } from '@kilocode/session-ingest-contracts';
import { sql } from 'drizzle-orm';
import type * as SessionEvents from '../../src/session-events';
import { notifyUserSessionEvent } from '../../src/session-events';
import { SessionIngestRPC } from '../../src/session-ingest-rpc';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {
    ctx: ExecutionContext;
    env: unknown;
    constructor(ctx: ExecutionContext, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock('@kilocode/db/client', async importOriginal => ({
  ...(await importOriginal<typeof DbClient>()),
  getWorkerDb: vi.fn(),
}));
vi.mock('../../src/dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
  CLONE_ITEM_TYPES: ['session', 'message', 'part', 'session_diff'],
}));
vi.mock('../../src/dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
// The real UserConnectionDO imports the metadata module while the session-events
// mock below loads its original, which would bind metadata to the real notifier.
vi.mock('../../src/dos/UserConnectionDO', () => ({ getUserConnectionDO: vi.fn() }));
vi.mock('../../src/session-events', async importOriginal => ({
  ...(await importOriginal<typeof SessionEvents>()),
  notifyUserSessionEvent: vi.fn(),
}));
vi.mock('../../src/remote-session-notifications', () => ({ refreshGlanceableSessions: vi.fn() }));

const userId = 'oauth/cloud-agent-list-projection-test';
const sessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const env = { HYPERDRIVE: { connectionString: 'unused' } };
const firstTransitionId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const laterTransitionId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('List projection tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  // A session-local copy of the table tests the real queries without changing shared data.
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (LIKE public.cli_sessions_v2 INCLUDING DEFAULTS)
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  vi.mocked(notifyUserSessionEvent).mockClear();
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
  await client.db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    kilo_user_id: userId,
    cloud_agent_session_id: cloudAgentSessionId,
    created_on_platform: 'cloud-agent-web',
    title: 'Generated from the first prompt',
  });
});

function publish(update: Partial<PublishCloudAgentSessionStatusParams>) {
  return new SessionIngestRPC(ctx, env as never).publishCloudAgentSessionStatus({
    sessionId,
    kiloUserId: userId,
    cloudAgentSessionId,
    status: 'busy',
    occurredAt: '2026-01-01T00:00:00.000Z',
    transitionId: firstTransitionId,
    ...update,
  });
}

async function storedRow() {
  const [row] = await client.db
    .select({
      status: cli_sessions_v2.status,
      title: cli_sessions_v2.title,
      last_activity_at: cli_sessions_v2.last_activity_at,
    })
    .from(cli_sessions_v2);
  return {
    ...row,
    last_activity_at: row?.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
  };
}

describe('Cloud Agent list projection from the Session DO', () => {
  it('records transcript activity and never moves it back', async () => {
    await publish({ lastActivityAt: '2026-01-01T00:05:00.000Z' });
    await publish({
      status: 'idle',
      occurredAt: '2026-01-01T00:06:00.000Z',
      transitionId: laterTransitionId,
      lastActivityAt: '2026-01-01T00:04:00.000Z',
    });
    expect(await storedRow()).toMatchObject({
      status: 'idle',
      last_activity_at: '2026-01-01T00:05:00.000Z',
    });
  });

  it('clamps a future-dated activity report to the database clock', async () => {
    await publish({ lastActivityAt: '2999-01-01T00:00:00.000Z' });
    const row = await storedRow();
    const { rows } = await client.db.execute<{ now: Date }>(sql`SELECT now() AS now`);
    const dbNowMs = new Date(rows[0]?.now ?? 0).getTime();
    expect(row.last_activity_at).not.toBeNull();
    expect(Date.parse(row.last_activity_at ?? '')).toBeLessThanOrEqual(dbNowMs);
  });

  it('applies a native rename over a generated title and announces it', async () => {
    await publish({ rename: { title: 'Renamed by the agent', transitionId: firstTransitionId } });
    expect((await storedRow()).title).toBe('Renamed by the agent');
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      userId,
      expect.objectContaining({
        type: 'session.updated',
        data: expect.objectContaining({
          session: expect.objectContaining({ title: 'Renamed by the agent' }),
        }),
      }),
      ctx
    );
  });

  it('keeps a newer native rename when an older publication lands late', async () => {
    await publish({
      status: 'idle',
      occurredAt: '2026-01-01T00:06:00.000Z',
      transitionId: laterTransitionId,
      rename: { title: 'Newer rename', transitionId: laterTransitionId },
    });
    await publish({ rename: { title: 'Older rename', transitionId: firstTransitionId } });
    expect(await storedRow()).toMatchObject({ status: 'idle', title: 'Newer rename' });
  });

  it('applies a native rename on a publication newer than the stored status', async () => {
    await publish({ transitionId: firstTransitionId });
    expect((await storedRow()).title).toBe('Generated from the first prompt');
    await publish({
      status: 'idle',
      occurredAt: '2026-01-01T00:06:00.000Z',
      transitionId: laterTransitionId,
      rename: { title: 'Renamed by the agent', transitionId: laterTransitionId },
    });
    expect(await storedRow()).toMatchObject({ status: 'idle', title: 'Renamed by the agent' });
  });

  it('keeps a user rename when a newer publication repeats an applied native rename', async () => {
    const rename = { title: 'Renamed by the agent', transitionId: firstTransitionId };
    await publish({ rename });
    expect((await storedRow()).title).toBe('Renamed by the agent');
    await client.db.update(cli_sessions_v2).set({ title: 'Renamed by the user' });
    await publish({
      status: 'idle',
      occurredAt: '2026-01-01T00:06:00.000Z',
      transitionId: laterTransitionId,
      rename,
    });
    expect(await storedRow()).toMatchObject({ status: 'idle', title: 'Renamed by the user' });
  });

  it('leaves the row of another Cloud Agent session alone', async () => {
    await publish({
      cloudAgentSessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      lastActivityAt: '2026-01-01T00:05:00.000Z',
      rename: { title: 'Renamed by the agent', transitionId: firstTransitionId },
    });
    expect(await storedRow()).toEqual({
      status: null,
      title: 'Generated from the first prompt',
      last_activity_at: null,
    });
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });
});
