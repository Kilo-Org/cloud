import { beforeEach, describe, expect, test } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kilo_pass_pause_events, kilo_pass_subscriptions } from '@kilocode/db/schema';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import type { StripeSubscriptionStatus } from '@kilocode/db/schema-types';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import {
  openPauseEvent,
  closePauseEvent,
  getOpenPauseEvent,
  getPausedMonthSet,
} from './pause-events';

beforeEach(async () => {
  await cleanupDbForTest();
});

async function insertTestSubscription(params: {
  kiloUserId: string;
  status?: StripeSubscriptionStatus;
}): Promise<string> {
  const inserted = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.kiloUserId,
      stripe_subscription_id: `test-stripe-sub-${crypto.randomUUID()}`,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      status: params.status ?? 'active',
      started_at: new Date().toISOString(),
    })
    .returning({ id: kilo_pass_subscriptions.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error('Failed to insert test subscription');
  return id;
}

describe('openPauseEvent', () => {
  test('inserts a new pause event with correct fields', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    const pausedAt = '2026-01-15T00:00:00.000Z';
    const resumesAt = '2026-02-15T00:00:00.000Z';

    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt,
      resumesAt,
    });

    const rows = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subId));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kilo_pass_subscription_id).toBe(subId);
    expect(row.paused_at).toMatch(/2026-01-15/);
    expect(row.resumes_at).toMatch(/2026-02-15/);
    expect(row.resumed_at).toBeNull();
  });

  test('is idempotent — updates resumes_at on existing open event, does not create duplicate', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    const pausedAt = '2026-01-15T00:00:00.000Z';
    const resumesAt1 = '2026-02-15T00:00:00.000Z';
    const resumesAt2 = '2026-03-01T00:00:00.000Z';

    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt,
      resumesAt: resumesAt1,
    });

    // Call again with a different resumesAt
    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt,
      resumesAt: resumesAt2,
    });

    const rows = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subId));

    // Should still only have one row
    expect(rows).toHaveLength(1);
    // resumes_at should be updated to the new value
    expect(rows[0]!.resumes_at).toMatch(/2026-03-01/);
    expect(rows[0]!.resumed_at).toBeNull();
  });
});

describe('closePauseEvent', () => {
  test('sets resumed_at on open pause event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt: '2026-01-15T00:00:00.000Z',
      resumesAt: '2026-02-15T00:00:00.000Z',
    });

    const resumedAt = '2026-02-10T00:00:00.000Z';
    await closePauseEvent(db, { kiloPassSubscriptionId: subId, resumedAt });

    const rows = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumed_at).toMatch(/2026-02-10/);
  });

  test('is idempotent — no-op when no open event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    // No open event exists; should not throw
    await expect(
      closePauseEvent(db, { kiloPassSubscriptionId: subId, resumedAt: '2026-02-10T00:00:00.000Z' })
    ).resolves.not.toThrow();

    const rows = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subId));

    expect(rows).toHaveLength(0);
  });

  test('is idempotent — does not update already-closed event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt: '2026-01-15T00:00:00.000Z',
      resumesAt: '2026-02-15T00:00:00.000Z',
    });
    await closePauseEvent(db, {
      kiloPassSubscriptionId: subId,
      resumedAt: '2026-02-10T00:00:00.000Z',
    });

    // Close again — should be a no-op (no open event)
    await expect(
      closePauseEvent(db, {
        kiloPassSubscriptionId: subId,
        resumedAt: '2026-02-20T00:00:00.000Z',
      })
    ).resolves.not.toThrow();

    const rows = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subId));

    // resumed_at should still be the original close time
    expect(rows[0]!.resumed_at).toMatch(/2026-02-10/);
  });
});

describe('getOpenPauseEvent', () => {
  test('returns open pause event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt: '2026-01-15T00:00:00.000Z',
      resumesAt: '2026-02-15T00:00:00.000Z',
    });

    const event = await getOpenPauseEvent(db, { kiloPassSubscriptionId: subId });
    expect(event).not.toBeNull();
    expect(event!.kilo_pass_subscription_id).toBe(subId);
    expect(event!.resumed_at).toBeNull();
  });

  test('returns null when no open pause event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    const event = await getOpenPauseEvent(db, { kiloPassSubscriptionId: subId });
    expect(event).toBeNull();
  });
});

