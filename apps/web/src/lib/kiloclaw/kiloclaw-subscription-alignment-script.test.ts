import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { run } from '@/scripts/db/kiloclaw-subscription-alignment';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('kiloclaw-subscription-alignment script', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'table').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reassigns duplicate active personal subscription to canonical instance and destroys duplicate', async () => {
    const user = await insertTestUser({
      google_user_email: 'duplicate-align@example.com',
    });

    const canonicalInstanceId = crypto.randomUUID();
    const duplicateInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: canonicalInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${canonicalInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
      {
        id: duplicateInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${duplicateInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-02T00:00:00.000Z',
      },
    ]);

    const [duplicateSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: duplicateInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-04-02T00:00:00.000Z',
        updated_at: '2026-04-02T00:00:00.000Z',
      })
      .returning();

    if (!duplicateSubscription) {
      throw new Error('Expected duplicate subscription row');
    }

    await run('apply-duplicates');

    const [canonicalInstance, duplicateInstance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id))
      .orderBy(kiloclaw_instances.created_at);

    expect(canonicalInstance?.id).toBe(canonicalInstanceId);
    expect(duplicateInstance?.id).toBe(duplicateInstanceId);
    expect(duplicateInstance?.destroyed_at).not.toBeNull();

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);

    expect(subscriptions).toHaveLength(2);

    const reassigned = subscriptions.find(
      subscription => subscription.id === duplicateSubscription.id
    );
    const replacement = subscriptions.find(
      subscription =>
        subscription.id !== duplicateSubscription.id &&
        subscription.instance_id === duplicateInstanceId
    );

    if (!replacement) {
      throw new Error('Expected replacement terminal subscription row');
    }

    expect(reassigned?.instance_id).toBe(canonicalInstanceId);
    expect(replacement).toEqual(
      expect.objectContaining({
        user_id: user.id,
        instance_id: duplicateInstanceId,
        plan: 'trial',
        status: 'canceled',
      })
    );

    const changeLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, duplicateSubscription.id));

    expect(changeLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'reassigned',
          reason: 'apply_duplicate_active_reassign_to_canonical',
        }),
      ])
    );

    const replacementLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, replacement.id));

    expect(replacementLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'backfilled',
          reason: 'apply_duplicate_active_backfill_personal_terminal',
        }),
      ])
    );
  });

  it('backfills missing baseline changelog rows once', async () => {
    const user = await insertTestUser({
      google_user_email: 'baseline-log@example.com',
    });
    const instanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replaceAll('-', '')}`,
    });

    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: instanceId,
        plan: 'trial',
        status: 'trialing',
        cancel_at_period_end: false,
        trial_started_at: '2026-04-01T00:00:00.000Z',
        trial_ends_at: '2026-04-08T00:00:00.000Z',
      })
      .returning();

    if (!subscription) {
      throw new Error('Expected baseline subscription row');
    }

    await run('apply-changelog-baseline');
    await run('apply-changelog-baseline');

    const changeLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));

    expect(changeLogs).toHaveLength(1);
    expect(changeLogs[0]).toEqual(
      expect.objectContaining({
        action: 'backfilled',
        actor_type: 'system',
        actor_id: 'kiloclaw-subscription-alignment',
        reason: 'baseline_subscription_snapshot',
      })
    );
    expect(changeLogs[0]?.before_state).toBeNull();
    expect(changeLogs[0]?.after_state).toEqual(
      expect.objectContaining({
        id: subscription.id,
        user_id: user.id,
        instance_id: instanceId,
        plan: 'trial',
        status: 'trialing',
      })
    );
  });
});
