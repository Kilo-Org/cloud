import { afterEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { webhook_event_signatures } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import {
  dropExpiredWebhookEventPartitions,
  isTransientPartitionError,
  PARTITION_DAYS_AHEAD,
  provisionWebhookEventPartitions,
  pruneExpiredWebhookEventSignatures,
  webhookEventPartitionDay,
  webhookEventPartitionName,
} from './webhook-event-partitions';

// Partitions are shared by every test in this worker's database, so these tests
// only create days in 2020. Those are expired relative to the real clock, which
// lets the real-clock drop pass remove them without touching the current days
// other suites insert into.
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysFrom(start: Date, count: number): string[] {
  return Array.from({ length: count }, (_, offset) =>
    webhookEventPartitionName(new Date(start.getTime() + offset * DAY_MS))
  );
}

async function partitionStates(): Promise<Map<string, string>> {
  const { rows } = await db.execute<{ name: string; detach_pending: boolean }>(sql`
    SELECT c.relname AS name, i.inhdetachpending AS detach_pending
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.webhook_events_v2'::regclass
  `);
  return new Map(rows.map(row => [row.name, row.detach_pending ? 'pending' : 'attached']));
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS exists`
  );
  return rows[0]?.exists ?? false;
}

async function dropTestPartitions(): Promise<void> {
  await dropExpiredWebhookEventPartitions(db);
}

describe('webhook event partition names', () => {
  test('names a partition after the UTC day it holds and parses it back', () => {
    const day = new Date('2020-02-29T00:00:00.000Z');
    expect(webhookEventPartitionName(day)).toBe('webhook_events_v2_2020_02_29');
    expect(webhookEventPartitionDay('webhook_events_v2_2020_02_29')).toEqual(day);
  });

  test('rejects names it did not create and impossible dates', () => {
    expect(webhookEventPartitionDay('webhook_events_v2_2021_02_29')).toBeNull();
    expect(webhookEventPartitionDay('webhook_events_2020_02_01')).toBeNull();
    expect(webhookEventPartitionDay('webhook_events_v2_2020_02_01_old')).toBeNull();
  });
});

describe('provisionWebhookEventPartitions', () => {
  afterEach(dropTestPartitions);

  test('creates today and the days ahead with UTC bounds and per-partition fillfactor', async () => {
    const now = new Date('2020-06-01T22:30:00.000Z');

    const result = await provisionWebhookEventPartitions(db, now);

    const expected = daysFrom(new Date('2020-06-01T00:00:00.000Z'), PARTITION_DAYS_AHEAD + 1);
    expect(result).toEqual({ created: expected, errors: [], missingSoon: [] });
    // pg_get_expr renders bounds in the session time zone, so read them as UTC.
    const partition = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
      const { rows } = await tx.execute<{ bound: string; reloptions: string[] | null }>(sql`
        SELECT pg_get_expr(c.relpartbound, c.oid) AS bound, c.reloptions
        FROM pg_class c WHERE c.oid = 'public.webhook_events_v2_2020_06_01'::regclass
      `);
      return rows[0];
    });
    expect(partition).toEqual({
      bound: "FOR VALUES FROM ('2020-06-01 00:00:00+00') TO ('2020-06-02 00:00:00+00')",
      reloptions: ['fillfactor=90'],
    });
  });

  test('creates nothing when the window already exists', async () => {
    const now = new Date('2020-06-01T10:00:00.000Z');
    await provisionWebhookEventPartitions(db, now);

    await expect(provisionWebhookEventPartitions(db, now)).resolves.toEqual({
      created: [],
      errors: [],
      missingSoon: [],
    });
  });

  test('lets concurrent runs create the same window without reporting errors', async () => {
    const now = new Date('2020-09-01T10:00:00.000Z');

    const results = await Promise.all(
      Array.from({ length: 3 }, () => provisionWebhookEventPartitions(db, now))
    );

    expect(results.flatMap(result => result.errors)).toEqual([]);
    expect(results.flatMap(result => result.created).sort()).toEqual(
      daysFrom(new Date('2020-09-01T00:00:00.000Z'), PARTITION_DAYS_AHEAD + 1)
    );
  });

  test('reports today or tomorrow as missing when it cannot be created', async () => {
    const now = new Date('2020-10-01T10:00:00.000Z');
    await db.execute(sql`CREATE TABLE public.webhook_events_v2_2020_10_02 (id int)`);
    try {
      const result = await provisionWebhookEventPartitions(db, now);

      expect(result.missingSoon).toEqual(['webhook_events_v2_2020_10_02']);
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS public.webhook_events_v2_2020_10_02`);
    }
  });

  test('reports a day whose name is taken by a table that is not a partition', async () => {
    const now = new Date('2020-07-01T10:00:00.000Z');
    await db.execute(sql`CREATE TABLE public.webhook_events_v2_2020_07_03 (id int)`);
    try {
      const result = await provisionWebhookEventPartitions(db, now);

      expect(result.errors.map(error => error.name)).toEqual(['webhook_events_v2_2020_07_03']);
      expect(result.created).toHaveLength(PARTITION_DAYS_AHEAD);
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS public.webhook_events_v2_2020_07_03`);
    }
  });
});

describe('dropExpiredWebhookEventPartitions', () => {
  afterEach(dropTestPartitions);

  test('drops whole days past retention with their rows and keeps the current window', async () => {
    const old = new Date('2020-03-01T10:00:00.000Z');
    await provisionWebhookEventPartitions(db, old);
    await db.execute(sql`
      INSERT INTO webhook_events_v2
        (owned_by_user_id, platform, event_type, payload, headers, event_signature, created_at)
      VALUES ('expired-user', 'github', 'push', '{}', '{}', 'expired', '2020-03-02T12:00:00.000Z')
    `);
    const currentBefore = [...(await partitionStates()).keys()].filter(
      name => !name.includes('_2020_')
    );

    const result = await dropExpiredWebhookEventPartitions(db);

    const expired = daysFrom(new Date('2020-03-01T00:00:00.000Z'), PARTITION_DAYS_AHEAD + 1);
    expect(result.errors).toEqual([]);
    expect(result.dropped.sort()).toEqual(expired);
    const remaining = [...(await partitionStates()).keys()];
    expect(remaining.filter(name => name.includes('_2020_'))).toEqual([]);
    expect(remaining.sort()).toEqual(currentBefore.sort());
    const { rows } = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM webhook_events_v2 WHERE event_signature = 'expired'`
    );
    expect(rows[0]?.count).toBe(0);
  });

  test('keeps a day until all of it is past the retention window', async () => {
    await provisionWebhookEventPartitions(db, new Date('2020-04-01T10:00:00.000Z'));
    // The 2020-04-01 partition ends at 2020-04-02 00:00, which falls out of the
    // 60-day window at 2020-06-01 00:00 and not a second earlier.
    const oneSecondEarly = await dropExpiredWebhookEventPartitions(
      db,
      new Date('2020-05-31T23:59:59.000Z')
    );
    expect(oneSecondEarly.dropped).toEqual([]);

    const atBoundary = await dropExpiredWebhookEventPartitions(
      db,
      new Date('2020-06-01T00:00:00.000Z')
    );
    expect(atBoundary.dropped).toEqual(['webhook_events_v2_2020_04_01']);
  });

  test('finalizes a concurrent detach that was cancelled partway, then drops it', async () => {
    await provisionWebhookEventPartitions(db, new Date('2020-05-01T10:00:00.000Z'));
    const target = 'webhook_events_v2_2020_05_01';
    const reader = await db.$client.connect();
    const detacher = await db.$client.connect();
    try {
      // An open reader of the parent makes the concurrent detach wait, and the
      // lock timeout cancels it after its first transaction committed.
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM webhook_events_v2');
      await detacher.query(`SET lock_timeout = '200ms'`);
      await expect(
        detacher.query(`ALTER TABLE webhook_events_v2 DETACH PARTITION ${target} CONCURRENTLY`)
      ).rejects.toThrow(/lock timeout/);
      await reader.query('COMMIT');
      expect((await partitionStates()).get(target)).toBe('pending');
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      reader.release();
      await detacher.query('RESET lock_timeout');
      detacher.release();
    }

    const result = await dropExpiredWebhookEventPartitions(db);

    // The pending detach is finished first; while it was pending PostgreSQL would
    // have refused every other concurrent detach, so the rest go in the same run.
    expect(result.errors).toEqual([]);
    expect(result.finalized).toEqual([target]);
    expect(result.dropped[0]).toBe(target);
    expect(result.dropped.sort()).toEqual(
      daysFrom(new Date('2020-05-01T00:00:00.000Z'), PARTITION_DAYS_AHEAD + 1)
    );
    await expect(tableExists(target)).resolves.toBe(false);
  });

  test('drops an expired partition that an earlier run detached but did not drop', async () => {
    await provisionWebhookEventPartitions(db, new Date('2020-08-01T10:00:00.000Z'));
    const target = 'webhook_events_v2_2020_08_01';
    await db.execute(sql.raw(`ALTER TABLE webhook_events_v2 DETACH PARTITION ${target}`));

    const result = await dropExpiredWebhookEventPartitions(db);

    expect(result.dropped).toContain(target);
    await expect(tableExists(target)).resolves.toBe(false);
  });
});

