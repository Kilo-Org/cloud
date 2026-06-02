import { and, desc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import {
  cancelCodingPlanSubscription,
  getAvailableCodingPlanIds,
  getCodingPlanAvailabilityIntentPlanIds,
  getKeyInventoryCounts,
  requestCodingPlanAvailabilityNotification,
  subscribeToCodingPlan,
  terminateCodingPlanImmediately,
  uploadKeysToInventory,
} from '@/lib/coding-plans';
import {
  listManualCredentialRevocations,
  markCredentialManuallyRevoked,
  markCredentialManualRevocationFailed,
  requeueManualCredentialRevocation,
} from '@/lib/coding-plans/revocation';
import {
  CODING_PLAN_IDS,
  getCodingPlanCatalog,
  getCodingPlanPrice,
} from '@/lib/coding-plans/pricing';
import { db } from '@/lib/drizzle';
import { billingHistoryResponseSchema } from '@/lib/subscriptions/subscription-center';
import { baseProcedure, adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
} from '@kilocode/db/schema';

const CodingPlanIdSchema = z.enum(CODING_PLAN_IDS);
const SubscriptionIdSchema = z.string().uuid();
const BillingHistoryInputSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  cursor: z.string().optional(),
});

const codingPlanSubscriptionColumns = {
  id: coding_plan_subscriptions.id,
  planId: coding_plan_subscriptions.plan_id,
  providerId: coding_plan_subscriptions.provider_id,
  installedByokKeyId: coding_plan_subscriptions.installed_byok_key_id,
  status: coding_plan_subscriptions.status,
  costMicrodollars: coding_plan_subscriptions.cost_microdollars,
  billingPeriodDays: coding_plan_subscriptions.billing_period_days,
  currentPeriodStart: coding_plan_subscriptions.current_period_start,
  currentPeriodEnd: coding_plan_subscriptions.current_period_end,
  creditRenewalAt: coding_plan_subscriptions.credit_renewal_at,
  cancelAtPeriodEnd: coding_plan_subscriptions.cancel_at_period_end,
  paymentGraceExpiresAt: coding_plan_subscriptions.payment_grace_expires_at,
  canceledAt: coding_plan_subscriptions.canceled_at,
  cancellationReason: coding_plan_subscriptions.cancellation_reason,
  createdAt: coding_plan_subscriptions.created_at,
};

type CodingPlanSubscriptionRow = Awaited<ReturnType<typeof listOwnedSubscriptions>>[number];

function inKiloCredits(microdollars: number): number {
  return microdollars / 1_000_000;
}

function toIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function toNullableIsoTimestamp(value: string | null): string | null {
  return value ? toIsoTimestamp(value) : null;
}

function toAvailabilityStatus(isAvailable: boolean): 'available' | 'sold_out' {
  return isAvailable ? 'available' : 'sold_out';
}

async function listOwnedSubscriptions(userId: string) {
  return db
    .select(codingPlanSubscriptionColumns)
    .from(coding_plan_subscriptions)
    .where(eq(coding_plan_subscriptions.user_id, userId));
}

async function getOwnedSubscription(userId: string, subscriptionId: string) {
  const [subscription] = await db
    .select(codingPlanSubscriptionColumns)
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.id, subscriptionId),
        eq(coding_plan_subscriptions.user_id, userId)
      )
    )
    .limit(1);

  if (!subscription) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Coding Plan subscription not found.' });
  }

  return subscription;
}

function toCodingPlanSubscriptionView(subscription: CodingPlanSubscriptionRow) {
  const plan = getCodingPlanPrice(subscription.planId);
  const providerName = plan?.providerName ?? subscription.planId;
  const planName = plan?.name ?? subscription.planId;

  return {
    id: subscription.id,
    planId: subscription.planId,
    planName,
    providerName,
    providerId: subscription.providerId,
    routeLabel: `${providerName} via Kilo Gateway`,
    hasInstalledByokKey: subscription.installedByokKeyId !== null,
    status: subscription.status,
    billingPeriodDays: subscription.billingPeriodDays,
    currentPeriodStart: toIsoTimestamp(subscription.currentPeriodStart),
    currentPeriodEnd: toIsoTimestamp(subscription.currentPeriodEnd),
    creditRenewalAt: toIsoTimestamp(subscription.creditRenewalAt),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    paymentGraceExpiresAt: toNullableIsoTimestamp(subscription.paymentGraceExpiresAt),
    canceledAt: toNullableIsoTimestamp(subscription.canceledAt),
    cancellationReason: subscription.cancellationReason,
    createdAt: toIsoTimestamp(subscription.createdAt),
    costKiloCredits: inKiloCredits(subscription.costMicrodollars),
  };
}

