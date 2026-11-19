import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb, type DrizzleClient } from '@kilocode/db/client';
import type * as DbClient from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type {
  PublishCloudAgentSessionStatusParams,
  SessionLiveSummary,
} from '@kilocode/session-ingest-contracts';
import { sql } from 'drizzle-orm';
import type * as SessionEvents from '../../src/session-events';
import { notifyUserSessionEvent } from '../../src/session-events';
import { SessionIngestRPC } from '../../src/session-ingest-rpc';
import { refreshGlanceableSessions } from '../../src/remote-session-notifications';

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
  vi.mocked(refreshGlanceableSessions).mockClear();
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
      live_summary: cli_sessions_v2.live_summary,
      total_cost_microdollars: cli_sessions_v2.total_cost_microdollars,
    })
    .from(cli_sessions_v2);
  return {
    ...row,
    last_activity_at: row?.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
  };
}

function summary(
  target: string,
  failure: SessionLiveSummary['failure'] = null
): SessionLiveSummary {
  return {
    step: { verb: 'editing', target },
    plan: { done: 1, total: 3, current: 'Write the tests' },
    changes: null,
    failure,
  };
}

/** Postgres row version and `updated_at`, to see whether a publication wrote the row at all. */
async function rowVersion() {
  const { rows } = await client.db.execute<{ updated_at: string; xmin: string }>(
    sql`SELECT updated_at::text AS updated_at, xmin::text AS xmin FROM pg_temp.cli_sessions_v2`
  );
  return { updated_at: rows[0]?.updated_at, xmin: rows[0]?.xmin };
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

  it('writes nothing when a report repeats an activity the row already holds', async () => {
    const lastActivityAt = '2026-01-01T00:05:00.000Z';
    await publish({ lastActivityAt });
    const before = await rowVersion();
    // The same snapshot retried: the status transition is already stored, so the activity write
    // is the only one that could touch the row.
    await publish({ lastActivityAt });
    expect(await rowVersion()).toEqual(before);
    expect((await storedRow()).last_activity_at).toBe(lastActivityAt);
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
      liveSummary: summary('index.ts'),
      totalCostMicrodollars: 1_500,
    });
    expect(await storedRow()).toEqual({
      status: null,
      title: 'Generated from the first prompt',
      last_activity_at: null,
      live_summary: null,
      total_cost_microdollars: null,
    });
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    expect(refreshGlanceableSessions).not.toHaveBeenCalled();
  });

  it('records the Kilo v2 session card summary and cost total', async () => {
    await publish({ liveSummary: summary('index.ts'), totalCostMicrodollars: 1_500 });
    expect(await storedRow()).toMatchObject({
      status: 'busy',
      live_summary: summary('index.ts'),
      total_cost_microdollars: 1_500,
    });
  });

  it('keeps the newer summary and the higher cost when an older publication lands late', async () => {
    await publish({
      status: 'idle',
      occurredAt: '2026-01-01T00:06:00.000Z',
      transitionId: laterTransitionId,
      liveSummary: summary('newer.ts', { kind: 'provider' }),
      totalCostMicrodollars: 3_000,
    });
    await publish({ liveSummary: summary('older.ts'), totalCostMicrodollars: 1_500 });
    expect(await storedRow()).toMatchObject({
      status: 'idle',
      live_summary: summary('newer.ts', { kind: 'provider' }),
      total_cost_microdollars: 3_000,
    });
  });

  it('raises the cost from a publication whose status is stale', async () => {
    await publish({
      status: 'idle',
      occurredAt: '2026-01-01T00:06:00.000Z',
      transitionId: laterTransitionId,
      totalCostMicrodollars: 1_500,
    });
    // Cost only grows, so a higher total stands whichever publication carried it.
    await publish({ totalCostMicrodollars: 3_000 });
    expect(await storedRow()).toMatchObject({ status: 'idle', total_cost_microdollars: 3_000 });
  });

  it('refreshes a followed session card when the summary changes under an unchanged status', async () => {
    await publish({ liveSummary: summary('first.ts') });
    // The status change refreshes every card of the session itself.
    expect(refreshGlanceableSessions).toHaveBeenCalledTimes(1);
    expect(refreshGlanceableSessions).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cardFollowSessionIds: [sessionId] })
    );
    await publish({
      occurredAt: '2026-01-01T00:01:00.000Z',
      transitionId: laterTransitionId,
      liveSummary: summary('second.ts'),
    });
    expect((await storedRow()).live_summary).toEqual(summary('second.ts'));
    expect(refreshGlanceableSessions).toHaveBeenCalledTimes(2);
    expect(refreshGlanceableSessions).toHaveBeenLastCalledWith(env, {
      userId,
      cliSessionIds: [sessionId],
      cardFollowSessionIds: [sessionId],
    });
  });

  it('neither rewrites nor announces an unchanged summary', async () => {
    await publish({ liveSummary: summary('index.ts') });
    vi.mocked(refreshGlanceableSessions).mockClear();
    await publish({
      occurredAt: '2026-01-01T00:01:00.000Z',
      transitionId: laterTransitionId,
      liveSummary: summary('index.ts'),
    });
    expect((await storedRow()).live_summary).toEqual(summary('index.ts'));
    expect(refreshGlanceableSessions).not.toHaveBeenCalled();
  });

  it('writes nothing when a report repeats a cost the row already holds', async () => {
    await publish({ totalCostMicrodollars: 1_500 });
    const before = await rowVersion();
    // The same snapshot retried: the status transition is already stored, so the cost write is
    // the only one that could touch the row.
    await publish({ totalCostMicrodollars: 1_500 });
    expect(await rowVersion()).toEqual(before);
    expect((await storedRow()).total_cost_microdollars).toBe(1_500);
  });
});
