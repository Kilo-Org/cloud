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
import { createTestOrganization } from '@/tests/helpers/organization.helper';

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

    // Canonical = instance that already holds the subscription, even though it is
    // the newer of the two. Destroying the live-subscription instance and wiring
    // the row onto a stale empty one would be user-visibly wrong, so the script
    // prefers "has subscription" over "oldest" when choosing canonical.
    const emptyOlderInstanceId = crypto.randomUUID();
    const canonicalInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: emptyOlderInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${emptyOlderInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
      {
        id: canonicalInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${canonicalInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-02T00:00:00.000Z',
      },
    ]);

    const [canonicalSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: canonicalInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-04-02T00:00:00.000Z',
        updated_at: '2026-04-02T00:00:00.000Z',
      })
      .returning();

    if (!canonicalSubscription) {
      throw new Error('Expected canonical subscription row');
    }

    await run('apply-duplicates');

    const [olderInstance, canonicalInstance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id))
      .orderBy(kiloclaw_instances.created_at);

    expect(olderInstance?.id).toBe(emptyOlderInstanceId);
    expect(canonicalInstance?.id).toBe(canonicalInstanceId);
    expect(olderInstance?.destroyed_at).not.toBeNull();
    expect(canonicalInstance?.destroyed_at).toBeNull();

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);

    expect(subscriptions).toHaveLength(2);

    const retainedCanonical = subscriptions.find(
      subscription => subscription.id === canonicalSubscription.id
    );
    const replacement = subscriptions.find(
      subscription =>
        subscription.id !== canonicalSubscription.id &&
        subscription.instance_id === emptyOlderInstanceId
    );

    if (!replacement) {
      throw new Error('Expected replacement terminal subscription row on the destroyed duplicate');
    }

    expect(retainedCanonical?.instance_id).toBe(canonicalInstanceId);
    expect(replacement).toEqual(
      expect.objectContaining({
        user_id: user.id,
        instance_id: emptyOlderInstanceId,
        plan: 'trial',
        status: 'canceled',
      })
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

    // No reassignment should have happened because canonical already had the sub.
    const canonicalSubLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, canonicalSubscription.id));

    expect(
      canonicalSubLogs.find(log => log.reason === 'apply_duplicate_active_reassign_to_canonical')
    ).toBeUndefined();
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

  it('transfers reassign-destroyed subscription via successor pattern preserving predecessor history', async () => {
    const user = await insertTestUser({
      google_user_email: 'reassign-destroyed@example.com',
    });

    const destroyedInstanceId = crypto.randomUUID();
    const activeInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: destroyedInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${destroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-15T00:00:00.000Z',
      },
      {
        id: activeInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${activeInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ]);

    const [predecessorSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: destroyedInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        stripe_subscription_id: 'sub_reassign_test',
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
      })
      .returning();

    if (!predecessorSubscription) {
      throw new Error('Expected predecessor subscription row');
    }

    await run('apply-missing-personal');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);

    expect(subscriptions).toHaveLength(2);

    const predecessorAfter = subscriptions.find(
      subscription => subscription.id === predecessorSubscription.id
    );
    const successor = subscriptions.find(
      subscription => subscription.id !== predecessorSubscription.id
    );

    if (!successor) {
      throw new Error('Expected successor subscription row');
    }

    // Predecessor stays pinned to destroyed instance and is marked transferred.
    expect(predecessorAfter?.instance_id).toBe(destroyedInstanceId);
    expect(predecessorAfter?.status).toBe('canceled');
    expect(predecessorAfter?.transferred_to_subscription_id).toBe(successor.id);
    expect(predecessorAfter?.stripe_subscription_id).toBeNull();
    expect(predecessorAfter?.payment_source).toBe('credits');

    // Successor is a new row on the active instance, inheriting plan+stripe ownership.
    expect(successor.instance_id).toBe(activeInstanceId);
    expect(successor.status).toBe('active');
    expect(successor.plan).toBe('standard');
    expect(successor.stripe_subscription_id).toBe('sub_reassign_test');
    expect(successor.transferred_to_subscription_id).toBeNull();

    const predecessorLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, predecessorSubscription.id));

    expect(predecessorLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'reassigned',
          reason: 'apply_missing_personal_reassign_destroyed_predecessor',
        }),
      ])
    );

    const successorLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, successor.id));

    expect(successorLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'backfilled',
          reason: 'apply_missing_personal_reassign_destroyed_successor',
        }),
      ])
    );
  });

  it('does not bootstrap trial or earlybird rows for destroyed personal instances', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroyed-bootstrap@example.com',
    });
    const destroyedInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values({
      id: destroyedInstanceId,
      user_id: user.id,
      sandbox_id: `ki_${destroyedInstanceId.replaceAll('-', '')}`,
      created_at: '2026-04-01T00:00:00.000Z',
      destroyed_at: '2026-04-02T00:00:00.000Z',
    });

    await run('apply-missing-personal');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));

    expect(subscriptions).toHaveLength(0);
  });

  it('bootstraps personal trial even when user has org-context subscription', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-sub-holder@example.com',
    });
    const org = await createTestOrganization('test-org', user.id, 0);

    const orgInstanceId = crypto.randomUUID();
    const personalInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: orgInstanceId,
        user_id: user.id,
        organization_id: org.id,
        sandbox_id: `ki_${orgInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
      },
      {
        id: personalInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${personalInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ]);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: orgInstanceId,
      plan: 'standard',
      status: 'active',
      payment_source: 'credits',
      cancel_at_period_end: false,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    });

    await run('apply-missing-personal');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(subscriptions).toHaveLength(2);
    const personalSub = subscriptions.find(s => s.instance_id === personalInstanceId);
    const orgSub = subscriptions.find(s => s.instance_id === orgInstanceId);

    expect(orgSub?.status).toBe('active');
    expect(personalSub).toEqual(
      expect.objectContaining({
        user_id: user.id,
        instance_id: personalInstanceId,
        plan: 'trial',
      })
    );
  });

  it('backfills baseline snapshot for subscription that has only mutation logs', async () => {
    const user = await insertTestUser({
      google_user_email: 'mutation-only-logs@example.com',
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
      throw new Error('Expected subscription row');
    }

    // Simulate a legacy subscription created before changelog rollout whose only
    // log entries are post-creation mutations (before_state is non-null).
    await db.insert(kiloclaw_subscription_change_log).values({
      subscription_id: subscription.id,
      actor_type: 'system',
      actor_id: 'legacy-mutator',
      action: 'status_changed',
      reason: 'legacy_mutation',
      before_state: { ...subscription, status: 'trialing' },
      after_state: { ...subscription, status: 'past_due' },
    });

    await run('apply-changelog-baseline');

    const changeLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id))
      .orderBy(kiloclaw_subscription_change_log.created_at);

    const baselineLog = changeLogs.find(log => log.before_state === null);
    expect(baselineLog).toBeDefined();
    expect(baselineLog).toEqual(
      expect.objectContaining({
        action: 'backfilled',
        reason: 'baseline_subscription_snapshot',
      })
    );

    // Running again should be a no-op because a baseline now exists.
    await run('apply-changelog-baseline');
    const changeLogsAfterRerun = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));
    expect(changeLogsAfterRerun.filter(log => log.before_state === null)).toHaveLength(1);
  });
});
