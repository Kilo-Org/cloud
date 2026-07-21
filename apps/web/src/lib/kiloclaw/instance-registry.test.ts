import { afterEach, describe, expect, it } from '@jest/globals';
import { CURRENT_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  markActiveInstanceBatchDestroyedForGdpr,
  restoreGdprDestroyedInstanceBatch,
} from './instance-registry';

async function insertInstance(userId: string, sandboxId: string): Promise<string> {
  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({ sandbox_id: sandboxId, user_id: userId })
    .returning({ id: kiloclaw_instances.id });
  return instance.id;
}

describe('GDPR instance registry batches', () => {
  afterEach(async () => {
    await cleanupDbForTest();
  });

  it('changes only destroyed_at without changing subscription lineage or logs', async () => {
    const user = await insertTestUser();
    const instanceId = await insertInstance(user.id, 'legacy-gdpr-instance');
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        instance_id: instanceId,
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
        plan: 'standard',
        status: 'canceled',
        user_id: user.id,
      })
      .returning({
        id: kiloclaw_subscriptions.id,
        status: kiloclaw_subscriptions.status,
        transferredToSubscriptionId: kiloclaw_subscriptions.transferred_to_subscription_id,
        updatedAt: kiloclaw_subscriptions.updated_at,
      });

    const batch = await markActiveInstanceBatchDestroyedForGdpr(user.id, [instanceId]);

    const [instance] = await db
      .select({
        destroyedAt: kiloclaw_instances.destroyed_at,
        sandboxId: kiloclaw_instances.sandbox_id,
      })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instanceId));
    const [subscriptionAfter] = await db
      .select({
        id: kiloclaw_subscriptions.id,
        status: kiloclaw_subscriptions.status,
        transferredToSubscriptionId: kiloclaw_subscriptions.transferred_to_subscription_id,
        updatedAt: kiloclaw_subscriptions.updated_at,
      })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    const changeLogs = await db
      .select({ id: kiloclaw_subscription_change_log.id })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));

    expect(batch.instanceIds).toEqual([instanceId]);
    expect(instance).toEqual({ destroyedAt: batch.destroyedAt, sandboxId: 'legacy-gdpr-instance' });
    expect(subscriptionAfter).toEqual(subscription);
    expect(changeLogs).toHaveLength(0);
  });

  it('rejects an exact-set mismatch without marking any matching rows', async () => {
    const user = await insertTestUser();
    const ownedInstanceId = await insertInstance(user.id, 'owned-gdpr-instance');
    const otherUser = await insertTestUser();
    const otherInstanceId = await insertInstance(otherUser.id, 'other-gdpr-instance');

    await expect(
      markActiveInstanceBatchDestroyedForGdpr(user.id, [ownedInstanceId, otherInstanceId])
    ).rejects.toThrow('exact active user-owned ID set');

    const activeRows = await db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(
        and(
          inArray(kiloclaw_instances.id, [ownedInstanceId, otherInstanceId]),
          isNull(kiloclaw_instances.destroyed_at)
        )
      );
    expect(activeRows.map(row => row.id).sort()).toEqual([ownedInstanceId, otherInstanceId].sort());
  });

  it('timestamp-guards rollback and leaves the batch untouched on a mismatch', async () => {
    const user = await insertTestUser();
    const firstInstanceId = await insertInstance(user.id, 'first-gdpr-instance');
    const secondInstanceId = await insertInstance(user.id, 'second-gdpr-instance');
    const batch = await markActiveInstanceBatchDestroyedForGdpr(user.id, [
      firstInstanceId,
      secondInstanceId,
    ]);
    const laterTimestamp = '2026-07-21T12:01:00.000Z';
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: laterTimestamp })
      .where(eq(kiloclaw_instances.id, secondInstanceId));

    await expect(restoreGdprDestroyedInstanceBatch(batch)).rejects.toThrow(
      'exact destroyed ID set'
    );

    const rows = await db
      .select({ id: kiloclaw_instances.id, destroyedAt: kiloclaw_instances.destroyed_at })
      .from(kiloclaw_instances)
      .where(inArray(kiloclaw_instances.id, [firstInstanceId, secondInstanceId]));
    expect(Object.fromEntries(rows.map(row => [row.id, row.destroyedAt]))).toEqual({
      [firstInstanceId]: batch.destroyedAt,
      [secondInstanceId]: expect.any(String),
    });
    expect(rows.find(row => row.id === secondInstanceId)?.destroyedAt).not.toBe(batch.destroyedAt);
  });
});
