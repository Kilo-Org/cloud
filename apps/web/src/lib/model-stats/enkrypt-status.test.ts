import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state } from '@kilocode/db/schema';
import type { NewEnkryptSyncState } from '@kilocode/db/schema';
import { ENKRYPT_STALE_AFTER_MS, EnkryptFailureCategorySchema } from '@kilocode/db/schema-types';
import type { EnkryptSyncCounts } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';
import { getEnkryptSyncHealth } from './enkrypt-status';

let mockEnabled = true;
let mockApiKey: string | undefined = 'test-key';

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_SYNC_ENABLED() {
    return mockEnabled;
  },
  get ENKRYPT_API_KEY() {
    return mockApiKey;
  },
}));

const now = Date.parse('2026-08-27T12:00:00.000Z');
const hour = 60 * 60 * 1000;
const counts: EnkryptSyncCounts = {
  fetchedCount: 7,
  rejectedCount: 0,
  matchedCount: 3,
  unmatchedCount: 4,
  ambiguousCount: 0,
  updatedCount: 3,
};
const iso = (at: number) => new Date(at).toISOString();
const empty = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  counts: null,
  lastSuccessCounts: null,
  baselineMatchedCount: null,
};

describe('Enkrypt singleton health with PostgreSQL', () => {
  async function seed(overrides: Partial<NewEnkryptSyncState> = {}) {
    await db.insert(enkrypt_sync_state).values({
      job_name: 'enkrypt',
      last_attempt_at: iso(now - hour),
      last_completed_at: iso(now - hour),
      last_success_at: iso(now - hour),
      last_outcome: 'succeeded',
      last_counts: counts,
      last_success_counts: counts,
      baseline_matched_count: 3,
      ...overrides,
    });
  }

  async function readState() {
    return db.select().from(enkrypt_sync_state).where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
  }

  beforeEach(async () => {
    mockEnabled = true;
    mockApiKey = 'test-key';
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await db.delete(enkrypt_sync_state).where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(enkrypt_sync_state).where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
  });

  it('is disabled without database access or validation', async () => {
    mockEnabled = false;
    const select = jest.spyOn(db, 'select');
    expect(await getEnkryptSyncHealth()).toEqual({ status: 'disabled', reason: null, ...empty });
    expect(select).not.toHaveBeenCalled();
  });

  it('reports never succeeded without creating state', async () => {
    const insert = jest.spyOn(db, 'insert');
    const update = jest.spyOn(db, 'update');
    const first = await getEnkryptSyncHealth();
    expect(first).toEqual({ status: 'never_succeeded', reason: 'never_succeeded', ...empty });
    expect(await getEnkryptSyncHealth()).toEqual(first);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await readState()).toEqual([]);
  });

  it.each(['sequential', 'concurrent'] as const)(
    'keeps repeated %s health reads identical without database writes',
    async mode => {
      await seed({ last_outcome: 'failed', last_failure_category: 'coverage' });
      const before = await readState();
      const writes = [
        jest.spyOn(db, 'insert'),
        jest.spyOn(db, 'update'),
        jest.spyOn(db, 'delete'),
        jest.spyOn(db, 'transaction'),
      ];
      const results =
        mode === 'concurrent'
          ? await Promise.all([getEnkryptSyncHealth(), getEnkryptSyncHealth()])
          : [await getEnkryptSyncHealth(), await getEnkryptSyncHealth()];
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({ status: 'degraded', reason: 'coverage' });
      expect(await readState()).toEqual(before);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    }
  );

  it('normalizes PostgreSQL timestamps and returns only safe counts and health', async () => {
    await seed({
      last_attempt_at: '2026-08-27 11:00:00.000+00',
      last_completed_at: '2026-08-27 11:00:00.000+00',
      last_success_at: '2026-08-27 11:00:00.000+00',
    });
    expect(await getEnkryptSyncHealth()).toEqual({
      status: 'healthy',
      reason: null,
      lastAttemptAt: iso(now - hour),
      lastSuccessAt: iso(now - hour),
      counts,
      lastSuccessCounts: counts,
      baselineMatchedCount: 3,
    });
  });

  it.each([0, 1, 2, 3])(
    'reports %s changed rows as healthy when all matched scores were checked',
    async updatedCount => {
      const checkedCounts = { ...counts, updatedCount };
      await seed({ last_counts: checkedCounts, last_success_counts: checkedCounts });
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'healthy',
        reason: null,
        counts: checkedCounts,
        lastSuccessCounts: checkedCounts,
        lastSuccessAt: iso(now - hour),
      });
      jest.spyOn(Date, 'now').mockReturnValue(now - hour + ENKRYPT_STALE_AFTER_MS);
      expect(await getEnkryptSyncHealth()).toMatchObject({ status: 'stale', reason: 'stale' });
    }
  );

  it.each([
    { age: ENKRYPT_STALE_AFTER_MS - 1, status: 'healthy', reason: null },
    { age: ENKRYPT_STALE_AFTER_MS, status: 'stale', reason: 'stale' },
    { age: ENKRYPT_STALE_AFTER_MS + 1, status: 'stale', reason: 'stale' },
  ])('uses the publication freshness boundary at age $age', async ({ age, status, reason }) => {
    expect(ENKRYPT_STALE_AFTER_MS).toBe(26 * hour);
    await seed({
      last_attempt_at: iso(now - age),
      last_completed_at: iso(now - age),
      last_success_at: iso(now - age),
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({ status, reason });
  });

  it.each(EnkryptFailureCategorySchema.options)(
    'keeps first failure %s actionable rather than hiding it as never succeeded',
    async category => {
      await seed({
        last_outcome: 'failed',
        last_failure_category: category,
        last_success_at: null,
        last_success_counts: null,
        baseline_matched_count: null,
      });
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'degraded',
        reason: category,
        lastSuccessAt: null,
      });
    }
  );

  it.each(EnkryptFailureCategorySchema.options)(
    'reports fresh last success as degraded after failure %s',
    async category => {
      await seed({
        last_outcome: 'failed',
        last_failure_category: category,
        last_counts: { ...counts, updatedCount: 0 },
      });
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'degraded',
        reason: category,
        counts: { ...counts, updatedCount: 0 },
        lastSuccessCounts: counts,
      });
    }
  );

  it('reports stale success independently of latest failure or an in-flight run', async () => {
    await seed({
      last_success_at: iso(now - 27 * hour),
      last_outcome: 'failed',
      last_failure_category: 'coverage',
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({ status: 'stale', reason: 'stale' });
    await db
      .update(enkrypt_sync_state)
      .set({ last_outcome: 'running', last_completed_at: null, last_failure_category: null })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toMatchObject({ status: 'stale', reason: 'stale' });
  });

  it('does not treat a fresh running attempt as a new success', async () => {
    await seed({
      last_attempt_at: iso(now),
      last_completed_at: null,
      last_outcome: 'running',
      last_counts: null,
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'healthy',
      lastSuccessAt: iso(now - hour),
      counts: null,
      lastSuccessCounts: counts,
    });
    await db
      .update(enkrypt_sync_state)
      .set({ last_success_at: null, last_success_counts: null, baseline_matched_count: null })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'never_succeeded',
      lastSuccessAt: null,
    });
  });

  it('retains unknown counts after a database failure without inventing zero updates', async () => {
    await seed({ last_outcome: 'failed', last_failure_category: 'database', last_counts: null });
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'degraded',
      reason: 'database',
      counts: null,
      lastSuccessCounts: counts,
    });
  });

  it.each([undefined, '', '  '])(
    'reports missing key %# without disguising it as healthy or never-run',
    async key => {
      mockApiKey = key;
      expect(await getEnkryptSyncHealth()).toEqual({
        status: 'degraded',
        reason: 'configuration',
        ...empty,
      });
      expect(await readState()).toEqual([]);
      await seed();
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'degraded',
        reason: 'configuration',
      });
    }
  );

  it('exposes no database errors, logs, or score payload on read failure', async () => {
    jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('unsafe-marker SQL parameters');
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await getEnkryptSyncHealth()).toEqual({
      status: 'unavailable',
      reason: 'monitor_error',
      ...empty,
    });
    expect(log).not.toHaveBeenCalled();
  });

  describe.each(['infinity', iso(now + 1)])('invalid timestamp %s', value => {
    it.each(['last_attempt_at', 'last_completed_at', 'last_success_at'] as const)(
      'fails closed for %s',
      async field => {
        await seed({ [field]: value });
        expect(await getEnkryptSyncHealth()).toEqual({
          status: 'unavailable',
          reason: 'monitor_error',
          ...empty,
        });
      }
    );
  });

  it('fails closed for an unknown database failure category', async () => {
    await seed({ last_outcome: 'failed' });
    await db
      .update(enkrypt_sync_state)
      .set({ last_failure_category: sql`'unsafe-marker'` })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toEqual({
      status: 'unavailable',
      reason: 'monitor_error',
      ...empty,
    });
  });

  it.each([
    { last_outcome: 'failed' as const, last_failure_category: null },
    { last_success_counts: null },
    { baseline_matched_count: null },
    { baseline_matched_count: 2 },
    { last_success_at: null },
    { last_success_counts: { ...counts, matchedCount: 0, updatedCount: 0 } },
    { last_success_counts: { ...counts, matchedCount: 2 } },
    { last_success_counts: { ...counts, updatedCount: -1 } },
    { last_success_counts: { ...counts, fetchedCount: 8 } },
    { last_success_counts: { ...counts, rejectedCount: 1 } },
    { last_success_counts: { ...counts, ambiguousCount: 1 } },
  ])('fails closed for inconsistent success or failure state %#', async overrides => {
    await seed(overrides);
    expect(await getEnkryptSyncHealth()).toEqual({
      status: 'unavailable',
      reason: 'monitor_error',
      ...empty,
    });
  });

  it('validates persisted counter shapes instead of leaking arbitrary JSON', async () => {
    await seed();
    await db
      .update(enkrypt_sync_state)
      .set({
        last_counts: sql`${JSON.stringify({ ...counts, fetchedCount: 'unsafe-marker' })}::jsonb`,
      })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toEqual({
      status: 'unavailable',
      reason: 'monitor_error',
      ...empty,
    });
  });

  it('strips unexpected persisted fields from public counters', async () => {
    await seed();
    await db
      .update(enkrypt_sync_state)
      .set({
        last_counts: sql`${JSON.stringify({ ...counts, scores: [{ risk_score: 99 }], extra: 'unsafe-marker' })}::jsonb`,
      })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    const health = await getEnkryptSyncHealth();
    expect(health.counts).toEqual(counts);
    expect(JSON.stringify(health)).not.toContain('unsafe-marker');
    expect(JSON.stringify(health)).not.toContain('risk_score');
  });

  it('enforces a single Enkrypt row in PostgreSQL', async () => {
    await seed();
    await expect(db.insert(enkrypt_sync_state).values({ job_name: 'enkrypt' })).rejects.toThrow();
    await expect(
      db.insert(enkrypt_sync_state).values({ job_name: sql`'another-job'` })
    ).rejects.toThrow();
    expect(await db.select().from(enkrypt_sync_state)).toHaveLength(1);
  });

  it('enforces outcome and nonnegative baseline constraints in PostgreSQL', async () => {
    await seed();
    await expect(
      db
        .update(enkrypt_sync_state)
        .set({ baseline_matched_count: -1 })
        .where(eq(enkrypt_sync_state.job_name, 'enkrypt'))
    ).rejects.toThrow();
    await expect(
      db
        .update(enkrypt_sync_state)
        .set({ last_outcome: sql`'invalid'` })
        .where(eq(enkrypt_sync_state.job_name, 'enkrypt'))
    ).rejects.toThrow();
    expect(await getEnkryptSyncHealth()).toMatchObject({ status: 'healthy' });
  });
});
