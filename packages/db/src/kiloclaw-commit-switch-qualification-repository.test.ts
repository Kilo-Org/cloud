import { afterAll, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';
import {
  KILOCLAW_COMMIT_SALES_CUTOFF,
  KiloClawCommitRetirementQualificationSource,
} from './kiloclaw-commit-retirement';
import { findLatestPreCutoffUserCommitSwitchQualification } from './kiloclaw-commit-switch-qualification-repository';
import { kiloclaw_subscription_change_log, kiloclaw_subscriptions, kilocode_users } from './schema';
import { KiloClawPlan, KiloClawSubscriptionStatus } from './schema-types';

const testDatabase = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: { application_name: 'commit-switch-qualification-test', max: 1 },
});

const testRows: string[] = [];
const testUsers: string[] = [];

async function createSubscription(): Promise<{ subscriptionId: string; userId: string }> {
  const uniqueId = crypto.randomUUID();
  const userId = `commit-switch-qualification-${uniqueId}`;
  const subscriptionId = crypto.randomUUID();
  testRows.push(subscriptionId);
  testUsers.push(userId);

  await testDatabase.db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Commit Switch Qualification Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${uniqueId}`,
  });
  await testDatabase.db.insert(kiloclaw_subscriptions).values({
    id: subscriptionId,
    user_id: userId,
    kiloclaw_price_version: '2026-05-10',
    plan: KiloClawPlan.Standard,
    status: KiloClawSubscriptionStatus.Active,
  });

  return { subscriptionId, userId };
}

async function insertScheduleChange(input: {
  subscriptionId: string;
  createdAt: string;
  actorType?: 'user' | 'system';
  beforeScheduledPlan?: string | null;
  afterScheduledPlan?: string | null;
}): Promise<void> {
  await testDatabase.db.insert(kiloclaw_subscription_change_log).values({
    subscription_id: input.subscriptionId,
    created_at: input.createdAt,
    actor_type: input.actorType ?? 'user',
    actor_id: 'qualification-test',
    action: 'schedule_changed',
    reason: 'user_requested_plan_switch',
    before_state: { scheduled_plan: input.beforeScheduledPlan ?? null },
    after_state: { scheduled_plan: input.afterScheduledPlan ?? null },
  });
}

afterAll(async () => {
  for (const subscriptionId of testRows) {
    await testDatabase.db
      .update(kiloclaw_subscriptions)
      .set({ transferred_to_subscription_id: null })
      .where(eq(kiloclaw_subscriptions.id, subscriptionId));
  }
  for (const subscriptionId of testRows) {
    await testDatabase.db
      .delete(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscriptionId));
    await testDatabase.db
      .delete(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscriptionId));
  }
  for (const userId of testUsers) {
    await testDatabase.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
  await testDatabase.pool.end();
});

describe('Commit switch qualification repository', () => {
  it('returns latest valid user transition to Commit before cutoff', async () => {
    const { subscriptionId } = await createSubscription();
    await insertScheduleChange({
      subscriptionId,
      createdAt: '2026-06-05T23:59:59.998Z',
      afterScheduledPlan: 'commit',
    });
    await insertScheduleChange({
      subscriptionId,
      createdAt: '2026-06-05T23:59:59.999Z',
      afterScheduledPlan: 'commit',
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toEqual({
      qualifiedAt: '2026-06-05T23:59:59.999Z',
      qualificationSource: KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
    });
  });

  it('finds canonical switch evidence on a transferred predecessor', async () => {
    const { subscriptionId, userId } = await createSubscription();
    await insertScheduleChange({
      subscriptionId,
      createdAt: '2026-06-05T23:59:59.999Z',
      afterScheduledPlan: 'commit',
    });

    const successorId = crypto.randomUUID();
    testRows.push(successorId);
    await testDatabase.db.insert(kiloclaw_subscriptions).values({
      id: successorId,
      user_id: userId,
      kiloclaw_price_version: '2026-05-10',
      plan: KiloClawPlan.Standard,
      status: KiloClawSubscriptionStatus.Active,
    });
    await testDatabase.db
      .update(kiloclaw_subscriptions)
      .set({ transferred_to_subscription_id: successorId })
      .where(eq(kiloclaw_subscriptions.id, subscriptionId));

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, successorId)
    ).resolves.toEqual({
      qualifiedAt: '2026-06-05T23:59:59.999Z',
      qualificationSource: KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
    });
  });

  it('excludes transition exactly at cutoff', async () => {
    const { subscriptionId } = await createSubscription();
    await insertScheduleChange({
      subscriptionId,
      createdAt: KILOCLAW_COMMIT_SALES_CUTOFF,
      afterScheduledPlan: 'commit',
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });

  it('returns null when evidence is missing', async () => {
    const { subscriptionId } = await createSubscription();

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });

  it('excludes non-user and non-transition schedule changes', async () => {
    const { subscriptionId } = await createSubscription();
    await insertScheduleChange({
      subscriptionId,
      createdAt: '2026-06-05T23:59:59.997Z',
      actorType: 'system',
      afterScheduledPlan: 'commit',
    });
    await insertScheduleChange({
      subscriptionId,
      createdAt: '2026-06-05T23:59:59.998Z',
      beforeScheduledPlan: 'commit',
      afterScheduledPlan: 'commit',
    });
    await insertScheduleChange({
      subscriptionId,
      createdAt: '2026-06-05T23:59:59.999Z',
      afterScheduledPlan: 'standard',
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });
});