describe('getPausedMonthSet', () => {
  test('single pause spanning two months — correct months in set', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    // Paused mid-January, resumed mid-February
    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt: '2026-01-20T00:00:00.000Z',
      resumesAt: null,
    });
    await closePauseEvent(db, {
      kiloPassSubscriptionId: subId,
      resumedAt: '2026-02-20T00:00:00.000Z',
    });

    const result = await getPausedMonthSet(db, {
      kiloPassSubscriptionId: subId,
      fromIssueMonth: '2026-02-01',
      maxMonthsBack: 6,
    });

    expect(result.has('2026-01-01')).toBe(true);
    expect(result.has('2026-02-01')).toBe(true);
    expect(result.has('2026-03-01')).toBe(false);
    expect(result.has('2025-12-01')).toBe(false);
  });

  test('multiple pause/resume cycles — correct months', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    // First pause: January only
    await db.insert(kilo_pass_pause_events).values({
      kilo_pass_subscription_id: subId,
      paused_at: '2026-01-10T00:00:00.000Z',
      resumed_at: '2026-01-28T00:00:00.000Z',
    });

    // Second pause: March only
    await db.insert(kilo_pass_pause_events).values({
      kilo_pass_subscription_id: subId,
      paused_at: '2026-03-05T00:00:00.000Z',
      resumed_at: '2026-03-25T00:00:00.000Z',
    });

    const result = await getPausedMonthSet(db, {
      kiloPassSubscriptionId: subId,
      fromIssueMonth: '2026-04-01',
      maxMonthsBack: 6,
    });

    expect(result.has('2026-01-01')).toBe(true);
    expect(result.has('2026-02-01')).toBe(false);
    expect(result.has('2026-03-01')).toBe(true);
    expect(result.has('2026-04-01')).toBe(false);
  });

  test('billing on 15th — pause before billing date overlaps month correctly', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    // Paused Jan 5, resumed Jan 20 — overlaps January only
    await db.insert(kilo_pass_pause_events).values({
      kilo_pass_subscription_id: subId,
      paused_at: '2026-01-05T00:00:00.000Z',
      resumed_at: '2026-01-20T00:00:00.000Z',
    });

    const result = await getPausedMonthSet(db, {
      kiloPassSubscriptionId: subId,
      fromIssueMonth: '2026-02-01',
      maxMonthsBack: 3,
    });

    expect(result.has('2026-01-01')).toBe(true);
    expect(result.has('2026-02-01')).toBe(false);
    expect(result.has('2025-12-01')).toBe(false);
  });

  test('open pause event (resumed_at null) — all months from pause onward are paused', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    // Paused in January, never resumed
    await openPauseEvent(db, {
      kiloPassSubscriptionId: subId,
      pausedAt: '2026-01-15T00:00:00.000Z',
      resumesAt: null,
    });

    const result = await getPausedMonthSet(db, {
      kiloPassSubscriptionId: subId,
      fromIssueMonth: '2026-04-01',
      maxMonthsBack: 6,
    });

    // January, February, March, April should all be paused
    expect(result.has('2026-04-01')).toBe(true);
    expect(result.has('2026-03-01')).toBe(true);
    expect(result.has('2026-02-01')).toBe(true);
    expect(result.has('2026-01-01')).toBe(true);
    // December should not be paused (pause started Jan 15, after Dec ends)
    expect(result.has('2025-12-01')).toBe(false);
  });

  test('no pause events — returns empty set', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const subId = await insertTestSubscription({ kiloUserId: user.id });

    const result = await getPausedMonthSet(db, {
      kiloPassSubscriptionId: subId,
      fromIssueMonth: '2026-04-01',
      maxMonthsBack: 6,
    });

    expect(result.size).toBe(0);
  });
});
