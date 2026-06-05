import { TRPCError } from '@trpc/server';
import {
  kilocode_users,
  organizations,
  stripe_dispute_actions,
  stripe_dispute_cases,
} from '@kilocode/db/schema';
import { StripeDisputeCaseStatus } from '@kilocode/db/schema-types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as z from 'zod';

import { db } from '@/lib/drizzle';
import {
  acceptStripeDisputeCase,
  isStripeDisputeCaseActionError,
  stripeDisputeDashboardUrl,
} from '@/lib/stripe/disputes';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';

const DisputeQueueStatusSchema = z.enum([
  'all',
  'needs_action',
  'processing',
  'accepted',
  'acceptance_failed',
  'enforcement_failed',
  'review_required',
  'closed',
]);

const DisputeOwnerClassificationSchema = z.enum([
  'all',
  'personal',
  'organization',
  'ambiguous',
  'unmatched',
]);

const DisputesListInputSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(25),
  status: DisputeQueueStatusSchema.default('needs_action'),
  ownerClassification: DisputeOwnerClassificationSchema.default('all'),
});

export function disputeAcceptTRPCError(error: unknown): TRPCError {
  if (isStripeDisputeCaseActionError(error)) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: error.message,
    });
  }

  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: error instanceof Error ? error.message : String(error),
  });
}

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const adminStripeDisputesRouter = createTRPCRouter({
  list: adminProcedure.input(DisputesListInputSchema).query(async ({ input }) => {
    const offset = (input.page - 1) * input.limit;
    const acceptedByUser = alias(kilocode_users, 'accepted_by_user');
    const conditions = [];
    if (input.status !== 'all') {
      conditions.push(eq(stripe_dispute_cases.status, input.status));
    }
    if (input.ownerClassification !== 'all') {
      conditions.push(eq(stripe_dispute_cases.owner_classification, input.ownerClassification));
    }

    const rows = await db
      .select({
        id: stripe_dispute_cases.id,
        stripeDisputeId: stripe_dispute_cases.stripe_dispute_id,
        stripeEventId: stripe_dispute_cases.stripe_event_id,
        stripeChargeId: stripe_dispute_cases.stripe_charge_id,
        stripePaymentIntentId: stripe_dispute_cases.stripe_payment_intent_id,
        stripeCustomerId: stripe_dispute_cases.stripe_customer_id,
        amountMinorUnits: stripe_dispute_cases.amount_minor_units,
        currency: stripe_dispute_cases.currency,
        disputeReason: stripe_dispute_cases.dispute_reason,
        stripeStatus: stripe_dispute_cases.stripe_status,
        ownerClassification: stripe_dispute_cases.owner_classification,
        status: stripe_dispute_cases.status,
        statusReason: stripe_dispute_cases.status_reason,
        failureContext: stripe_dispute_cases.failure_context,
        stripeCreatedAt: stripe_dispute_cases.stripe_created_at,
        evidenceDueBy: stripe_dispute_cases.evidence_due_by,
        syncedAt: stripe_dispute_cases.synced_at,
        acceptanceStartedAt: stripe_dispute_cases.acceptance_started_at,
        nextRetryAt: stripe_dispute_cases.next_retry_at,
        acceptedAt: stripe_dispute_cases.accepted_at,
        enforcementCompletedAt: stripe_dispute_cases.enforcement_completed_at,
        reviewRequiredAt: stripe_dispute_cases.review_required_at,
        closedAt: stripe_dispute_cases.closed_at,
        createdAt: stripe_dispute_cases.created_at,
        userId: kilocode_users.id,
        userEmail: kilocode_users.google_user_email,
        userName: kilocode_users.google_user_name,
        organizationId: organizations.id,
        organizationName: organizations.name,
        acceptedByUserId: acceptedByUser.id,
        acceptedByUserEmail: acceptedByUser.google_user_email,
        total: sql<number>`count(*) OVER()::int`.as('total'),
      })
      .from(stripe_dispute_cases)
      .leftJoin(kilocode_users, eq(kilocode_users.id, stripe_dispute_cases.kilo_user_id))
      .leftJoin(organizations, eq(organizations.id, stripe_dispute_cases.organization_id))
      .leftJoin(
        acceptedByUser,
        eq(acceptedByUser.id, stripe_dispute_cases.accepted_by_kilo_user_id)
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        sql`${stripe_dispute_cases.status} = ${StripeDisputeCaseStatus.NeedsAction} DESC`,
        sql`${stripe_dispute_cases.evidence_due_by} ASC NULLS LAST`,
        desc(stripe_dispute_cases.stripe_created_at),
        desc(stripe_dispute_cases.created_at),
        desc(stripe_dispute_cases.id)
      )
      .limit(input.limit)
      .offset(offset);

    const caseIds = rows.map(row => row.id);
    const actionRows =
      caseIds.length > 0
        ? await db
            .select({
              id: stripe_dispute_actions.id,
              caseId: stripe_dispute_actions.case_id,
              actionType: stripe_dispute_actions.action_type,
              targetKey: stripe_dispute_actions.target_key,
              status: stripe_dispute_actions.status,
              attemptCount: stripe_dispute_actions.attempt_count,
              nextRetryAt: stripe_dispute_actions.next_retry_at,
              lastAttemptAt: stripe_dispute_actions.last_attempt_at,
              completedAt: stripe_dispute_actions.completed_at,
              resultCode: stripe_dispute_actions.result_code,
              resultReferenceId: stripe_dispute_actions.result_reference_id,
              failureContext: stripe_dispute_actions.failure_context,
              createdAt: stripe_dispute_actions.created_at,
            })
            .from(stripe_dispute_actions)
            .where(inArray(stripe_dispute_actions.case_id, caseIds))
            .orderBy(desc(stripe_dispute_actions.created_at), desc(stripe_dispute_actions.id))
        : [];
    const actionsByCase = new Map<string, typeof actionRows>();
    for (const action of actionRows) {
      const actions = actionsByCase.get(action.caseId) ?? [];
      actions.push(action);
      actionsByCase.set(action.caseId, actions);
    }

    const total = rows[0]?.total ?? 0;
    return {
      rows: rows.map(row => ({
        id: row.id,
        stripeDisputeId: row.stripeDisputeId,
        stripeEventId: row.stripeEventId,
        stripeChargeId: row.stripeChargeId,
        stripePaymentIntentId: row.stripePaymentIntentId,
        stripeCustomerId: row.stripeCustomerId,
        stripeDisputeUrl: stripeDisputeDashboardUrl(row.stripeDisputeId),
        amountMinorUnits: row.amountMinorUnits,
        currency: row.currency,
        disputeReason: row.disputeReason,
        stripeStatus: row.stripeStatus,
        ownerClassification: row.ownerClassification,
        status: row.status,
        statusReason: row.statusReason,
        failureContext: row.failureContext,
        stripeCreatedAt: normalizeTimestamp(row.stripeCreatedAt),
        evidenceDueBy: normalizeTimestamp(row.evidenceDueBy),
        syncedAt: normalizeTimestamp(row.syncedAt),
        acceptanceStartedAt: normalizeTimestamp(row.acceptanceStartedAt),
        nextRetryAt: normalizeTimestamp(row.nextRetryAt),
        acceptedAt: normalizeTimestamp(row.acceptedAt),
        enforcementCompletedAt: normalizeTimestamp(row.enforcementCompletedAt),
        reviewRequiredAt: normalizeTimestamp(row.reviewRequiredAt),
        closedAt: normalizeTimestamp(row.closedAt),
        createdAt: normalizeTimestamp(row.createdAt),
        user: row.userId
          ? {
              id: row.userId,
              email: row.userEmail,
              name: row.userName,
            }
          : null,
        organization: row.organizationId
          ? {
              id: row.organizationId,
              name: row.organizationName,
            }
          : null,
        acceptedBy: row.acceptedByUserId
          ? {
              id: row.acceptedByUserId,
              email: row.acceptedByUserEmail,
            }
          : null,
        actions: (actionsByCase.get(row.id) ?? []).map(action => ({
          id: action.id,
          actionType: action.actionType,
          targetKey: action.targetKey,
          status: action.status,
          attemptCount: action.attemptCount,
          nextRetryAt: normalizeTimestamp(action.nextRetryAt),
          lastAttemptAt: normalizeTimestamp(action.lastAttemptAt),
          completedAt: normalizeTimestamp(action.completedAt),
          resultCode: action.resultCode,
          resultReferenceId: action.resultReferenceId,
          failureContext: action.failureContext,
          createdAt: normalizeTimestamp(action.createdAt),
        })),
      })),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }),

  accept: adminProcedure
    .input(z.object({ caseId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await acceptStripeDisputeCase({ caseId: input.caseId, actor: ctx.user });
      } catch (error) {
        throw disputeAcceptTRPCError(error);
      }
    }),
});
