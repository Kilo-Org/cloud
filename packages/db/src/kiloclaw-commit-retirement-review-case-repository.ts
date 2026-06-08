import { and, eq, or, sql } from 'drizzle-orm';

import type { WorkerDb } from './client';
import { insertKiloClawSubscriptionChangeLog } from './kiloclaw-subscription-change-log';
import {
  kiloclaw_commit_retirement_review_cases,
  kiloclaw_subscriptions,
  type KiloClawCommitRetirementReviewCase,
} from './schema';
import {
  KiloClawCommitRetirementResolutionDisposition,
  KiloClawCommitRetirementReviewCaseStatus,
  KiloClawCommitRetirementState,
  KiloClawSubscriptionChangeAction,
  type KiloClawCommitRetirementResolutionActorType,
  type KiloClawCommitRetirementReviewReason,
  type KiloClawCommitRetirementResolutionDisposition as KiloClawCommitRetirementResolutionDispositionType,
  type KiloClawCommitRetirementReviewCaseStatus as KiloClawCommitRetirementReviewCaseStatusType,
  type KiloClawSubscriptionChangeActorType,
} from './schema-types';

export type CommitRetirementReviewCaseRepository = Pick<WorkerDb, 'insert' | 'select' | 'update'>;
export type TransactionalCommitRetirementReviewCaseRepository = Pick<WorkerDb, 'transaction'>;

export type CreateCommitRetirementReviewCaseInput = {
  dedupeKey: string;
  subscriptionId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeEventId?: string | null;
  reasonCode: KiloClawCommitRetirementReviewReason;
  summary: string;
};

export type ResolveCommitRetirementReviewCaseInput = {
  dedupeKey: string;
  status: Exclude<KiloClawCommitRetirementReviewCaseStatusType, 'open'>;
  disposition: KiloClawCommitRetirementResolutionDispositionType;
  actor: {
    type: KiloClawCommitRetirementResolutionActorType;
    id: string;
  };
  resolvedAt: string;
  reason: string;
};

export type ProviderCommitRetirementDispositionKey = {
  stripeSubscriptionId?: string | null;
  stripeEventId?: string | null;
};

export type ContainKnownSubscriptionCommitRetirementReviewInput =
  CreateCommitRetirementReviewCaseInput & {
    subscriptionId: string;
    actor: {
      type: KiloClawSubscriptionChangeActorType;
      id: string;
    };
  };

export async function containKnownSubscriptionCommitRetirementReview(
  database: TransactionalCommitRetirementReviewCaseRepository,
  input: ContainKnownSubscriptionCommitRetirementReviewInput
): Promise<KiloClawCommitRetirementReviewCase> {
  assertValidCreateInput(input);

  return database.transaction(async transaction => {
    const [subscription] = await transaction
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, input.subscriptionId))
      .for('update')
      .limit(1);

    if (!subscription) throw new Error('commit_retirement_review_subscription_missing');

    const [existingOpenCase] = await transaction
      .select()
      .from(kiloclaw_commit_retirement_review_cases)
      .where(
        and(
          eq(kiloclaw_commit_retirement_review_cases.subscription_id, input.subscriptionId),
          eq(
            kiloclaw_commit_retirement_review_cases.status,
            KiloClawCommitRetirementReviewCaseStatus.Open
          )
        )
      )
      .for('update')
      .limit(1);

    if (existingOpenCase && existingOpenCase.dedupe_key !== input.dedupeKey) {
      throw new Error('commit_retirement_review_subscription_has_different_open_case');
    }

    if (existingOpenCase) assertIdempotentCreateInput(existingOpenCase, input);
    const reviewCase =
      existingOpenCase ?? (await createCommitRetirementReviewCase(transaction, input));

    if (reviewCase.status !== KiloClawCommitRetirementReviewCaseStatus.Open) {
      throw new Error('commit_retirement_review_case_dedupe_key_not_open');
    }

    if (subscription.commit_retirement_state !== KiloClawCommitRetirementState.ManualReview) {
      const [updatedSubscription] = await transaction
        .update(kiloclaw_subscriptions)
        .set({
          commit_retirement_state: KiloClawCommitRetirementState.ManualReview,
          commit_retirement_review_reason: input.reasonCode,
        })
        .where(eq(kiloclaw_subscriptions.id, input.subscriptionId))
        .returning();

      if (!updatedSubscription)
        throw new Error('commit_retirement_review_subscription_update_failed');

      await insertKiloClawSubscriptionChangeLog(transaction, {
        subscriptionId: input.subscriptionId,
        actor: { actorType: input.actor.type, actorId: input.actor.id },
        action: KiloClawSubscriptionChangeAction.CommitRetirementChanged,
        reason: input.reasonCode,
        before: subscription,
        after: updatedSubscription,
      });
    } else if (subscription.commit_retirement_review_reason !== input.reasonCode) {
      throw new Error('commit_retirement_review_subscription_reason_mismatch');
    }

    return reviewCase;
  });
}