export const codingPlansRouter = createTRPCRouter({
  catalog: baseProcedure.query(async ({ ctx }) => {
    const [availablePlanIds, notificationIntentPlanIds] = await Promise.all([
      getAvailableCodingPlanIds(),
      getCodingPlanAvailabilityIntentPlanIds(ctx.user.id),
    ]);
    const availablePlans = new Set(availablePlanIds);
    const requestedNotifications = new Set(notificationIntentPlanIds);

    return getCodingPlanCatalog().map(plan => ({
      planId: plan.planId,
      providerName: plan.providerName,
      name: plan.name,
      providerId: plan.providerId,
      costKiloCredits: inKiloCredits(plan.costMicrodollars),
      billingPeriodDays: plan.billingPeriodDays,
      availabilityStatus: toAvailabilityStatus(availablePlans.has(plan.planId)),
      notificationRequested: requestedNotifications.has(plan.planId),
    }));
  }),

  listSubscriptions: baseProcedure.query(async ({ ctx }) => {
    const subscriptions = await listOwnedSubscriptions(ctx.user.id);
    return subscriptions.map(toCodingPlanSubscriptionView);
  }),

  getSubscriptionDetail: baseProcedure
    .input(z.object({ subscriptionId: SubscriptionIdSchema }))
    .query(async ({ input, ctx }) => {
      const subscription = await getOwnedSubscription(ctx.user.id, input.subscriptionId);
      return toCodingPlanSubscriptionView(subscription);
    }),

  getBillingHistory: baseProcedure
    .input(BillingHistoryInputSchema)
    .output(billingHistoryResponseSchema)
    .query(async ({ input, ctx }) => {
      const subscription = toCodingPlanSubscriptionView(
        await getOwnedSubscription(ctx.user.id, input.subscriptionId)
      );
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
      const transactions = await db
        .select({
          id: credit_transactions.id,
          date: credit_transactions.created_at,
          amountMicrodollars: credit_transactions.amount_microdollars,
          description: credit_transactions.description,
        })
        .from(coding_plan_terms)
        .innerJoin(
          credit_transactions,
          eq(coding_plan_terms.credit_transaction_id, credit_transactions.id)
        )
        .where(
          and(
            eq(coding_plan_terms.subscription_id, input.subscriptionId),
            eq(coding_plan_terms.user_id, ctx.user.id),
            eq(credit_transactions.kilo_user_id, ctx.user.id)
          )
        )
        .orderBy(desc(credit_transactions.created_at), desc(credit_transactions.id))
        .limit(26)
        .offset(offset);

      return {
        entries: transactions.slice(0, 25).map(transaction => ({
          kind: 'credits' as const,
          id: transaction.id,
          date: toIsoTimestamp(transaction.date),
          amountMicrodollars: Math.abs(transaction.amountMicrodollars),
          description:
            transaction.description ??
            `Coding plan: ${subscription.providerName} ${subscription.planName}`,
        })),
        hasMore: transactions.length > 25,
        cursor: transactions.length > 25 ? String(offset + 25) : null,
      };
    }),

  subscribe: baseProcedure
    .input(
      z.object({
        planId: CodingPlanIdSchema,
        idempotencyKey: z.string().min(1).max(200),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await subscribeToCodingPlan(ctx.user.id, input.planId, input.idempotencyKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('Insufficient credit balance') ||
          message.includes('No managed credential') ||
          message.includes('Remove your existing MiniMax BYOK key')
        ) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
        }
        if (message.includes('not available as a coding plan')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        if (message.includes('already has a live subscription')) {
          throw new TRPCError({ code: 'CONFLICT', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  requestAvailabilityNotification: baseProcedure
    .input(z.object({ planId: CodingPlanIdSchema }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await requestCodingPlanAvailabilityNotification(ctx.user.id, input.planId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('currently available')) {
          throw new TRPCError({ code: 'CONFLICT', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  cancel: baseProcedure
    .input(z.object({ subscriptionId: SubscriptionIdSchema }))
    .mutation(async ({ input, ctx }) => {
      try {
        await cancelCodingPlanSubscription(ctx.user.id, input.subscriptionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No active subscription')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  adminKeyInventory: adminProcedure
    .input(z.object({ planId: CodingPlanIdSchema.optional() }))
    .query(({ input }) => getKeyInventoryCounts(input.planId)),

  adminUploadKeys: adminProcedure
    .input(
      z.object({
        planId: CodingPlanIdSchema,
        entries: z.array(z.string().min(1)).min(1).max(1000),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await uploadKeysToInventory(input.planId, input.entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('<api key>::<plan id>') ||
          message.includes('failed validation') ||
          message.includes('already present in inventory')
        ) {
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  adminTerminateSubscription: adminProcedure
    .input(z.object({ subscriptionId: SubscriptionIdSchema }))
    .mutation(async ({ input }) => {
      try {
        await terminateCodingPlanImmediately(input.subscriptionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No live subscription')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  adminRevocationQueue: adminProcedure
    .input(
      z.object({
        planId: CodingPlanIdSchema.optional(),
        status: z.enum(['revocation_pending', 'revocation_failed']).optional(),
      })
    )
    .query(async ({ input }) => {
      const workItems = await listManualCredentialRevocations(input);
      return workItems.map(item => ({
        ...item,
        revocationRequestedAt: toNullableIsoTimestamp(item.revocationRequestedAt),
        revokedAt: toNullableIsoTimestamp(item.revokedAt),
        updatedAt: toIsoTimestamp(item.updatedAt),
      }));
    }),

  adminMarkRevocationComplete: adminProcedure
    .input(z.object({ inventoryKeyId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      try {
        await markCredentialManuallyRevoked(input.inventoryKeyId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
      }
    }),

  adminMarkRevocationFailed: adminProcedure
    .input(
      z.object({ inventoryKeyId: z.string().uuid(), reason: z.string().trim().min(1).max(300) })
    )
    .mutation(async ({ input }) => {
      try {
        await markCredentialManualRevocationFailed(input.inventoryKeyId, input.reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
      }
    }),

  adminRequeueRevocation: adminProcedure
    .input(z.object({ inventoryKeyId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      try {
        await requeueManualCredentialRevocation(input.inventoryKeyId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
      }
    }),
});
