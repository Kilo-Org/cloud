import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import pLimit from 'p-limit';
import * as z from 'zod';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { client as stripeClient } from '@/lib/stripe-client';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  insertKiloClawSubscriptionChangeLog,
  KiloClawCommitRetirementResolutionDisposition,
  KiloClawCommitRetirementReviewCaseStatus,
  resolveCommitRetirementReviewCase,
  type KiloClawCommitRetirementReviewCase,
  type KiloClawSubscription,
} from '@kilocode/db';
import {
  kiloclaw_commit_retirement_review_cases,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';

const ProviderSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscription'),
    id: z.string(),
    status: z.string(),
    currentPeriodEnd: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    scheduleId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('event'),
    id: z.string(),
    type: z.string(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal('none'),
  }),
  z.object({
    kind: z.literal('error'),
    id: z.string(),
    code: z.literal('provider_retrieval_failed'),
  }),
]);

type ProviderSnapshot = z.infer<typeof ProviderSnapshotSchema>;

const PROVIDER_SNAPSHOT_CONCURRENCY = 5;

const ReviewStatusSchema = z.enum(['open', 'resolved', 'dismissed', 'all']);

const ListReviewCasesCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

const ListReviewCasesSchema = z.object({
  status: ReviewStatusSchema.default('open'),
  userId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: ListReviewCasesCursorSchema.optional(),
});

const StaleSafeReviewInputSchema = z.object({
  caseId: z.string().uuid(),
  expectedCaseUpdatedAt: z.string().datetime(),
  expectedSubscriptionUpdatedAt: z.string().datetime().nullable(),
  expectedFinalBoundary: z.string().datetime().nullable(),
  expectedProvider: ProviderSnapshotSchema,
  reason: z.string().trim().min(1).max(500),
});

const ResolveReviewCaseSchema = StaleSafeReviewInputSchema.extend({
  disposition: z.enum(['deny_future_commit', 'recognize_paid_period_as_final']),
});

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function subscriptionScheduleId(schedule: string | { id: string } | null): string | null {
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

async function readProviderSnapshot(params: {
  stripeSubscriptionId: string | null;
  stripeEventId: string | null;
}): Promise<ProviderSnapshot> {
  if (params.stripeSubscriptionId) {
    try {
      const subscription = await stripeClient.subscriptions.retrieve(params.stripeSubscriptionId);
      const item = subscription.items.data[0];
      return {
        kind: 'subscription',
        id: subscription.id,
        status: subscription.status,
        currentPeriodEnd: item ? new Date(item.current_period_end * 1000).toISOString() : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        scheduleId: subscriptionScheduleId(subscription.schedule),
      };
    } catch {
      return {
        kind: 'error',
        id: params.stripeSubscriptionId,
        code: 'provider_retrieval_failed',
      };
    }
  }

  if (params.stripeEventId) {
    try {
      const event = await stripeClient.events.retrieve(params.stripeEventId);
      return {
        kind: 'event',
        id: event.id,
        type: event.type,
        createdAt: new Date(event.created * 1000).toISOString(),
      };
    } catch {
      return {
        kind: 'error',
        id: params.stripeEventId,
        code: 'provider_retrieval_failed',
      };
    }
  }

  return { kind: 'none' };
}

function providerSnapshotsMatch(expected: ProviderSnapshot, actual: ProviderSnapshot): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function assertExpectedLocalState(params: {
  reviewCase: KiloClawCommitRetirementReviewCase;
  subscription: KiloClawSubscription | null;
  expectedCaseUpdatedAt: string;
  expectedSubscriptionUpdatedAt: string | null;
  expectedFinalBoundary: string | null;
}) {
  const caseUpdatedAt = normalizeTimestamp(params.reviewCase.updated_at);
  const subscriptionUpdatedAt = normalizeTimestamp(params.subscription?.updated_at);
  const finalBoundary = normalizeTimestamp(params.subscription?.commit_retirement_final_ends_at);

  if (
    params.reviewCase.status !== KiloClawCommitRetirementReviewCaseStatus.Open ||
    caseUpdatedAt !== params.expectedCaseUpdatedAt ||
    subscriptionUpdatedAt !== params.expectedSubscriptionUpdatedAt ||
    finalBoundary !== params.expectedFinalBoundary
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Retirement review state changed. Refresh the case before resolving it.',
    });
  }
}

