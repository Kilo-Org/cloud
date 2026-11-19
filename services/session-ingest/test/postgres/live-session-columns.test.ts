import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb, type DrizzleClient } from '@kilocode/db/client';
import type * as DbClient from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type { SessionLiveSummary } from '@kilocode/session-ingest-contracts';
import { sql } from 'drizzle-orm';
import { persistLiveSessionColumns } from '../../src/dos/SessionIngestDO';

vi.mock('cloudflare:workers', () => ({ DurableObject: class DurableObject {} }));
vi.mock('@kilocode/db/client', async importOriginal => ({
  ...(await importOriginal<typeof DbClient>()),
  getWorkerDb: vi.fn(),
}));
vi.mock('../../src/remote-session-notifications', () => ({ refreshGlanceableSessions: vi.fn() }));

const userId = 'oauth/live-session-columns-test';
const sessionId = 'ses_12345678901234567890123456';
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Live session column tests require a local PostgreSQL database');
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
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
  await client.db.insert(cli_sessions_v2).values({ session_id: sessionId, kilo_user_id: userId });
});

function summary(target: string): SessionLiveSummary {
  return { step: { verb: 'editing', target }, plan: null, changes: null, failure: null };
}

function persistBatch(activityMs: number, target: string) {
  const atIso = new Date(activityMs).toISOString();
  return persistLiveSessionColumns('unused', userId, sessionId, {
    lastActivityAtIso: atIso,
    liveSummary: { summary: summary(target), atIso },
  });
}

describe('CLI live session columns', () => {
  it('keeps the newer summary when an older batch lands after one dated ahead of the database', async () => {
    const aheadMs = Date.now() + 60 * 60_000;
    await persistBatch(aheadMs, 'newer.ts');
    await persistBatch(aheadMs - 1000, 'older.ts');
    const [row] = await client.db
      .select({
        last_activity_at: cli_sessions_v2.last_activity_at,
        live_summary: cli_sessions_v2.live_summary,
      })
      .from(cli_sessions_v2);
    expect(row?.live_summary).toEqual(summary('newer.ts'));
    expect(new Date(row?.last_activity_at ?? 0).getTime()).toBe(aheadMs);
  });
});
