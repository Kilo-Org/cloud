import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state } from '@kilocode/db/schema';
import type { NewEnkryptSyncState } from '@kilocode/db/schema';
import { ENKRYPT_STALE_AFTER_MS, EnkryptFailureCategorySchema } from '@kilocode/db/schema-types';
import type { EnkryptSyncCounts } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';
import { EnkryptSyncError } from './enkrypt-errors';
import { getEnkryptSyncHealth, recordEnkryptSyncAlert } from './enkrypt-status';

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
    const [state] = await db
      .select()
      .from(enkrypt_sync_state)
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    if (!state) throw new Error('Expected singleton');
    return state;
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

  it('is disabled without database access, validation, or alert recording', async () => {
    mockEnabled = false;
    const select = jest.spyOn(db, 'select');
    const insert = jest.spyOn(db, 'insert');
    const update = jest.spyOn(db, 'update');
    expect(await getEnkryptSyncHealth()).toEqual({
      status: 'disabled',
      reason: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      counts: null,
      lastSuccessCounts: null,
      baselineMatchedCount: null,
      lastAlertAt: null,
      lastAlertReason: null,
      shouldAlert: false,
    });
    await recordEnkryptSyncAlert('invalid', 'invalid');
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('reports never succeeded without creating an attempt or recording an undelivered alert', async () => {
    const insert = jest.spyOn(db, 'insert');
    const update = jest.spyOn(db, 'update');
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'never_succeeded',
      reason: 'never_succeeded',
      lastAttemptAt: null,
      lastSuccessAt: null,
      shouldAlert: true,
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({ shouldAlert: true, lastAlertAt: null });
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await db.select().from(enkrypt_sync_state)).toEqual([]);
  });

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
      lastAlertAt: null,
      lastAlertReason: null,
      shouldAlert: false,
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
        shouldAlert: false,
      });
      jest.spyOn(Date, 'now').mockReturnValue(now - hour + ENKRYPT_STALE_AFTER_MS);
      expect(await getEnkryptSyncHealth()).toMatchObject({ status: 'stale', shouldAlert: true });
    }
  );

  it.each([
    { age: ENKRYPT_STALE_AFTER_MS - 1, status: 'healthy', reason: null, shouldAlert: false },
    { age: ENKRYPT_STALE_AFTER_MS, status: 'stale', reason: 'stale', shouldAlert: true },
    { age: ENKRYPT_STALE_AFTER_MS + 1, status: 'stale', reason: 'stale', shouldAlert: true },
  ])(
    'uses the publication freshness boundary at age $age',
    async ({ age, status, reason, shouldAlert }) => {
      await seed({
        last_attempt_at: iso(now - age),
        last_completed_at: iso(now - age),
        last_success_at: iso(now - age),
      });
      expect(await getEnkryptSyncHealth()).toMatchObject({ status, reason, shouldAlert });
    }
  );

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
        shouldAlert: true,
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
        shouldAlert: true,
      });
    }
  );

  it('reports stale success independently of latest failure or an in-flight run', async () => {
    await seed({
      last_success_at: iso(now - 27 * hour),
      last_outcome: 'failed',
      last_failure_category: 'coverage',
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'stale',
      reason: 'stale',
      shouldAlert: true,
    });
    await db
      .update(enkrypt_sync_state)
      .set({ last_outcome: 'running', last_completed_at: null, last_failure_category: null })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'stale',
      reason: 'stale',
      shouldAlert: true,
    });
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
      shouldAlert: true,
      lastSuccessAt: null,
    });
  });

  it.each([undefined, '', '  '])(
    'reports missing key %# without disguising it as a healthy or never-run job',
    async key => {
      mockApiKey = key;
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'degraded',
        reason: 'configuration',
        shouldAlert: true,
      });
      await recordEnkryptSyncAlert('configuration', iso(now));
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'degraded',
        reason: 'configuration',
        shouldAlert: false,
      });
      expect(await readState()).toMatchObject({
        last_attempt_at: null,
        last_success_at: null,
        last_outcome: null,
      });
    }
  );

  it('exposes no database errors, logs, or score payload on read failure', async () => {
    jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('unsafe-marker SQL parameters');
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const health = await getEnkryptSyncHealth();
    expect(health).toEqual({
      status: 'unavailable',
      reason: 'monitor_error',
      lastAttemptAt: null,
      lastSuccessAt: null,
      counts: null,
      lastSuccessCounts: null,
      baselineMatchedCount: null,
      lastAlertAt: null,
      lastAlertReason: null,
      shouldAlert: true,
    });
    expect(JSON.stringify(health)).not.toContain('unsafe-marker');
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['last_attempt_at', 'last_completed_at', 'last_success_at', 'last_alert_at'] as const)(
    'fails closed for non-finite database timestamp %s',
    async field => {
      await seed({ [field]: 'infinity' });
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'unavailable',
        reason: 'monitor_error',
        counts: null,
        shouldAlert: true,
      });
    }
  );

  it.each(['last_attempt_at', 'last_completed_at', 'last_success_at', 'last_alert_at'] as const)(
    'fails closed for future database timestamp %s',
    async field => {
      await seed({ [field]: iso(now + 1) });
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'unavailable',
        reason: 'monitor_error',
        shouldAlert: true,
      });
    }
  );

  it('fails closed for an unknown database failure category', async () => {
    await seed({ last_outcome: 'failed' });
    await db
      .update(enkrypt_sync_state)
      .set({ last_failure_category: sql`'unsafe-marker'` })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    const health = await getEnkryptSyncHealth();
    expect(health).toMatchObject({
      status: 'unavailable',
      reason: 'monitor_error',
      shouldAlert: true,
    });
    expect(JSON.stringify(health)).not.toContain('unsafe-marker');
  });

  it('suppresses a delivered monitor error even when another persisted field is invalid', async () => {
    await seed({ last_outcome: 'failed' });
    await db
      .update(enkrypt_sync_state)
      .set({ last_failure_category: sql`'unsafe-marker'` })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'unavailable',
      shouldAlert: true,
    });
    await recordEnkryptSyncAlert('monitor_error', iso(now));
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'unavailable',
      reason: 'monitor_error',
      shouldAlert: false,
      lastAlertAt: iso(now),
    });
    jest.spyOn(Date, 'now').mockReturnValue(now + 24 * hour);
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'unavailable',
      shouldAlert: true,
    });
  });

  it('fails closed for an unknown alert reason', async () => {
    await seed();
    await db
      .update(enkrypt_sync_state)
      .set({ last_alert_reason: sql`'unsafe-marker'` })
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'unavailable',
      reason: 'monitor_error',
      shouldAlert: true,
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
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'unavailable',
      reason: 'monitor_error',
      shouldAlert: true,
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
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'unavailable',
      counts: null,
      shouldAlert: true,
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

  it.each([
    { age: 24 * hour - 1, shouldAlert: false },
    { age: 24 * hour, shouldAlert: true },
    { age: 24 * hour + 1, shouldAlert: true },
  ])('suppresses the same reason for exactly 24 hours: $age', async ({ age, shouldAlert }) => {
    await seed({
      last_outcome: 'failed',
      last_failure_category: 'coverage',
      last_success_at: null,
      last_success_counts: null,
      baseline_matched_count: null,
      last_alert_at: iso(now - age),
      last_alert_reason: 'coverage',
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'degraded',
      reason: 'coverage',
      shouldAlert,
    });
  });

  it('alerts immediately for a different failure category', async () => {
    await seed({
      last_outcome: 'failed',
      last_failure_category: 'coverage',
      last_alert_at: iso(now - 1),
      last_alert_reason: 'authentication',
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({ reason: 'coverage', shouldAlert: true });
  });

  it('rearms the same failure after a recovery even within the suppression window', async () => {
    await seed({
      last_outcome: 'failed',
      last_failure_category: 'coverage',
      last_alert_at: iso(now - 2 * hour),
      last_alert_reason: 'coverage',
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({ reason: 'coverage', shouldAlert: true });
    await recordEnkryptSyncAlert('coverage', iso(now));
    expect(await getEnkryptSyncHealth()).toMatchObject({ reason: 'coverage', shouldAlert: false });
  });

  it('writes only alert columns after delivery and never advances the successful import', async () => {
    await seed({ last_outcome: 'failed', last_failure_category: 'coverage' });
    const before = await readState();
    const undelivered = await getEnkryptSyncHealth();
    expect(undelivered.shouldAlert).toBe(true);
    expect(await readState()).toEqual(before);
    await recordEnkryptSyncAlert('coverage', iso(now));
    const after = await readState();
    expect(after).toEqual({
      ...before,
      last_alert_at: after.last_alert_at,
      last_alert_reason: 'coverage',
    });
    expect(new Date(after.last_alert_at ?? '').toISOString()).toBe(iso(now));
    expect(await getEnkryptSyncHealth()).toMatchObject({
      shouldAlert: false,
      lastAlertAt: iso(now),
      reason: 'coverage',
    });
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

  it('records a delivered never-run alert without inventing any attempt or success', async () => {
    await recordEnkryptSyncAlert('never_succeeded', iso(now));
    expect(await readState()).toMatchObject({
      job_name: 'enkrypt',
      attempt_id: null,
      last_attempt_at: null,
      last_completed_at: null,
      last_success_at: null,
      last_outcome: null,
      last_counts: null,
      last_success_counts: null,
      baseline_matched_count: null,
      last_alert_reason: 'never_succeeded',
    });
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'never_succeeded',
      shouldAlert: false,
      lastAlertAt: iso(now),
    });
  });

  it('does not let a late alert overwrite a newer delivery', async () => {
    await recordEnkryptSyncAlert('never_succeeded', iso(now));
    const before = await readState();
    await recordEnkryptSyncAlert('coverage', iso(now - 1));
    expect(await readState()).toEqual(before);
  });

  it('does not let an old delivery suppress an alert after a newer recovery', async () => {
    await seed({ last_outcome: 'failed', last_failure_category: 'coverage' });
    const before = await readState();
    await recordEnkryptSyncAlert('coverage', iso(now - 2 * hour));
    expect(await readState()).toEqual(before);
    expect(await getEnkryptSyncHealth()).toMatchObject({ reason: 'coverage', shouldAlert: true });
  });

  it('does not let an alert at the recovery timestamp suppress a later failure', async () => {
    await seed({ last_outcome: 'failed', last_failure_category: 'coverage' });
    const before = await readState();
    await recordEnkryptSyncAlert('coverage', iso(now - hour));
    expect(await readState()).toEqual(before);
    expect(await getEnkryptSyncHealth()).toMatchObject({ reason: 'coverage', shouldAlert: true });
  });

  it.each([
    ['unsafe-marker', iso(now)],
    ['coverage', 'unsafe-marker'],
    ['coverage', 'infinity'],
  ])('rejects invalid alert input %# safely without database writes', async (reason, at) => {
    const insert = jest.spyOn(db, 'insert');
    await expect(recordEnkryptSyncAlert(reason, at)).rejects.toMatchObject({
      category: 'unexpected',
      message: 'Enkrypt synchronization failed',
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('sanitizes alert persistence failures without reporting successful recording', async () => {
    jest.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('unsafe-marker SQL parameters');
    });
    const result = await recordEnkryptSyncAlert('coverage', iso(now)).catch(
      (error: unknown) => error
    );
    expect(result).toBeInstanceOf(EnkryptSyncError);
    expect(result).toMatchObject({
      category: 'database',
      message: 'Enkrypt synchronization failed',
    });
    expect(result).not.toHaveProperty('cause');
    expect(JSON.stringify(result)).not.toContain('unsafe-marker');
    expect(await db.select().from(enkrypt_sync_state)).toEqual([]);
  });
});
