import { beforeEach, describe, expect, it } from '@jest/globals';
import { and, eq, inArray } from 'drizzle-orm';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { bootstrapProvisionSubscriptionWithDb } from '../../../../../services/kiloclaw-billing/src/provision-bootstrap-shared';

const BOOTSTRAP_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-billing-bootstrap',
} as const;

describe('bootstrapProvisionSubscriptionWithDb organization replacement', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('transfers destroyed org predecessors to the new live row without touching personal or other-org rows', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-bootstrap-replacement@example.com',
    });
    const primaryOrg = await createTestOrganization('Primary Org', user.id, 0);
    const otherOrg = await createTestOrganization('Other Org', user.id, 0);

    const personalInstanceId = crypto.randomUUID();
    const primaryDestroyedInstanceId = crypto.randomUUID();
    const primaryLiveInstanceId = crypto.randomUUID();
    const otherOrgDestroyedInstanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values([
      {
        id: personalInstanceId,
        user_id: user.id,
        sandbox_id: `ki_${personalInstanceId.replaceAll('-', '')}`,
        created_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: primaryDestroyedInstanceId,
        user_id: user.id,
        organization_id: primaryOrg.id,
        sandbox_id: `ki_${primaryDestroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-01T00:00:00.000Z',
        destroyed_at: '2026-03-10T00:00:00.000Z',
      },
      {
        id: primaryLiveInstanceId,
        user_id: user.id,
        organization_id: primaryOrg.id,
        sandbox_id: `ki_${primaryLiveInstanceId.replaceAll('-', '')}`,
        created_at: '2026-04-01T00:00:00.000Z',
      },
      {
        id: otherOrgDestroyedInstanceId,
        user_id: user.id,
        organization_id: otherOrg.id,
        sandbox_id: `ki_${otherOrgDestroyedInstanceId.replaceAll('-', '')}`,
        created_at: '2026-03-15T00:00:00.000Z',
        destroyed_at: '2026-03-20T00:00:00.000Z',
      },
    ]);

    const [personalSubscription, primaryDestroyedSubscription, otherOrgDestroyedSubscription] =
      await db
        .insert(kiloclaw_subscriptions)
        .values([
          {
            user_id: user.id,
            instance_id: personalInstanceId,
            plan: 'trial',
            status: 'canceled',
            cancel_at_period_end: false,
            trial_started_at: '2026-02-01T00:00:00.000Z',
            trial_ends_at: '2026-02-08T00:00:00.000Z',
            created_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-08T00:00:00.000Z',
          },
          {
            user_id: user.id,
            instance_id: primaryDestroyedInstanceId,
            plan: 'standard',
            status: 'active',
            payment_source: 'credits',
            cancel_at_period_end: false,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
          },
          {
            user_id: user.id,
            instance_id: otherOrgDestroyedInstanceId,
            plan: 'standard',
            status: 'active',
            payment_source: 'credits',
            cancel_at_period_end: false,
            created_at: '2026-03-15T00:00:00.000Z',
            updated_at: '2026-03-15T00:00:00.000Z',
          },
        ])
        .returning();

    if (!personalSubscription || !primaryDestroyedSubscription || !otherOrgDestroyedSubscription) {
      throw new Error('Expected seed subscription rows');
    }

    const created = await bootstrapProvisionSubscriptionWithDb({
      db,
      input: {
        userId: user.id,
        instanceId: primaryLiveInstanceId,
        orgId: primaryOrg.id,
      },
      actor: BOOTSTRAP_ACTOR,
    });

    expect(created).toEqual(
      expect.objectContaining({
        user_id: user.id,
        instance_id: primaryLiveInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
      })
    );

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));

    const personalAfter = subscriptions.find(
      subscription => subscription.id === personalSubscription.id
    );
    const primaryDestroyedAfter = subscriptions.find(
      subscription => subscription.id === primaryDestroyedSubscription.id
    );
    const primaryLiveAfter = subscriptions.find(subscription => subscription.id === created.id);
    const otherOrgAfter = subscriptions.find(
      subscription => subscription.id === otherOrgDestroyedSubscription.id
    );

    expect(personalAfter?.transferred_to_subscription_id).toBeNull();
    expect(personalAfter?.status).toBe('canceled');
    expect(primaryDestroyedAfter?.transferred_to_subscription_id).toBe(created.id);
    expect(primaryLiveAfter?.transferred_to_subscription_id).toBeNull();
    expect(otherOrgAfter?.transferred_to_subscription_id).toBeNull();

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(
        inArray(kiloclaw_subscription_change_log.subscription_id, [
          primaryDestroyedSubscription.id,
          created.id,
        ])
      );

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subscription_id: primaryDestroyedSubscription.id,
          actor_id: BOOTSTRAP_ACTOR.actorId,
          action: 'reassigned',
          reason: 'org_provision_transfer_destroyed_predecessor',
        }),
        expect.objectContaining({
          subscription_id: created.id,
          actor_id: BOOTSTRAP_ACTOR.actorId,
          action: 'created',
          reason: 'org_provision_managed',
        }),
      ])
    );
  });

  it('chains multiple destroyed org predecessors onto the live successor row', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-bootstrap-chain@example.com',
    });
    const organization = await createTestOrganization('Chain Org', user.id, 0);

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

    const [oldestDestroyedSubscription, newestDestroyedSubscription] = await db
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
      ])
      .returning();

    if (!oldestDestroyedSubscription || !newestDestroyedSubscription) {
      throw new Error('Expected destroyed predecessor rows');
    }

    const created = await bootstrapProvisionSubscriptionWithDb({
      db,
      input: {
        userId: user.id,
        instanceId: liveInstanceId,
        orgId: organization.id,
      },
      actor: BOOTSTRAP_ACTOR,
    });

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);

    expect(subscriptions.map(subscription => subscription.transferred_to_subscription_id)).toEqual([
      newestDestroyedSubscription.id,
      created.id,
      null,
    ]);
  });

  it('is idempotent when bootstrap is repeated for the same live org instance', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-bootstrap-idempotent@example.com',
    });
    const organization = await createTestOrganization('Idempotent Org', user.id, 0);

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

    const [destroyedSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: destroyedInstanceId,
        plan: 'standard',
        status: 'active',
        payment_source: 'credits',
        cancel_at_period_end: false,
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
      })
      .returning();

    if (!destroyedSubscription) {
      throw new Error('Expected destroyed predecessor row');
    }

    const first = await bootstrapProvisionSubscriptionWithDb({
      db,
      input: {
        userId: user.id,
        instanceId: liveInstanceId,
        orgId: organization.id,
      },
      actor: BOOTSTRAP_ACTOR,
    });

    const second = await bootstrapProvisionSubscriptionWithDb({
      db,
      input: {
        userId: user.id,
        instanceId: liveInstanceId,
        orgId: organization.id,
      },
      actor: BOOTSTRAP_ACTOR,
    });

    expect(second.id).toBe(first.id);

    const subscriptions = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    expect(subscriptions).toHaveLength(2);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(
        and(
          eq(kiloclaw_subscription_change_log.actor_id, BOOTSTRAP_ACTOR.actorId),
          inArray(kiloclaw_subscription_change_log.subscription_id, [
            destroyedSubscription.id,
            first.id,
          ])
        )
      );

    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subscription_id: destroyedSubscription.id,
          action: 'reassigned',
          reason: 'org_provision_transfer_destroyed_predecessor',
        }),
        expect.objectContaining({
          subscription_id: first.id,
          action: 'created',
          reason: 'org_provision_managed',
        }),
      ])
    );
  });
});