export async function createCommitRetirementReviewCase(
  database: CommitRetirementReviewCaseRepository,
  input: CreateCommitRetirementReviewCaseInput
): Promise<KiloClawCommitRetirementReviewCase> {
  assertValidCreateInput(input);

  const [created] = await database
    .insert(kiloclaw_commit_retirement_review_cases)
    .values({
      dedupe_key: input.dedupeKey,
      subscription_id: input.subscriptionId ?? null,
      stripe_subscription_id: input.stripeSubscriptionId ?? null,
      stripe_event_id: input.stripeEventId ?? null,
      reason_code: input.reasonCode,
      summary: input.summary,
      status: KiloClawCommitRetirementReviewCaseStatus.Open,
    })
    .onConflictDoNothing({ target: kiloclaw_commit_retirement_review_cases.dedupe_key })
    .returning();

  if (created) return created;

  const [existing] = await database
    .select()
    .from(kiloclaw_commit_retirement_review_cases)
    .where(eq(kiloclaw_commit_retirement_review_cases.dedupe_key, input.dedupeKey))
    .limit(1);

  if (!existing) throw new Error('commit_retirement_review_case_conflict_row_missing');
  assertIdempotentCreateInput(existing, input);
  return existing;
}

export async function findOpenCommitRetirementReviewCase(
  database: CommitRetirementReviewCaseRepository,
  subscriptionId: string
): Promise<KiloClawCommitRetirementReviewCase | null> {
  const [row] = await database
    .select()
    .from(kiloclaw_commit_retirement_review_cases)
    .where(
      and(
        eq(kiloclaw_commit_retirement_review_cases.subscription_id, subscriptionId),
        eq(
          kiloclaw_commit_retirement_review_cases.status,
          KiloClawCommitRetirementReviewCaseStatus.Open
        )
      )
    )
    .limit(1);

  return row ?? null;
}

export async function hasOpenCommitRetirementReviewCase(
  database: CommitRetirementReviewCaseRepository,
  subscriptionId: string
): Promise<boolean> {
  return (await findOpenCommitRetirementReviewCase(database, subscriptionId)) !== null;
}

export async function resolveCommitRetirementReviewCase(
  database: CommitRetirementReviewCaseRepository,
  input: ResolveCommitRetirementReviewCaseInput
): Promise<KiloClawCommitRetirementReviewCase | null> {
  if (!input.actor.id || !input.reason || input.reason.length > 500) {
    throw new Error('invalid_commit_retirement_review_case_resolution');
  }

  if (input.status === KiloClawCommitRetirementReviewCaseStatus.Dismissed) {
    if (input.disposition !== KiloClawCommitRetirementResolutionDisposition.DismissNoIssue) {
      throw new Error('dismissed_commit_retirement_review_case_requires_dismiss_disposition');
    }
  } else if (input.disposition === KiloClawCommitRetirementResolutionDisposition.DismissNoIssue) {
    throw new Error('dismiss_disposition_requires_dismissed_commit_retirement_review_case');
  }

  const [row] = await database
    .update(kiloclaw_commit_retirement_review_cases)
    .set({
      status: input.status,
      resolution_disposition: input.disposition,
      resolution_actor_type: input.actor.type,
      resolution_actor_id: input.actor.id,
      resolution_at: input.resolvedAt,
      resolution_reason: input.reason,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(kiloclaw_commit_retirement_review_cases.dedupe_key, input.dedupeKey),
        eq(
          kiloclaw_commit_retirement_review_cases.status,
          KiloClawCommitRetirementReviewCaseStatus.Open
        )
      )
    )
    .returning();

  return row ?? null;
}