describe('isTransientPartitionError', () => {
  test('treats timeouts and a pending detach as transient, including when wrapped', () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    expect(isTransientPartitionError(lockTimeout)).toBe(true);
    expect(isTransientPartitionError(new Error('Failed query', { cause: lockTimeout }))).toBe(true);
    expect(isTransientPartitionError(Object.assign(new Error('cancel'), { code: '57014' }))).toBe(
      true
    );
    expect(
      isTransientPartitionError(Object.assign(new Error('already pending'), { code: '55000' }))
    ).toBe(true);
  });

  test('treats anything else as needing an operator', () => {
    expect(isTransientPartitionError(new Error('exists but is not an attached partition'))).toBe(
      false
    );
    expect(isTransientPartitionError(Object.assign(new Error('denied'), { code: '42501' }))).toBe(
      false
    );
  });
});

describe('pruneExpiredWebhookEventSignatures', () => {
  afterEach(cleanupDbForTest);

  test('deletes signatures older than the retention window and keeps recent ones', async () => {
    const now = new Date('2026-11-19T10:00:00.000Z');
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
    await db.insert(webhook_event_signatures).values(
      [61, 59].map(daysAgo => ({
        event_signature: `signature-${daysAgo}`,
        webhook_event_id: crypto.randomUUID(),
        webhook_event_created_at: at(daysAgo),
        created_at: at(daysAgo),
      }))
    );

    const result = await pruneExpiredWebhookEventSignatures(db, now);

    expect(result).toEqual({ deletedCount: 1, hasMore: false });
    const remaining = await db
      .select({ signature: webhook_event_signatures.event_signature })
      .from(webhook_event_signatures);
    expect(remaining).toEqual([{ signature: 'signature-59' }]);
  });
});
