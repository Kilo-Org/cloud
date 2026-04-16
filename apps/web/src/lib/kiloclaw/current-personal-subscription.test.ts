import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { kiloclaw_instances, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type { resolveCurrentPersonalSubscriptionRow as ResolveCurrentFn } from './current-personal-subscription';

let resolveCurrentPersonalSubscriptionRow: typeof ResolveCurrentFn;

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

  it('returns destroyed current row when it is the only personal billing row', async () => {
    const [destroyedInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `destroyed-current-${crypto.randomUUID()}`,
        destroyed_at: '2026-04-12T00:00:00.000Z',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: destroyedInstance?.id,
      plan: 'standard',
      status: 'active',
      stripe_subscription_id: 'sub_destroyed_current',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const row = await resolveCurrentPersonalSubscriptionRow({ userId: user.id });

    expect(row?.subscription.instance_id).toBe(destroyedInstance?.id ?? null);
    expect(new Date(row?.instance?.destroyedAt ?? '').toISOString()).toBe(
      '2026-04-12T00:00:00.000Z'
    );
  });

  it('ignores destroyed historical rows when a live personal row also exists', async () => {
    const [destroyedInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `destroyed-sandbox-${crypto.randomUUID()}`,
        destroyed_at: '2026-04-09T00:00:00.000Z',
      })
      .returning();
    const [activeInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `active-sandbox-${crypto.randomUUID()}`,
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: destroyedInstance?.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_destroyed_history',
      current_period_start: '2026-03-01T00:00:00.000Z',
      current_period_end: '2026-04-01T00:00:00.000Z',
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: activeInstance?.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: '2026-04-10T00:00:00.000Z',
      trial_ends_at: '2026-04-17T00:00:00.000Z',
    });

    const row = await resolveCurrentPersonalSubscriptionRow({ userId: user.id });

    expect(row?.subscription.instance_id).toBe(activeInstance?.id ?? null);
  });

  it('throws when multiple destroyed current rows remain', async () => {
    const [olderDestroyedInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `destroyed-older-${crypto.randomUUID()}`,
        destroyed_at: '2026-04-01T00:00:00.000Z',
      })
      .returning();
    const [newerDestroyedInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `destroyed-newer-${crypto.randomUUID()}`,
        destroyed_at: '2026-04-10T00:00:00.000Z',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: olderDestroyedInstance?.id,
      plan: 'standard',
      status: 'canceled',
      current_period_end: '2026-03-01T00:00:00.000Z',
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: newerDestroyedInstance?.id,
      plan: 'standard',
      status: 'active',
      stripe_subscription_id: 'sub_destroyed_ambiguous',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    await expect(resolveCurrentPersonalSubscriptionRow({ userId: user.id })).rejects.toThrow(
      `Expected at most one current personal subscription row for user ${user.id}, found 2`
    );
  });
});