async function lockReviewCase(tx: DrizzleTransaction, caseId: string) {
  const [reviewCase] = await tx
    .select()
    .from(kiloclaw_commit_retirement_review_cases)
    .where(eq(kiloclaw_commit_retirement_review_cases.id, caseId))
    .for('update')
    .limit(1);

  if (!reviewCase) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Retirement review case not found' });
  }

  return reviewCase;
}

async function lockReviewSubscription(tx: DrizzleTransaction, subscriptionId: string | null) {
  if (!subscriptionId) return null;

  const [subscription] = await tx
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.id, subscriptionId))
    .for('update')
    .limit(1);

  if (!subscription) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Review case subscription no longer exists. Refresh the case before resolving it.',
    });
  }

  return subscription;
}

function safeFinalBoundary(params: {
  subscription: KiloClawSubscription;
  provider: ProviderSnapshot;
}): string | null {
  if (params.provider.kind === 'subscription') return params.provider.currentPeriodEnd;
  return normalizeTimestamp(
    params.subscription.current_period_end ??
      params.subscription.credit_renewal_at ??
      params.subscription.commit_retirement_final_ends_at
  );
}

async function makeProviderNonRenewing(provider: ProviderSnapshot): Promise<void> {
  if (provider.kind !== 'subscription') return;
  if (provider.scheduleId) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Provider subscription still has a schedule. Reconcile the schedule before resolving this case.',
    });
  }
  if (provider.status === 'canceled' || provider.cancelAtPeriodEnd) return;

  await stripeClient.subscriptions.update(provider.id, { cancel_at_period_end: true });
}

async function revalidateProvider(params: {
  reviewCase: KiloClawCommitRetirementReviewCase;
  expected: ProviderSnapshot;
}): Promise<ProviderSnapshot> {
  const provider = await readProviderSnapshot({
    stripeSubscriptionId: params.reviewCase.stripe_subscription_id,
    stripeEventId: params.reviewCase.stripe_event_id,
  });
  if (provider.kind === 'error') {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Provider state could not be read. No review-case changes were made.',
    });
  }
  if (!providerSnapshotsMatch(params.expected, provider)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Provider state changed. Refresh the case before resolving it.',
    });
  }
  return provider;
}