export async function findProviderCommitRetirementDisposition(
  database: CommitRetirementReviewCaseRepository,
  key: ProviderCommitRetirementDispositionKey
): Promise<KiloClawCommitRetirementReviewCase | null> {
  if (!key.stripeSubscriptionId && !key.stripeEventId) {
    throw new Error('commit_retirement_provider_identifier_required');
  }

  const identifier = or(
    key.stripeSubscriptionId
      ? eq(kiloclaw_commit_retirement_review_cases.stripe_subscription_id, key.stripeSubscriptionId)
      : undefined,
    key.stripeEventId
      ? eq(kiloclaw_commit_retirement_review_cases.stripe_event_id, key.stripeEventId)
      : undefined
  );

  if (!identifier) throw new Error('commit_retirement_provider_identifier_required');

  const [row] = await database
    .select()
    .from(kiloclaw_commit_retirement_review_cases)
    .where(
      and(
        identifier,
        or(
          eq(
            kiloclaw_commit_retirement_review_cases.status,
            KiloClawCommitRetirementReviewCaseStatus.Open
          ),
          eq(
            kiloclaw_commit_retirement_review_cases.resolution_disposition,
            KiloClawCommitRetirementResolutionDisposition.DenyFutureCommit
          ),
          eq(
            kiloclaw_commit_retirement_review_cases.resolution_disposition,
            KiloClawCommitRetirementResolutionDisposition.RecognizePaidPeriodAsFinal
          ),
          eq(
            kiloclaw_commit_retirement_review_cases.resolution_disposition,
            KiloClawCommitRetirementResolutionDisposition.CancelSubscription
          ),
          eq(
            kiloclaw_commit_retirement_review_cases.resolution_disposition,
            KiloClawCommitRetirementResolutionDisposition.RefundAndCancel
          )
        )
      )
    )
    .orderBy(kiloclaw_commit_retirement_review_cases.created_at)
    .limit(1);

  return row ?? null;
}

function assertIdempotentCreateInput(
  existing: KiloClawCommitRetirementReviewCase,
  input: CreateCommitRetirementReviewCaseInput
): void {
  if (
    existing.subscription_id !== (input.subscriptionId ?? null) ||
    existing.stripe_subscription_id !== (input.stripeSubscriptionId ?? null) ||
    existing.stripe_event_id !== (input.stripeEventId ?? null) ||
    existing.reason_code !== input.reasonCode ||
    existing.summary !== input.summary
  ) {
    throw new Error('commit_retirement_review_case_dedupe_key_mismatch');
  }
}

function assertValidCreateInput(input: CreateCommitRetirementReviewCaseInput): void {
  if (
    !input.dedupeKey ||
    input.dedupeKey.length > 255 ||
    !/^[A-Za-z0-9:_-]+$/.test(input.dedupeKey)
  ) {
    throw new Error('invalid_commit_retirement_review_case_dedupe_key');
  }
  if (!input.subscriptionId && !input.stripeSubscriptionId && !input.stripeEventId) {
    throw new Error('commit_retirement_review_case_identifier_required');
  }
  if (!input.summary || input.summary.length > 500) {
    throw new Error('invalid_commit_retirement_review_case_summary');
  }
}
