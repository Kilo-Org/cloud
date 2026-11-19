import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { persistLiveSessionColumns } from '../../src/dos/live-session-columns';
import { describeWorkerDbError } from '../../src/util/worker-db-error';

const LOCK_HOLD_LIMIT_MS = 8_000;

let connectionString: string;
let client: DrizzleClient;
let userId: string;
let sessionId: string;

beforeAll(async () => {
  connectionString = process.env.POSTGRES_URL ?? '';
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Live column lock tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  const suffix = crypto.randomUUID().replaceAll('-', '');
  userId = `oauth/live-columns-lock-${suffix}`;
  sessionId = `ses_live_columns_lock_${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id
    ) VALUES (
      ${userId},
      ${`live-columns-lock-${suffix}@example.test`},
      'Live Columns Lock Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`}
    )
  `);
  await client.db.insert(cli_sessions_v2).values({ session_id: sessionId, kilo_user_id: userId });
});

afterAll(async () => {
  if (!client) return;
  await client.db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  await client.pool.end();
});

function sessionRow() {
  return and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId));
}

describe('persistLiveSessionColumns against a locked row', () => {
  it(
    'gives up on the row lock after the short live-column bound',
    async () => {
      let releaseLock = () => {};
      const lockReleased = new Promise<void>(resolve => {
        releaseLock = resolve;
      });
      let reportLocked = () => {};
      const locked = new Promise<void>(resolve => {
        reportLocked = resolve;
      });
      const holder = client.db.transaction(async tx => {
        await tx
          .select({ id: cli_sessions_v2.session_id })
          .from(cli_sessions_v2)
          .where(sessionRow())
          .for('update');
        reportLocked();
        await lockReleased;
      });
      const holdLimit = setTimeout(releaseLock, LOCK_HOLD_LIMIT_MS);
      await locked;

      const startedAt = Date.now();
      const outcome = await persistLiveSessionColumns(connectionString, userId, sessionId, {
        lastActivityAtIso: '2026-11-18T22:10:00.000Z',
      }).then(
        () => ({ written: true }),
        (error: unknown) => ({ error })
      );
      const waitedMs = Date.now() - startedAt;
      clearTimeout(holdLimit);
      releaseLock();
      await holder;

      expect(
        'error' in outcome ? describeWorkerDbError(outcome.error).causes?.[0]?.code : outcome
      ).toBe('55P03');
      expect(waitedMs).toBeGreaterThanOrEqual(1_500);
      expect(waitedMs).toBeLessThan(5_000);
    },
    LOCK_HOLD_LIMIT_MS + 10_000
  );

  it('writes the columns when the row is free', async () => {
    await persistLiveSessionColumns(connectionString, userId, sessionId, {
      costMicrodollars: 1_234,
      lastActivityAtIso: '2026-11-18T22:11:00.000Z',
    });
    const [row] = await client.db
      .select({
        cost: cli_sessions_v2.total_cost_microdollars,
        lastActivityAt: cli_sessions_v2.last_activity_at,
      })
      .from(cli_sessions_v2)
      .where(sessionRow());
    expect(row.cost).toBe(1_234);
    expect(new Date(row.lastActivityAt ?? '').toISOString()).toBe('2026-11-18T22:11:00.000Z');
  });
});
