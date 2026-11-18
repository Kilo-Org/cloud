import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, getWorkerDb, type DrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { canCreateCliSessionForUser } from '../../src/services/user-session-admission';

const LOCK_HOLD_LIMIT_MS = 15_000;

let connectionString: string;
let client: DrizzleClient;
let userId: string;

beforeAll(async () => {
  connectionString = process.env.POSTGRES_URL ?? '';
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Worker transaction bound tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  const suffix = crypto.randomUUID().replaceAll('-', '');
  userId = `oauth/worker-db-bounds-${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id
    ) VALUES (
      ${userId},
      ${`worker-db-bounds-${suffix}@example.test`},
      'Worker DB Bounds Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`}
    )
  `);
});

afterAll(async () => {
  if (!client) return;
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  await client.pool.end();
});

function sqlState(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
}

describe('Worker DB transaction bounds', () => {
  it('applies the lock and idle bounds inside a Worker transaction', async () => {
    const db = getWorkerDb(connectionString);

    const settings = await db.transaction(async tx => {
      const result = await tx.execute<{ lock_timeout: string; idle_timeout: string }>(sql`
        SELECT current_setting('lock_timeout') AS lock_timeout,
               current_setting('idle_in_transaction_session_timeout') AS idle_timeout
      `);
      return result.rows[0];
    });

    expect(settings).toEqual({ lock_timeout: '10s', idle_timeout: '30s' });
  });

  it(
    'ends the session admission row-lock wait at the lock bound',
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
          .select({ id: kilocode_users.id })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, userId))
          .for('update');
        reportLocked();
        await lockReleased;
      });
      const holdLimit = setTimeout(releaseLock, LOCK_HOLD_LIMIT_MS);
      await locked;

      const startedAt = Date.now();
      const admission = await getWorkerDb(connectionString)
        .transaction(tx => canCreateCliSessionForUser(tx, userId))
        .then(
          admitted => ({ admitted }),
          (error: unknown) => ({ error })
        );
      const waitedMs = Date.now() - startedAt;
      clearTimeout(holdLimit);
      releaseLock();
      await holder;

      expect('error' in admission ? sqlState(admission.error) : admission).toBe('55P03');
      expect(waitedMs).toBeGreaterThanOrEqual(9_000);
      expect(waitedMs).toBeLessThan(LOCK_HOLD_LIMIT_MS);
    },
    LOCK_HOLD_LIMIT_MS + 10_000
  );
});
