import { afterEach, describe, expect, it } from '@jest/globals';
import { eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { spend_alert_hourly } from '@kilocode/db/schema';
import {
  pruneSpendAlertHourly,
  SPEND_ALERT_HOURLY_PRUNE_BATCH_SIZE,
  SPEND_ALERT_HOURLY_RETENTION_DAYS,
} from './retention';

const HOUR_MS = 60 * 60 * 1000;

const createdScopeKeys: string[] = [];

function newScopeKey(label: string): string {
  const key = `user:retention-${label}-${crypto.randomUUID()}`;
  createdScopeKeys.push(key);
  return key;
}

/** Start of the hour `hoursAgo` hours before now, in the storage timestamp shape. */
function hourBucket(hoursAgo: number): string {
  const instant = new Date(Date.now() - hoursAgo * HOUR_MS);
  instant.setUTCMinutes(0, 0, 0);
  return instant.toISOString();
}

async function insertBuckets(scopeKey: string, hoursAgoValues: number[]): Promise<void> {
  await db.insert(spend_alert_hourly).values(
    hoursAgoValues.map(hoursAgo => ({
      scope_key: scopeKey,
      hour_start: hourBucket(hoursAgo),
      cost_microdollars: 1,
    }))
  );
}

async function readBucketHours(scopeKey: string): Promise<string[]> {
  const rows = await db
    .select({ hour_start: spend_alert_hourly.hour_start })
    .from(spend_alert_hourly)
    .where(eq(spend_alert_hourly.scope_key, scopeKey));
  return rows.map(row => new Date(String(row.hour_start)).toISOString()).sort();
}

/** A database that records the SQL text of every statement it executes. */
function databaseRecordingQueries(queries: string[]): typeof db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (query: unknown, ...args: unknown[]) => {
          queries.push(sqlText(query));
          const execute = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
          return Reflect.apply(execute, target, [query, ...args]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as typeof db;
}

function sqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (value && typeof value === 'object') {
    const record = value as { queryChunks?: unknown; value?: unknown };
    if (record.queryChunks) return sqlText(record.queryChunks);
    if (record.value) return sqlText(record.value);
  }
  return '';
}

afterEach(async () => {
  if (createdScopeKeys.length > 0) {
    await db
      .delete(spend_alert_hourly)
      .where(inArray(spend_alert_hourly.scope_key, createdScopeKeys));
    createdScopeKeys.length = 0;
  }
});

describe('pruneSpendAlertHourly', () => {
  it('deletes buckets older than the 30-day window and keeps newer buckets', async () => {
    const scopeKey = newScopeKey('window');
    const oldHours = [30 * 24 + 1, 31 * 24, 60 * 24];
    const keptHours = [0, 24, 29 * 24];
    await insertBuckets(scopeKey, [...oldHours, ...keptHours]);

    const { deleted } = await pruneSpendAlertHourly(db, { now: new Date() });

    expect(SPEND_ALERT_HOURLY_RETENTION_DAYS).toBe(30);
    expect(deleted).toBe(oldHours.length);
    expect(await readBucketHours(scopeKey)).toEqual(keptHours.map(hourBucket).sort());
  });

  it('honours a custom retention window', async () => {
    const scopeKey = newScopeKey('custom');
    await insertBuckets(scopeKey, [2, 25, 48]);

    const { deleted } = await pruneSpendAlertHourly(db, { now: new Date(), retentionDays: 1 });

    expect(deleted).toBe(2);
    expect(await readBucketHours(scopeKey)).toEqual([hourBucket(2)]);
  });

  it('returns zero and issues one empty delete when no bucket is old enough', async () => {
    const scopeKey = newScopeKey('recent');
    await insertBuckets(scopeKey, [0, 12, 24 * 29]);

    const queries: string[] = [];
    const { deleted } = await pruneSpendAlertHourly(databaseRecordingQueries(queries), {
      now: new Date(),
    });

    expect(deleted).toBe(0);
    expect(queries.filter(query => query.includes('DELETE FROM spend_alert_hourly'))).toHaveLength(
      1
    );
    expect(await readBucketHours(scopeKey)).toHaveLength(3);
  });

  it('deletes in bounded batches instead of one unbounded statement', async () => {
    const scopeKey = newScopeKey('batch');
    const total = SPEND_ALERT_HOURLY_PRUNE_BATCH_SIZE + 1;
    const oldestHoursAgo = SPEND_ALERT_HOURLY_RETENTION_DAYS * 24 + 1;
    await db.execute(drizzleSql`
      INSERT INTO spend_alert_hourly (scope_key, hour_start, cost_microdollars)
      SELECT ${scopeKey}, now() - make_interval(hours => n), 1
      FROM generate_series(${oldestHoursAgo}::int, ${oldestHoursAgo + total - 1}::int) AS n
    `);

    const queries: string[] = [];
    const { deleted } = await pruneSpendAlertHourly(databaseRecordingQueries(queries), {
      now: new Date(),
    });

    expect(deleted).toBe(total);
    expect(queries.filter(query => query.includes('DELETE FROM spend_alert_hourly'))).toHaveLength(
      2
    );
    expect(await readBucketHours(scopeKey)).toEqual([]);
  }, 30_000);

  it('rejects a non-positive retention window', async () => {
    await expect(pruneSpendAlertHourly(db, { now: new Date(), retentionDays: 0 })).rejects.toThrow(
      'Spend alert hourly retention days must be a positive number.'
    );
  });
});
