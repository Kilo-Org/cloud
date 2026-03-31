import { describe, expect, it, beforeEach } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kiloclaw_subscriptions } from '@kilocode/db/schema';
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

function ms(isoString: string): number {
  return new Date(isoString).getTime();
}

describe('matchUsers — at_limit ineligibility', () => {
  it('marks a trialing user ineligible when trial_ends_at is already beyond 1 year from now', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 400 * MS_PER_DAY).toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const { matched } = await caller.admin.extendClawTrial.matchUsers({
      emails: [target.google_user_email],
    });

    expect(matched).toHaveLength(1);
    expect(matched[0].subscriptionStatus).toBe('at_limit');
  });

  it('marks a trialing user ineligible when trial_ends_at is exactly at the 1-year ceiling', async () => {
    // Use calendar-year arithmetic (setFullYear) to match the implementation,
    // not 365 * MS_PER_DAY which diverges on leap-year boundaries.
    const oneYearFromNow = new Date();
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: oneYearFromNow.toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const { matched } = await caller.admin.extendClawTrial.matchUsers({
      emails: [target.google_user_email],
    });

    expect(matched).toHaveLength(1);
    expect(matched[0].subscriptionStatus).toBe('at_limit');
  });

  it('does not mark a trialing user ineligible when trial ends within 1 year', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 200 * MS_PER_DAY).toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const { matched } = await caller.admin.extendClawTrial.matchUsers({
      emails: [target.google_user_email],
    });

    expect(matched).toHaveLength(1);
    expect(matched[0].subscriptionStatus).toBe('trialing');
  });
});

describe('extendTrials — 1-year ceiling', () => {
  it('caps result at 1 year from now when existing trial + requested days would exceed it', async () => {
    // 200 days remaining + 365 days = 565 days out, must be capped to 365.
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
      trialDays: 365,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.success).toBe(true);

    const newEnd = new Date(result.newTrialEndsAt!).getTime();
    const oneYearFromNow = Date.now() + MS_PER_YEAR;

    // Must be capped at ~1 year, not ~565 days
    expect(newEnd).toBeLessThanOrEqual(oneYearFromNow + 5_000);
    expect(newEnd).toBeGreaterThan(oneYearFromNow - MS_PER_DAY);
  });
});

describe('extendTrials — normal extension', () => {
  it('extends a trialing subscription by the requested days', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: target.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const results = await caller.admin.extendClawTrial.extendTrials({
      emails: [target.google_user_email],
      trialDays: 7,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.success).toBe(true);
    expect(result.action).toBe('extended');

    const newEnd = ms(result.newTrialEndsAt!);
    const expected = Date.now() + 7 * MS_PER_DAY;
    expect(newEnd).toBeGreaterThan(expected - MS_PER_DAY);
    expect(newEnd).toBeLessThan(expected + MS_PER_DAY);
  });

  it('resurrects a canceled subscription as a fresh trial', async () => {
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
      trialDays: 365,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.success).toBe(true);
    expect(result.action).toBe('restarted');

    const newEnd = ms(result.newTrialEndsAt!);
    const oneYearFromNow = Date.now() + MS_PER_YEAR;
    expect(newEnd).toBeGreaterThan(oneYearFromNow - MS_PER_DAY);
    expect(newEnd).toBeLessThanOrEqual(oneYearFromNow + 5_000);
  });
});
