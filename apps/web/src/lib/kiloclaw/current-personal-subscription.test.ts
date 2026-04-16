import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { kiloclaw_instances, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

let resolveCurrentPersonalSubscriptionRow: typeof import('./current-personal-subscription').resolveCurrentPersonalSubscriptionRow;

describe('resolveCurrentPersonalSubscriptionRow', () => {
  let user: User;

  beforeAll(async () => {
    ({ resolveCurrentPersonalSubscriptionRow } = await import('./current-personal-subscription'));
  });

  beforeEach(async () => {
    await cleanupDbForTest();
    user = await insertTestUser({
      google_user_email: `current-personal-sub-${Math.random()}@example.com`,
    });
  });

  it('prefers instance-bound current row when legacy detached row also exists', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance?.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: '2026-04-10T00:00:00.000Z',
      trial_ends_at: '2026-04-17T00:00:00.000Z',
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      stripe_subscription_id: 'sub_legacy_detached',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const row = await resolveCurrentPersonalSubscriptionRow({ userId: user.id });

    expect(row?.subscription.instance_id).toBe(instance?.id ?? null);
    expect(row?.subscription.stripe_subscription_id).toBeNull();
  });

  it('returns null when only legacy detached row exists', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      stripe_subscription_id: 'sub_detached_only',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const row = await resolveCurrentPersonalSubscriptionRow({ userId: user.id });

    expect(row).toBeNull();
  });
});
