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

async function insertLifecycleState(input: {
  subscriptionId: string;
  createdAt: string;
  actorType?: 'user' | 'system';
  actorId?: string;
  reason?: string;
  beforeScheduledPlan?: string | null;
  afterScheduledPlan?: string | null;
  beforeScheduledBy?: string | null;
  afterScheduledBy?: string | null;
}): Promise<void> {
  await testDatabase.db.insert(kiloclaw_subscription_change_log).values({
    subscription_id: input.subscriptionId,
    created_at: input.createdAt,
    actor_type: input.actorType ?? 'system',
    actor_id: input.actorId ?? 'billing-lifecycle-job',
    action: 'status_changed',
    reason: input.reason ?? 'credit_renewal_insufficient_credits',
    before_state: {
      scheduled_plan: input.beforeScheduledPlan ?? 'commit',
      scheduled_by: input.beforeScheduledBy ?? 'user',
    },
    after_state: {
      scheduled_plan: input.afterScheduledPlan ?? 'commit',
      scheduled_by: input.afterScheduledBy ?? 'user',
    },
  });
}

async function insertAlignmentBaseline(input: {
  subscriptionId: string;
  createdAt: string;
  reason?: string;
  actorId?: string;
  beforeState?: Record<string, unknown> | null;
  scheduledPlan?: string | null;
  scheduledBy?: string | null;
}): Promise<void> {
  await testDatabase.db.insert(kiloclaw_subscription_change_log).values({
    subscription_id: input.subscriptionId,
    created_at: input.createdAt,
    actor_type: 'system',
    actor_id: input.actorId ?? 'kiloclaw-subscription-alignment',
    action: 'backfilled',
    reason: input.reason ?? 'baseline_subscription_snapshot',
    before_state: input.beforeState ?? null,
    after_state: {
      scheduled_plan: input.scheduledPlan ?? 'commit',
      scheduled_by: input.scheduledBy ?? 'user',
    },
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

  it.each([
    'baseline_subscription_snapshot',
    'baseline_subscription_snapshot_from_earliest_mutation',
  ])('accepts pre-cutoff alignment evidence from %s', async reason => {
    const { subscriptionId } = await createSubscription();
    await insertAlignmentBaseline({
      subscriptionId,
      createdAt: '2026-04-17T20:09:06.862Z',
      reason,
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toEqual({
      qualifiedAt: '2026-04-17T20:09:06.862Z',
      qualificationSource: KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
    });
  });

  it('accepts preserved user-scheduled Commit state from pre-cutoff insufficient-credit renewal', async () => {
    const { subscriptionId } = await createSubscription();
    await insertLifecycleState({
      subscriptionId,
      createdAt: '2026-05-19T05:02:30.929Z',
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toEqual({
      qualifiedAt: '2026-05-19T05:02:30.929Z',
      qualificationSource: KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
    });
  });

  it.each([
    { description: 'wrong actor type', actorType: 'user' as const },
    { description: 'wrong actor ID', actorId: 'another-system' },
    { description: 'wrong reason', reason: 'another_reason' },
    { description: 'wrong previous plan', beforeScheduledPlan: 'standard' },
    { description: 'wrong resulting plan', afterScheduledPlan: 'standard' },
    { description: 'wrong previous scheduler', beforeScheduledBy: 'system' },
    { description: 'wrong resulting scheduler', afterScheduledBy: 'system' },
  ])('excludes non-canonical lifecycle evidence: $description', async evidence => {
    const { subscriptionId } = await createSubscription();
    await insertLifecycleState({
      subscriptionId,
      createdAt: '2026-05-19T05:02:30.929Z',
      ...evidence,
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });

  it('excludes lifecycle evidence exactly at cutoff', async () => {
    const { subscriptionId } = await createSubscription();
    await insertLifecycleState({
      subscriptionId,
      createdAt: KILOCLAW_COMMIT_SALES_CUTOFF,
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });

  it('excludes alignment baseline exactly at cutoff', async () => {
    const { subscriptionId } = await createSubscription();
    await insertAlignmentBaseline({
      subscriptionId,
      createdAt: KILOCLAW_COMMIT_SALES_CUTOFF,
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });

  it.each([
    {
      description: 'wrong actor ID',
      actorId: 'another-system',
      reason: 'baseline_subscription_snapshot',
    },
    {
      description: 'wrong reason',
      actorId: 'kiloclaw-subscription-alignment',
      reason: 'another_reason',
    },
    {
      description: 'non-null before state',
      beforeState: { scheduled_plan: 'standard' },
    },
  ])('excludes non-canonical alignment evidence: $description', async evidence => {
    const { subscriptionId } = await createSubscription();
    await insertAlignmentBaseline({
      subscriptionId,
      createdAt: '2026-04-17T20:09:06.862Z',
      ...evidence,
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
  });

  it.each([
    { scheduledPlan: 'standard', scheduledBy: 'user' },
    { scheduledPlan: 'commit', scheduledBy: 'system' },
  ])('excludes alignment baseline without user-scheduled Commit state', async evidence => {
    const { subscriptionId } = await createSubscription();
    await insertAlignmentBaseline({
      subscriptionId,
      createdAt: '2026-04-17T20:09:06.862Z',
      ...evidence,
    });

    await expect(
      findLatestPreCutoffUserCommitSwitchQualification(testDatabase.db, subscriptionId)
    ).resolves.toBeNull();
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
