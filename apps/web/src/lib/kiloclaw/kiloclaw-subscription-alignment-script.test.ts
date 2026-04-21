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

    await run('apply-duplicates', '--confirm-sandboxes-destroyed');

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

  it('backfills canceled terminal row for destroyed personal instance missing a sub row', async () => {
    const user = await insertTestUser({
      google_user_email: 'destroyed-terminal@example.com',
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

    // Destroyed missing-row instances get a terminal canceled trial row so
    // apply-missing-personal can clean up after admin-panel destroys.
    expect(subscriptions).toHaveLength(1);
    const terminal = subscriptions[0];
    expect(terminal).toEqual(
      expect.objectContaining({
        user_id: user.id,
        instance_id: destroyedInstanceId,
        plan: 'trial',
        status: 'canceled',
        payment_source: null,
      })
    );
    if (!terminal) {
      throw new Error('Expected terminal subscription row');
    }

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, terminal.id));

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'backfilled',
          reason: 'apply_missing_personal_backfill_destroyed_terminal',
        }),
      ])
    );

    // Second run is a no-op.
    await run('apply-missing-personal');
    const subscriptionsAfterRerun = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    expect(subscriptionsAfterRerun).toHaveLength(1);
  });

  it('collapses multi-row all-destroyed personal users into one current row', async () => {
    const user = await insertTestUser({
      google_user_email: 'multi-row-all-destroyed@example.com',
    });

    const instanceA = crypto.randomUUID();
    const instanceB = crypto.randomUUID();
    const instanceC = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: instanceA,
        user_id: user.id,
        sandbox_id: `ki_${instanceA.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-02T00:00:00.000Z',
      },
      {
        id: instanceB,
        user_id: user.id,
        sandbox_id: `ki_${instanceB.replaceAll('-', '')}`,
        created_at: '2026-03-05T00:00:00.000Z',
        destroyed_at: '2026-03-06T00:00:00.000Z',
      },
      {
        id: instanceC,
        user_id: user.id,
        sandbox_id: `ki_${instanceC.replaceAll('-', '')}`,
        created_at: '2026-03-10T00:00:00.000Z',
        destroyed_at: '2026-03-11T00:00:00.000Z',
      },
    ]);

    const [subscriptionA, subscriptionB, subscriptionC] = await db
      .insert(kiloclaw_subscriptions)
      .values([
        {
          user_id: user.id,
          instance_id: instanceA,
          plan: 'trial',
          status: 'canceled',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: instanceB,
          plan: 'standard',
          status: 'canceled',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-03-05T00:00:00.000Z',
          updated_at: '2026-03-05T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: instanceC,
          plan: 'standard',
          status: 'canceled',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
        },
      ])
      .returning();

    if (!subscriptionA || !subscriptionB || !subscriptionC) {
      throw new Error('Expected destroyed subscription rows');
    }

    await run('apply-multi-row-all-destroyed');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(subscriptions.map(subscription => subscription.transferred_to_subscription_id)).toEqual([
      subscriptionB.id,
      subscriptionC.id,
      null,
    ]);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.actor_id, 'kiloclaw-subscription-alignment'));

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'reassigned',
          reason: 'apply_multi_row_all_destroyed_collapse',
          subscription_id: subscriptionA.id,
        }),
        expect.objectContaining({
          action: 'reassigned',
          reason: 'apply_multi_row_all_destroyed_collapse',
          subscription_id: subscriptionB.id,
        }),
      ])
    );
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

  it('backfills baseline from earliest mutation before_state to preserve audit replay', async () => {
    const user = await insertTestUser({
      google_user_email: 'mutation-only-logs@example.com',
    });
    const instanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replaceAll('-', '')}`,
    });

    // Current state is a post-past_due row; the subscription's initial state
    // (captured in the earliest mutation's before_state) was still trialing.
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: instanceId,
        plan: 'trial',
        status: 'past_due',
        cancel_at_period_end: false,
        trial_started_at: '2026-04-01T00:00:00.000Z',
        trial_ends_at: '2026-04-08T00:00:00.000Z',
      })
      .returning();

    if (!subscription) {
      throw new Error('Expected subscription row');
    }

    const initialState = { ...subscription, status: 'trialing' };
    await db.insert(kiloclaw_subscription_change_log).values({
      subscription_id: subscription.id,
      actor_type: 'system',
      actor_id: 'legacy-mutator',
      action: 'status_changed',
      reason: 'legacy_mutation',
      created_at: '2026-04-05T00:00:00.000Z',
      before_state: initialState,
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
        reason: 'baseline_subscription_snapshot_from_earliest_mutation',
      })
    );
    // Baseline after_state MUST match the earliest mutation's before_state
    // (the true initial state) NOT the current post-mutation row state.
    expect(baselineLog?.after_state).toEqual(
      expect.objectContaining({ id: subscription.id, status: 'trialing' })
    );

    // Running again should be a no-op because a baseline now exists.
    await run('apply-changelog-baseline');
    const changeLogsAfterRerun = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));
    expect(changeLogsAfterRerun.filter(log => log.before_state === null)).toHaveLength(1);
  });

  it('stamps personal bootstrap trial with 7-day duration, not org 14-day', async () => {
    const user = await insertTestUser({
      google_user_email: 'personal-trial-7d@example.com',
    });
    const instanceId = crypto.randomUUID();
    const instanceCreatedAt = '2026-04-10T00:00:00.000Z';

    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replaceAll('-', '')}`,
      created_at: instanceCreatedAt,
    });

    await run('apply-missing-personal');

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instanceId));

    if (!subscription) {
      throw new Error('Expected bootstrapped trial row');
    }

    expect(subscription.plan).toBe('trial');
    if (!subscription.trial_started_at || !subscription.trial_ends_at) {
      throw new Error('Expected trial_started_at and trial_ends_at');
    }
    // 7 days duration. 14 would indicate the bug where org trial constant leaks
    // into the personal bootstrap path.
    const trialDurationMs =
      new Date(subscription.trial_ends_at).getTime() -
      new Date(subscription.trial_started_at).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(trialDurationMs).toBe(sevenDaysMs);
  });

  it('refuses to reassign destroyed sub when user already has live personal subscription', async () => {
    const user = await insertTestUser({
      google_user_email: 'two-personal-guard@example.com',
    });

    const destroyedInstanceId = crypto.randomUUID();
    const liveInstanceId = crypto.randomUUID();
    const missingInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: destroyedInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${destroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-15T00:00:00.000Z',
      },
      {
        id: liveInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${liveInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-20T00:00:00.000Z',
      },
      {
        id: missingInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${missingInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ]);

    // Destroyed instance has an access-granting legacy sub (would normally
    // trigger reassign_destroyed for the missing row).
    const [destroyedSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: destroyedInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
      })
      .returning();

    // Live instance already holds the user's current personal sub.
    const [liveSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: liveInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-03-20T00:00:00.000Z',
        updated_at: '2026-03-20T00:00:00.000Z',
      })
      .returning();

    if (!destroyedSub || !liveSub) {
      throw new Error('Expected seed subscription rows');
    }

    await run('apply-missing-personal');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    // MUST remain 2 rows; creating a successor on missingInstanceId would
    // yield two current personal subs for one user (spec violation).
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map(s => s.id).sort()).toEqual([destroyedSub.id, liveSub.id].sort());

    const destroyedAfter = subscriptions.find(s => s.id === destroyedSub.id);
    const liveAfter = subscriptions.find(s => s.id === liveSub.id);

    expect(destroyedAfter?.transferred_to_subscription_id).toBeNull();
    expect(destroyedAfter?.status).toBe('active');
    expect(liveAfter?.transferred_to_subscription_id).toBeNull();
    expect(liveAfter?.status).toBe('active');
  });

  it('refuses to write destroyed_at for duplicates without --confirm-sandboxes-destroyed flag', async () => {
    const user = await insertTestUser({
      google_user_email: 'no-confirm-flag@example.com',
    });
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

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: canonicalInstanceId,
      plan: 'standard',
      status: 'active',
      payment_source: 'stripe',
      cancel_at_period_end: false,
      created_at: '2026-04-02T00:00:00.000Z',
      updated_at: '2026-04-02T00:00:00.000Z',
    });

    await run('apply-duplicates');

    const instances = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id));

    // Neither instance touched without the confirm flag — operator must
    // externally verify sandbox teardown first.
    expect(instances.every(instance => instance.destroyed_at === null)).toBe(true);

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));

    // No terminal replacement inserted either.
    expect(subscriptions).toHaveLength(1);
  });

  it('ignores transferred-out rows when picking duplicate reassign targets', async () => {
    const user = await insertTestUser({
      google_user_email: 'duplicate-transferred@example.com',
    });

    // Canonical instance C has zero current subscriptions.
    // Duplicate instance D holds only a transferred-out predecessor (history).
    // The script MUST NOT treat D's historical row as a live sub; moving it
    // onto C would occupy the unique instance_id slot with a dead row and
    // wedge future repair.
    const canonicalInstanceId = crypto.randomUUID();
    const duplicateInstanceId = crypto.randomUUID();
    const transferredSuccessorId = crypto.randomUUID();

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

    // A live successor elsewhere (detached for this test — point is only that
    // it's referenced by transferred_to_subscription_id). Insert it detached
    // then reference it from the predecessor on the duplicate instance.
    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        id: transferredSuccessorId,
        user_id: user.id,
        instance_id: null,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-03-20T00:00:00.000Z',
        updated_at: '2026-03-20T00:00:00.000Z',
      })
      .returning();

    const [predecessor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: duplicateInstanceId,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        cancel_at_period_end: false,
        transferred_to_subscription_id: successor?.id,
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-20T00:00:00.000Z',
      })
      .returning();

    if (!predecessor || !successor) {
      throw new Error('Expected seed subscription rows');
    }

    await run('apply-duplicates', '--confirm-sandboxes-destroyed');

    const predecessorAfter = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, predecessor.id));

    // Predecessor MUST stay pinned to duplicateInstanceId (not moved to canonical).
    expect(predecessorAfter[0]?.instance_id).toBe(duplicateInstanceId);
    expect(predecessorAfter[0]?.transferred_to_subscription_id).toBe(successor.id);

    // Canonical still has no attached sub.
    const canonicalAttached = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, canonicalInstanceId));
    expect(canonicalAttached).toHaveLength(0);
  });

  it('backfills every active org orphan as managed-active regardless of seats/purchase', async () => {
    // Org billing has not rolled out. Every org instance gets managed-active
    // access as a free trial until paid org billing ships. Verifies that the
    // classifier ignores require_seats, oss_sponsorship_tier,
    // suppress_trial_messaging, and latest seat purchase status.
    const user = await insertTestUser({
      google_user_email: 'org-free-trial@example.com',
    });
    // require_seats=true + no active purchase would historically have
    // produced a trial row. Must now produce managed-active.
    const org = await createTestOrganization('test-org-free-trial', user.id, 0, {}, true);

    const orgInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values({
      id: orgInstanceId,
      user_id: user.id,
      organization_id: org.id,
      sandbox_id: `ki_${orgInstanceId.replaceAll('-', '')}`,
      created_at: '2026-04-01T00:00:00.000Z',
    });

    await run('apply-org');

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, orgInstanceId));

    if (!subscription) {
      throw new Error('Expected subscription row for org instance');
    }

    expect(subscription).toEqual(
      expect.objectContaining({
        user_id: user.id,
        instance_id: orgInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
    );

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'backfilled',
          reason: 'apply_org_backfill_active_standard_credits',
        }),
      ])
    );
  });

  it('repairs org replacement drift by transferring destroyed predecessor to live row', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-replacement-drift@example.com',
    });
    const organization = await createTestOrganization('org-replacement', user.id, 0);

    const destroyedInstanceId = crypto.randomUUID();
    const liveInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: destroyedInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${destroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-10T00:00:00.000Z',
      },
      {
        id: liveInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${liveInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ]);

    const [destroyedSubscription, liveSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values([
        {
          user_id: user.id,
          instance_id: destroyedInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: liveInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-01T00:00:00.000Z',
        },
      ])
      .returning();

    if (!destroyedSubscription || !liveSubscription) {
      throw new Error('Expected org subscription seed rows');
    }

    await run('apply-org-replacement');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    const destroyedAfter = subscriptions.find(
      subscription => subscription.id === destroyedSubscription.id
    );
    const liveAfter = subscriptions.find(subscription => subscription.id === liveSubscription.id);

    expect(destroyedAfter?.transferred_to_subscription_id).toBe(liveSubscription.id);
    expect(liveAfter?.transferred_to_subscription_id).toBeNull();

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, destroyedSubscription.id));

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'reassigned',
          reason: 'apply_org_replacement_transfer_destroyed_predecessor',
        }),
      ])
    );

    const metricsCall = (console.table as jest.Mock).mock.calls.find(
      ([rows]) => Array.isArray(rows) && rows.some(row => row.metric === 'orgs_succeeded')
    );
    expect(metricsCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'orgs_succeeded', count: 1 }),
        expect.objectContaining({ metric: 'orgs_skipped_no_work', count: 0 }),
        expect.objectContaining({ metric: 'orgs_skipped_race', count: 0 }),
        expect.objectContaining({ metric: 'orgs_error', count: 0 }),
      ])
    );
  });

  it('chains multiple destroyed org predecessors without violating transferred_to uniqueness', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-replacement-chain@example.com',
    });
    const organization = await createTestOrganization('org-replacement-chain', user.id, 0);

    const oldestDestroyedInstanceId = crypto.randomUUID();
    const newestDestroyedInstanceId = crypto.randomUUID();
    const liveInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: oldestDestroyedInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${oldestDestroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-02-01T00:00:00.000Z',
        destroyed_at: '2026-02-10T00:00:00.000Z',
      },
      {
        id: newestDestroyedInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${newestDestroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-10T00:00:00.000Z',
      },
      {
        id: liveInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${liveInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ]);

    const [oldestDestroyedSubscription, newestDestroyedSubscription, liveSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values([
        {
          user_id: user.id,
          instance_id: oldestDestroyedInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: newestDestroyedInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: liveInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-01T00:00:00.000Z',
        },
      ])
      .returning();

    if (!oldestDestroyedSubscription || !newestDestroyedSubscription || !liveSubscription) {
      throw new Error('Expected org chain seed rows');
    }

    await run('apply-org-replacement');

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at);

    expect(subscriptions.map(subscription => subscription.transferred_to_subscription_id)).toEqual([
      newestDestroyedSubscription.id,
      liveSubscription.id,
      null,
    ]);
  });

  it('skips cleanly when org replacement candidate is repaired concurrently', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-replacement-race@example.com',
    });
    const organization = await createTestOrganization('org-replacement-race', user.id, 0);

    const destroyedInstanceId = crypto.randomUUID();
    const liveInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: destroyedInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${destroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-10T00:00:00.000Z',
      },
      {
        id: liveInstanceId,
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `ki_${liveInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ]);

    const [destroyedSubscription, liveSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values([
        {
          user_id: user.id,
          instance_id: destroyedInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: liveInstanceId,
          plan: 'standard',
          status: 'active',
          payment_source: 'credits',
          cancel_at_period_end: false,
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-01T00:00:00.000Z',
        },
      ])
      .returning();

    if (!destroyedSubscription || !liveSubscription) {
      throw new Error('Expected org race seed rows');
    }

    const originalTransaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      await db
        .update(kiloclaw_subscriptions)
        .set({ transferred_to_subscription_id: liveSubscription.id })
        .where(eq(kiloclaw_subscriptions.id, destroyedSubscription.id));

      return await originalTransaction(callback);
    });

    await run('apply-org-replacement');

    const metricsCall = (console.table as jest.Mock).mock.calls.find(
      ([rows]) => Array.isArray(rows) && rows.some(row => row.metric === 'orgs_skipped_race')
    );
    expect(metricsCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'orgs_succeeded', count: 0 }),
        expect.objectContaining({ metric: 'orgs_skipped_no_work', count: 0 }),
        expect.objectContaining({ metric: 'orgs_skipped_race', count: 1 }),
        expect.objectContaining({ metric: 'orgs_error', count: 0 }),
      ])
    );
  });

  it('destroys duplicate instance whose only sub is a transferred predecessor', async () => {
    // Builder filters transferred rows from subscriptionsByInstanceId; the
    // apply existence checks must match. An instance holding only a
    // transferred-out predecessor has 0 current subs → builder classifies it
    // as a backfill_destroy_duplicate_personal target. Before this fix, the
    // apply existence check counted the transferred row as present and
    // silently skipped — leaving preview and apply forever disagreeing.
    const user = await insertTestUser({
      google_user_email: 'duplicate-with-transferred@example.com',
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

    // Canonical has a live current sub.
    const [canonicalSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: canonicalInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-01T00:00:00.000Z',
      })
      .returning();

    // Successor elsewhere (detached) so transferred_to points at a real row.
    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: null,
        plan: 'standard',
        status: 'active',
        payment_source: 'stripe',
        cancel_at_period_end: false,
        created_at: '2026-03-10T00:00:00.000Z',
        updated_at: '2026-03-10T00:00:00.000Z',
      })
      .returning();

    // Duplicate instance ONLY holds a transferred predecessor — runtime-invisible.
    const [duplicatePredecessor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: duplicateInstanceId,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        cancel_at_period_end: false,
        transferred_to_subscription_id: successor?.id,
        created_at: '2026-03-15T00:00:00.000Z',
        updated_at: '2026-03-15T00:00:00.000Z',
      })
      .returning();

    if (!canonicalSub || !successor || !duplicatePredecessor) {
      throw new Error('Expected seed subscription rows');
    }

    await run('apply-duplicates', '--confirm-sandboxes-destroyed');

    // Duplicate instance MUST have been destroyed with a canceled terminal
    // row inserted. Before the fix, apply silently skipped because the
    // existence check counted the transferred predecessor.
    const [duplicateInstanceAfter] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, duplicateInstanceId));
    expect(duplicateInstanceAfter?.destroyed_at).not.toBeNull();

    const duplicateRows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, duplicateInstanceId));

    // The transferred predecessor already satisfies the "every instance has
    // a sub row" invariant. The partial-unique index on instance_id prevents
    // inserting another row into that slot, so apply-duplicates destroys
    // the instance but skips the terminal insert — leaving the predecessor
    // in place.
    expect(duplicateRows).toHaveLength(1);
    const predecessorAfter = duplicateRows[0];
    expect(predecessorAfter?.id).toBe(duplicatePredecessor.id);
    expect(predecessorAfter?.transferred_to_subscription_id).toBe(successor.id);

    // Canonical instance untouched.
    const canonicalSubAfter = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, canonicalSub.id));
    expect(canonicalSubAfter[0]?.instance_id).toBe(canonicalInstanceId);
  });
});
