import { afterAll, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';
import {
  containKnownSubscriptionCommitRetirementReview,
  createCommitRetirementReviewCase,
  findProviderCommitRetirementDisposition,
  resolveCommitRetirementReviewCase,
} from './kiloclaw-commit-retirement-review-case-repository';
import {
  kiloclaw_commit_retirement_review_cases,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  kilocode_users,
} from './schema';
import {
  KiloClawCommitRetirementResolutionActorType,
  KiloClawCommitRetirementResolutionDisposition,
  KiloClawCommitRetirementReviewCaseStatus,
  KiloClawCommitRetirementReviewReason,
  KiloClawCommitRetirementState,
  KiloClawPlan,
  KiloClawSubscriptionChangeActorType,
  KiloClawSubscriptionStatus,
} from './schema-types';

const testDatabase = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: { application_name: 'commit-retirement-review-case-test', max: 1 },
});

afterAll(async () => {
  await testDatabase.pool.end();
});

describe('KiloClaw Commit retirement review cases', () => {
  it('transactionally contains a known subscription and remains idempotent', async () => {
    const uniqueId = crypto.randomUUID();
    const userId = `commit-retirement-user-${uniqueId}`;
    const subscriptionId = crypto.randomUUID();
    const dedupeKey = `commit-retirement-known-${uniqueId}`;

    await testDatabase.db.insert(kilocode_users).values({
      id: userId,
      google_user_email: `${userId}@example.com`,
      google_user_name: 'Commit Retirement Test User',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_${uniqueId}`,
    });
    await testDatabase.db.insert(kiloclaw_subscriptions).values({
      id: subscriptionId,
      user_id: userId,
      kiloclaw_price_version: '2026-05-10',
      plan: KiloClawPlan.Commit,
      status: KiloClawSubscriptionStatus.Active,
    });

    const input = {
      dedupeKey,
      subscriptionId,
      reasonCode: KiloClawCommitRetirementReviewReason.ProviderOutcomeUnknown,
      summary: 'Provider outcome requires review',
      actor: { type: KiloClawSubscriptionChangeActorType.System, id: 'db-test' },
    };

    try {
      const created = await containKnownSubscriptionCommitRetirementReview(testDatabase.db, input);
      const duplicate = await containKnownSubscriptionCommitRetirementReview(
        testDatabase.db,
        input
      );
      expect(duplicate.id).toBe(created.id);

      const [subscription] = await testDatabase.db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, subscriptionId));
      expect(subscription?.commit_retirement_state).toBe(
        KiloClawCommitRetirementState.ManualReview
      );
      expect(subscription?.commit_retirement_review_reason).toBe(
        KiloClawCommitRetirementReviewReason.ProviderOutcomeUnknown
      );

      const changeLogs = await testDatabase.db
        .select()
        .from(kiloclaw_subscription_change_log)
        .where(eq(kiloclaw_subscription_change_log.subscription_id, subscriptionId));
      expect(changeLogs).toHaveLength(1);
      expect(changeLogs[0]?.action).toBe('commit_retirement_changed');
    } finally {
      await testDatabase.db
        .delete(kiloclaw_subscription_change_log)
        .where(eq(kiloclaw_subscription_change_log.subscription_id, subscriptionId));
      await testDatabase.db
        .delete(kiloclaw_commit_retirement_review_cases)
        .where(eq(kiloclaw_commit_retirement_review_cases.dedupe_key, dedupeKey));
      await testDatabase.db
        .delete(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, subscriptionId));
      await testDatabase.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });

  it('rejects a mismatched duplicate dedupe key', async () => {
    const dedupeKey = `commit-retirement-mismatch-${crypto.randomUUID()}`;
    const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;

    try {
      await createCommitRetirementReviewCase(testDatabase.db, {
        dedupeKey,
        stripeSubscriptionId,
        reasonCode: KiloClawCommitRetirementReviewReason.ProviderOutcomeUnknown,
        summary: 'Provider outcome requires review',
      });

      await expect(
        createCommitRetirementReviewCase(testDatabase.db, {
          dedupeKey,
          stripeSubscriptionId,
          reasonCode: KiloClawCommitRetirementReviewReason.ProviderStateMismatch,
          summary: 'Different incident must not reuse dedupe key',
        })
      ).rejects.toThrow('commit_retirement_review_case_dedupe_key_mismatch');
    } finally {
      await testDatabase.db
        .delete(kiloclaw_commit_retirement_review_cases)
        .where(eq(kiloclaw_commit_retirement_review_cases.dedupe_key, dedupeKey));
    }
  });

  it('rejects provider disposition lookup without an identifier', async () => {
    await expect(findProviderCommitRetirementDisposition(testDatabase.db, {})).rejects.toThrow(
      'commit_retirement_provider_identifier_required'
    );
  });

  it('creates idempotently and preserves provider disposition after resolution', async () => {
    const dedupeKey = `commit-retirement-test-${crypto.randomUUID()}`;
    const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;

    try {
      const input = {
        dedupeKey,
        stripeSubscriptionId,
        reasonCode: KiloClawCommitRetirementReviewReason.UnqualifiedPostCutoffCommit,
        summary: 'Post-cutoff Commit provider subscription requires review',
      };
      const created = await createCommitRetirementReviewCase(testDatabase.db, input);
      const duplicate = await createCommitRetirementReviewCase(testDatabase.db, input);
      expect(duplicate.id).toBe(created.id);

      await resolveCommitRetirementReviewCase(testDatabase.db, {
        dedupeKey,
        status: KiloClawCommitRetirementReviewCaseStatus.Resolved,
        disposition: KiloClawCommitRetirementResolutionDisposition.DenyFutureCommit,
        actor: { type: KiloClawCommitRetirementResolutionActorType.System, id: 'db-test' },
        resolvedAt: '2026-06-06T01:00:00.000Z',
        reason: 'Provider subscription must not authorize another Commit term',
      });

      const disposition = await findProviderCommitRetirementDisposition(testDatabase.db, {
        stripeSubscriptionId,
      });
      expect(disposition?.resolution_disposition).toBe(
        KiloClawCommitRetirementResolutionDisposition.DenyFutureCommit
      );

      const unknownStripeSubscriptionId = `sub_${crypto.randomUUID()}`;
      expect(
        await findProviderCommitRetirementDisposition(testDatabase.db, {
          stripeSubscriptionId: unknownStripeSubscriptionId,
        })
      ).toBeNull();
      expect(
        await findProviderCommitRetirementDisposition(testDatabase.db, {
          stripeSubscriptionId: unknownStripeSubscriptionId,
          stripeEventId: `evt_${crypto.randomUUID()}`,
        })
      ).toBeNull();
    } finally {
      await testDatabase.db
        .delete(kiloclaw_commit_retirement_review_cases)
        .where(eq(kiloclaw_commit_retirement_review_cases.dedupe_key, dedupeKey));
    }
  });
});
