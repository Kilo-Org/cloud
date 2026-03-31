import { describe, expect, it, beforeEach } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kilocode_users, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import type { User } from '@kilocode/db/schema';

let admin: User;
let target: User;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  target = await insertTestUser({
    google_user_email: `target-${Math.random()}@example.com`,
  });
});

const MS_PER_DAY = 86_400_000;
const MS_PER_YEAR = 365 * MS_PER_DAY;

/** Parse an ISO timestamp string and return its millisecond value. */
function ms(isoString: string): number {
  return new Date(isoString).getTime();
}

describe('extendTrials — 1-year ceiling', () => {
  it('caps a trialing extension at 1 year from now when trialDays=500 and trial already has time remaining', async () => {
    // Trial currently ends 200 days from now. Adding 500 more days would reach
    // 700 days out — well past the 1-year ceiling.
    const currentEnd = new Date(Date.now() + 200 * MS_PER_DAY);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: currentEnd.toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const results = await caller.admin.extendClawTrial.extendTrials({
      emails: [target.google_user_email],
      trialDays: 500,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.success).toBe(true);
    expect(result.newTrialEndsAt).toBeDefined();

    const newEnd = ms(result.newTrialEndsAt!);
    const oneYearFromNow = Date.now() + MS_PER_YEAR;

    // Must not exceed 1 year from now (allow 5s of test execution slack)
    expect(newEnd).toBeLessThanOrEqual(oneYearFromNow + 5_000);
    // Must be close to 1 year from now (within 1 day), not the uncapped 700-day value
    expect(newEnd).toBeGreaterThan(oneYearFromNow - MS_PER_DAY);
  });

  it('caps a canceled resurrection at 1 year from now when trialDays=500', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'canceled',
      trial_started_at: new Date(Date.now() - 30 * MS_PER_DAY).toISOString(),
      trial_ends_at: new Date(Date.now() - 10 * MS_PER_DAY).toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const results = await caller.admin.extendClawTrial.extendTrials({
      emails: [target.google_user_email],
      trialDays: 500,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.success).toBe(true);
    expect(result.newTrialEndsAt).toBeDefined();
    expect(result.action).toBe('restarted');

    const newEnd = ms(result.newTrialEndsAt!);
    const oneYearFromNow = Date.now() + MS_PER_YEAR;

    expect(newEnd).toBeLessThanOrEqual(oneYearFromNow + 5_000);
    expect(newEnd).toBeGreaterThan(oneYearFromNow - MS_PER_DAY);
  });

  it('does not cap a normal extension that stays within 1 year', async () => {
    const caller = await createCallerForUser(admin.id);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date().toISOString(), // ends now
    });

    const results = await caller.admin.extendClawTrial.extendTrials({
      emails: [target.google_user_email],
      trialDays: 7,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.success).toBe(true);

    const newEnd = ms(result.newTrialEndsAt!);
    const expected = Date.now() + 7 * MS_PER_DAY;

    // Should be ~7 days from now, nowhere near the 1-year ceiling
    expect(newEnd).toBeGreaterThan(expected - MS_PER_DAY);
    expect(newEnd).toBeLessThan(expected + MS_PER_DAY);
  });
});