export const adminCommitRetirementReviewsRouter = createTRPCRouter({
  list: adminProcedure.input(ListReviewCasesSchema).query(async ({ input }) => {
    const cursorFilter = input.cursor
      ? or(
          lt(kiloclaw_commit_retirement_review_cases.created_at, input.cursor.createdAt),
          and(
            eq(kiloclaw_commit_retirement_review_cases.created_at, input.cursor.createdAt),
            lt(kiloclaw_commit_retirement_review_cases.id, input.cursor.id)
          )
        )
      : undefined;
    const filters = [
      input.status === 'all'
        ? undefined
        : eq(kiloclaw_commit_retirement_review_cases.status, input.status),
      input.userId ? eq(kiloclaw_subscriptions.user_id, input.userId) : undefined,
      cursorFilter,
    ].filter(filter => filter !== undefined);

    const rows = await db
      .select({
        reviewCase: kiloclaw_commit_retirement_review_cases,
        subscription: kiloclaw_subscriptions,
        userId: kiloclaw_subscriptions.user_id,
      })
      .from(kiloclaw_commit_retirement_review_cases)
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_subscriptions.id, kiloclaw_commit_retirement_review_cases.subscription_id)
      )
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        desc(kiloclaw_commit_retirement_review_cases.created_at),
        desc(kiloclaw_commit_retirement_review_cases.id)
      )
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const limitProviderSnapshot = pLimit(PROVIDER_SNAPSHOT_CONCURRENCY);
    const reviewCases = await Promise.all(
      pageRows.map(row =>
        limitProviderSnapshot(async () => ({
          ...row,
          provider: await readProviderSnapshot({
            stripeSubscriptionId: row.reviewCase.stripe_subscription_id,
            stripeEventId: row.reviewCase.stripe_event_id,
          }),
        }))
      )
    );
    const lastRow = pageRows.at(-1);

    return {
      rows: reviewCases,
      nextCursor:
        hasMore && lastRow
          ? {
              createdAt: new Date(lastRow.reviewCase.created_at).toISOString(),
              id: lastRow.reviewCase.id,
            }
          : null,
    };
  }),

  resolve: adminProcedure.input(ResolveReviewCaseSchema).mutation(async ({ input, ctx }) => {
    const [initialCase] = await db
      .select()
      .from(kiloclaw_commit_retirement_review_cases)
      .where(eq(kiloclaw_commit_retirement_review_cases.id, input.caseId))
      .limit(1);
    if (!initialCase) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Retirement review case not found' });
    }

    const initialSubscription = initialCase.subscription_id
      ? await db.query.kiloclaw_subscriptions.findFirst({
          where: eq(kiloclaw_subscriptions.id, initialCase.subscription_id),
        })
      : null;
    assertExpectedLocalState({
      reviewCase: initialCase,
      subscription: initialSubscription ?? null,
      expectedCaseUpdatedAt: input.expectedCaseUpdatedAt,
      expectedSubscriptionUpdatedAt: input.expectedSubscriptionUpdatedAt,
      expectedFinalBoundary: input.expectedFinalBoundary,
    });

    const provider = await revalidateProvider({
      reviewCase: initialCase,
      expected: input.expectedProvider,
    });
    await makeProviderNonRenewing(provider);

    return db.transaction(async tx => {
      const reviewCase = await lockReviewCase(tx, input.caseId);
      const subscription = await lockReviewSubscription(tx, reviewCase.subscription_id);
      assertExpectedLocalState({
        reviewCase,
        subscription,
        expectedCaseUpdatedAt: input.expectedCaseUpdatedAt,
        expectedSubscriptionUpdatedAt: input.expectedSubscriptionUpdatedAt,
        expectedFinalBoundary: input.expectedFinalBoundary,
      });

      if (
        reviewCase.stripe_subscription_id !== initialCase.stripe_subscription_id ||
        reviewCase.stripe_event_id !== initialCase.stripe_event_id
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Review-case provider identifiers changed. Refresh before resolving it.',
        });
      }

      if (subscription) {
        if (subscription.transferred_to_subscription_id) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Subscription was transferred. Resolve the review on the current lineage row.',
          });
        }

        let nextState: Partial<KiloClawSubscription>;
        if (
          subscription.plan === 'commit' &&
          (subscription.status === 'active' || subscription.status === 'past_due')
        ) {
          if (subscription.commit_retirement_standard_opted_in_at || subscription.scheduled_plan) {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'Subscription has Standard continuation state. Reconcile that consent before resolving the review.',
            });
          }
          const finalBoundary = safeFinalBoundary({ subscription, provider });
          if (!finalBoundary) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'No verified final boundary is available. No review-case changes were made.',
            });
          }
          nextState = {
            commit_retirement_state: 'final_term',
            commit_retirement_final_ends_at: finalBoundary,
            commit_retirement_guarded_at: new Date().toISOString(),
            commit_retirement_review_reason: null,
            commit_retirement_standard_opted_in_at: null,
            cancel_at_period_end: true,
            stripe_schedule_id: null,
            scheduled_plan: null,
            scheduled_by: null,
            ...(input.disposition === 'recognize_paid_period_as_final'
              ? { current_period_end: finalBoundary }
              : {}),
          };
        } else {
          if (input.disposition === 'recognize_paid_period_as_final') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Only a current Commit period can be recognized as the final paid period.',
            });
          }
          if (subscription.plan === 'commit' && subscription.status !== 'canceled') {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'Current Commit state has no safe final-boundary disposition. Cancel or reconcile it before resolving the case.',
            });
          }
          nextState = {
            commit_retirement_state: 'completed',
            commit_retirement_review_reason: null,
            commit_retirement_standard_opted_in_at: null,
          };
        }

        const [updatedSubscription] = await tx
          .update(kiloclaw_subscriptions)
          .set(nextState)
          .where(
            and(
              eq(kiloclaw_subscriptions.id, subscription.id),
              eq(kiloclaw_subscriptions.updated_at, subscription.updated_at),
              subscription.commit_retirement_final_ends_at
                ? eq(
                    kiloclaw_subscriptions.commit_retirement_final_ends_at,
                    subscription.commit_retirement_final_ends_at
                  )
                : isNull(kiloclaw_subscriptions.commit_retirement_final_ends_at)
            )
          )
          .returning();
        if (!updatedSubscription) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Subscription changed during resolution. Refresh the case before retrying.',
          });
        }

        await insertKiloClawSubscriptionChangeLog(tx, {
          subscriptionId: subscription.id,
          actor: { actorType: 'user', actorId: ctx.user.id },
          action: 'commit_retirement_changed',
          reason: `operator_${input.disposition}`,
          before: subscription,
          after: updatedSubscription,
        });
      }

      const resolved = await resolveCommitRetirementReviewCase(tx, {
        dedupeKey: reviewCase.dedupe_key,
        status: KiloClawCommitRetirementReviewCaseStatus.Resolved,
        disposition: input.disposition,
        actor: { type: 'operator', id: ctx.user.id },
        resolvedAt: new Date().toISOString(),
        reason: input.reason,
      });
      if (!resolved) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Review case changed during resolution. Refresh before retrying.',
        });
      }

      return { reviewCase: resolved };
    });
  }),

  dismiss: adminProcedure.input(StaleSafeReviewInputSchema).mutation(async ({ input, ctx }) => {
    const [initialCase] = await db
      .select()
      .from(kiloclaw_commit_retirement_review_cases)
      .where(eq(kiloclaw_commit_retirement_review_cases.id, input.caseId))
      .limit(1);
    if (!initialCase) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Retirement review case not found' });
    }
    if (!initialCase.subscription_id) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Rowless provider cases cannot be dismissed. Resolve with a provider-level deny disposition instead.',
      });
    }

    const initialSubscription = await db.query.kiloclaw_subscriptions.findFirst({
      where: eq(kiloclaw_subscriptions.id, initialCase.subscription_id),
    });
    assertExpectedLocalState({
      reviewCase: initialCase,
      subscription: initialSubscription ?? null,
      expectedCaseUpdatedAt: input.expectedCaseUpdatedAt,
      expectedSubscriptionUpdatedAt: input.expectedSubscriptionUpdatedAt,
      expectedFinalBoundary: input.expectedFinalBoundary,
    });
    await revalidateProvider({ reviewCase: initialCase, expected: input.expectedProvider });

    return db.transaction(async tx => {
      const reviewCase = await lockReviewCase(tx, input.caseId);
      const subscription = await lockReviewSubscription(tx, reviewCase.subscription_id);
      assertExpectedLocalState({
        reviewCase,
        subscription,
        expectedCaseUpdatedAt: input.expectedCaseUpdatedAt,
        expectedSubscriptionUpdatedAt: input.expectedSubscriptionUpdatedAt,
        expectedFinalBoundary: input.expectedFinalBoundary,
      });
      if (!subscription || subscription.commit_retirement_state === 'manual_review') {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Known-subscription cases can be dismissed only after current retirement state no longer requires review.',
        });
      }

      const dismissed = await resolveCommitRetirementReviewCase(tx, {
        dedupeKey: reviewCase.dedupe_key,
        status: KiloClawCommitRetirementReviewCaseStatus.Dismissed,
        disposition: KiloClawCommitRetirementResolutionDisposition.DismissNoIssue,
        actor: { type: 'operator', id: ctx.user.id },
        resolvedAt: new Date().toISOString(),
        reason: input.reason,
      });
      if (!dismissed) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Review case changed during dismissal. Refresh before retrying.',
        });
      }

      return { reviewCase: dismissed };
    });
  }),
});
