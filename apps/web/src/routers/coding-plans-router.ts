import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import {
  adminCancelCodingPlanSubscription,
  cancelCodingPlanSubscription,
  CodingPlanInventoryReplacementError,
  CodingPlanInventoryUploadError,
  extendCodingPlanSubscriptionPeriod,
  getAvailableCodingPlanIds,
  getCodingPlanAvailabilityIntentCounts,
  getCodingPlanAvailabilityIntentPlanIds,
  getKeyInventoryCounts,
  replaceInventoryCredential,
  requestCodingPlanAvailabilityNotification,
  subscribeToCodingPlan,
  terminateCodingPlanImmediately,
  uploadKeysToInventory,
} from '@/lib/coding-plans';
import {
  CodingPlanQuotaWindowsSchema,
  CodingPlanUsageError,
} from '@/lib/coding-plans/usage-contract';
import {
  canQueryCodingPlanUsage,
  CodingPlanUsageEligibilityError,
  getCodingPlanUsageResponse,
} from '@/lib/coding-plans/usage';
import {
  listManualCredentialRevocations,
  ManualCredentialReplacementError,
  markCredentialManuallyRevoked,
  markCredentialManualRevocationFailed,
  requeueManualCredentialRevocation,
  replaceManualCredentialRevocation,
} from '@/lib/coding-plans/revocation';
import {
  CODING_PLAN_IDS,
  getCodingPlanCatalog,
  getCodingPlanPrice,
} from '@/lib/coding-plans/pricing';
import { db } from '@/lib/drizzle';
import { UserByokProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { billingHistoryResponseSchema } from '@/lib/subscriptions/subscription-center';
import { baseProcedure, adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  coding_plan_subscriptions,
  coding_plan_terms,
  coding_plan_key_inventory,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';

const CodingPlanIdSchema = z.enum(CODING_PLAN_IDS);
const CodingPlanProviderIdSchema = UserByokProviderIdSchema;
const SubscriptionIdSchema = z.string().uuid();
const BillingHistoryInputSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  cursor: z.string().optional(),
});
const ADMIN_SUBSCRIPTION_PAGE_SIZE = 20;
const AdminSubscriptionDisplayStatusSchema = z.enum([
  'active',
  'pending_cancellation',
  'past_due',
  'canceled',
]);
const AdminListSubscriptionsInputSchema = z.object({
  page: z.number().int().min(1).max(10_000).default(1),
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform(value => (value && value.length > 0 ? value : undefined)),
  status: AdminSubscriptionDisplayStatusSchema.optional(),
});
const AdminInsightsRangeDaysSchema = z.union([z.literal(7), z.literal(14), z.literal(30)]);
const AdminInsightsInputSchema = z.object({
  rangeDays: AdminInsightsRangeDaysSchema.default(7),
});

const CodingPlanUsageOutputSchema = z.object({
  schemaVersion: z.literal(1),
  fetchedAt: z.iso.datetime(),
  subscription: z.object({
    id: SubscriptionIdSchema,
    planId: CodingPlanIdSchema,
    planName: z.string().min(1),
    providerId: CodingPlanProviderIdSchema,
    providerName: z.string().min(1),
    windows: CodingPlanQuotaWindowsSchema,
  }),
});

const codingPlanSubscriptionColumns = {
  id: coding_plan_subscriptions.id,
  userId: coding_plan_subscriptions.user_id,
  planId: coding_plan_subscriptions.plan_id,
  providerId: coding_plan_subscriptions.provider_id,
  keyInventoryId: coding_plan_subscriptions.key_inventory_id,
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
  hasAssignedInventory: sql<boolean>`coalesce(
    ${coding_plan_key_inventory.status} = 'assigned'
    AND ${coding_plan_key_inventory.assigned_to_user_id} = ${coding_plan_subscriptions.user_id}
    AND ${coding_plan_key_inventory.plan_id} = ${coding_plan_subscriptions.plan_id}
    AND ${coding_plan_key_inventory.provider_id} = ${coding_plan_subscriptions.provider_id},
    false
  )`,
  hasUpstreamUsageId: sql<boolean>`coalesce(${coding_plan_key_inventory.upstream_usage_id} IS NOT NULL, false)`,
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
    .leftJoin(
      coding_plan_key_inventory,
      eq(coding_plan_key_inventory.id, coding_plan_subscriptions.key_inventory_id)
    )
    .where(eq(coding_plan_subscriptions.user_id, userId));
}

async function getOwnedSubscription(userId: string, subscriptionId: string) {
  const [subscription] = await db
    .select(codingPlanSubscriptionColumns)
    .from(coding_plan_subscriptions)
    .leftJoin(
      coding_plan_key_inventory,
      eq(coding_plan_key_inventory.id, coding_plan_subscriptions.key_inventory_id)
    )
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
    features: plan?.features ?? [],
    canQueryUsage: canQueryCodingPlanUsage(subscription),
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

function adminSubscriptionSearchFilter(search: string | undefined): SQL | undefined {
  if (!search) return undefined;
  const pattern = `%${search}%`;
  return or(
    ilike(kilocode_users.id, pattern),
    ilike(kilocode_users.google_user_email, pattern),
    ilike(kilocode_users.normalized_email, pattern)
  );
}

function toNumericCount(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

function toNumericCredits(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseFloat(value) || 0;
  return 0;
}

async function getAdminSubscriptionSummary() {
  const { rows } = await db.execute<{
    total: string;
    active: string;
    pending_cancellation: string;
    past_due: string;
  }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE status = 'active' AND cancel_at_period_end = false
      )::int AS active,
      COUNT(*) FILTER (
        WHERE status = 'active' AND cancel_at_period_end = true
      )::int AS pending_cancellation,
      COUNT(*) FILTER (WHERE status = 'past_due')::int AS past_due
    FROM coding_plan_subscriptions
  `);
  const summary = rows[0];
  return {
    total: toNumericCount(summary?.total),
    active: toNumericCount(summary?.active),
    pendingCancellation: toNumericCount(summary?.pending_cancellation),
    pastDue: toNumericCount(summary?.past_due),
  };
}

type AdminInsightPlanRow = {
  planId: (typeof CODING_PLAN_IDS)[number];
  liveSubscriptions: number;
  pendingCancellation: number;
  pastDue: number;
  monthlyRecurringValueKiloCredits: number;
  revenueAtRiskKiloCredits: number;
  pastDueMrrKiloCredits: number;
  createdInRange: number;
  createdInPriorRange: number;
  canceledInRange: number;
  liveAtRangeStart: number;
  retainedFromRangeStart: number;
  currentWaitersJoinedInRange: number;
  currentWaitersJoinedInPriorRange: number;
  currentWaitlistTotal: number;
};

function emptyAdminInsightPlanRow(planId: (typeof CODING_PLAN_IDS)[number]): AdminInsightPlanRow {
  return {
    planId,
    liveSubscriptions: 0,
    pendingCancellation: 0,
    pastDue: 0,
    monthlyRecurringValueKiloCredits: 0,
    revenueAtRiskKiloCredits: 0,
    pastDueMrrKiloCredits: 0,
    createdInRange: 0,
    createdInPriorRange: 0,
    canceledInRange: 0,
    liveAtRangeStart: 0,
    retainedFromRangeStart: 0,
    currentWaitersJoinedInRange: 0,
    currentWaitersJoinedInPriorRange: 0,
    currentWaitlistTotal: 0,
  };
}

function toPublicAdminInsightPlan(plan: AdminInsightPlanRow) {
  return {
    planId: plan.planId,
    liveSubscriptions: plan.liveSubscriptions,
    monthlyRecurringValueKiloCredits: plan.monthlyRecurringValueKiloCredits,
    createdInRange: plan.createdInRange,
    canceledInRange: plan.canceledInRange,
    currentWaitersJoinedInRange: plan.currentWaitersJoinedInRange,
    currentWaitlistTotal: plan.currentWaitlistTotal,
  };
}

function sumAdminInsightTotals(plans: readonly AdminInsightPlanRow[]) {
  return plans.reduce(
    (totals, plan) => ({
      liveSubscriptions: totals.liveSubscriptions + plan.liveSubscriptions,
      pendingCancellation: totals.pendingCancellation + plan.pendingCancellation,
      pastDue: totals.pastDue + plan.pastDue,
      mrrKiloCredits: totals.mrrKiloCredits + plan.monthlyRecurringValueKiloCredits,
      revenueAtRiskKiloCredits: totals.revenueAtRiskKiloCredits + plan.revenueAtRiskKiloCredits,
      pastDueMrrKiloCredits: totals.pastDueMrrKiloCredits + plan.pastDueMrrKiloCredits,
      createdInRange: totals.createdInRange + plan.createdInRange,
      createdInPriorRange: totals.createdInPriorRange + plan.createdInPriorRange,
      canceledInRange: totals.canceledInRange + plan.canceledInRange,
      liveAtRangeStart: totals.liveAtRangeStart + plan.liveAtRangeStart,
      retainedFromRangeStart: totals.retainedFromRangeStart + plan.retainedFromRangeStart,
      currentWaitersJoinedInRange:
        totals.currentWaitersJoinedInRange + plan.currentWaitersJoinedInRange,
      currentWaitersJoinedInPriorRange:
        totals.currentWaitersJoinedInPriorRange + plan.currentWaitersJoinedInPriorRange,
      currentWaitlistTotal: totals.currentWaitlistTotal + plan.currentWaitlistTotal,
    }),
    {
      liveSubscriptions: 0,
      pendingCancellation: 0,
      pastDue: 0,
      mrrKiloCredits: 0,
      revenueAtRiskKiloCredits: 0,
      pastDueMrrKiloCredits: 0,
      createdInRange: 0,
      createdInPriorRange: 0,
      canceledInRange: 0,
      liveAtRangeStart: 0,
      retainedFromRangeStart: 0,
      currentWaitersJoinedInRange: 0,
      currentWaitersJoinedInPriorRange: 0,
      currentWaitlistTotal: 0,
    }
  );
}

async function getAdminInsights(rangeDays: 7 | 14 | 30) {
  const catalogPlanValues = sql.join(
    CODING_PLAN_IDS.map((planId, index) => sql`(${planId}, ${index + 1})`),
    sql`, `
  );
  const catalogPlanIds = sql.join(
    CODING_PLAN_IDS.map(planId => sql`${planId}`),
    sql`, `
  );
  const { rows } = await db.execute<{
    plan_id: string;
    live_subscriptions: string;
    pending_cancellation: string;
    past_due: string;
    monthly_recurring_value_kilo_credits: string;
    revenue_at_risk_kilo_credits: string;
    past_due_mrr_kilo_credits: string;
    created_in_range: string;
    created_in_prior_range: string;
    canceled_in_range: string;
    live_at_range_start: string;
    retained_from_range_start: string;
    current_waiters_joined_in_range: string;
    current_waiters_joined_in_prior_range: string;
    current_waitlist_total: string;
  }>(sql`
    WITH catalog_plans(plan_id, sort_order) AS (
      SELECT * FROM (VALUES ${catalogPlanValues}) AS catalog(plan_id, sort_order)
    ),
    bounds AS (
      SELECT
        NOW() AS now_at,
        NOW() - make_interval(days => ${rangeDays}) AS range_start,
        NOW() - make_interval(days => ${rangeDays * 2}) AS prior_range_start
    ),
    subscription_metrics AS (
      SELECT
        subscriptions.plan_id,
        COUNT(*) FILTER (
          WHERE subscriptions.status IN ('active', 'past_due')
        )::int AS live_subscriptions,
        COUNT(*) FILTER (
          WHERE subscriptions.status = 'active'
            AND subscriptions.cancel_at_period_end = true
        )::int AS pending_cancellation,
        COUNT(*) FILTER (
          WHERE subscriptions.status = 'past_due'
        )::int AS past_due,
        COALESCE(
          SUM(
            (subscriptions.cost_microdollars::numeric / 1000000)
            * (30.0 / NULLIF(subscriptions.billing_period_days, 0))
          ) FILTER (WHERE subscriptions.status IN ('active', 'past_due')),
          0
        ) AS monthly_recurring_value_kilo_credits,
        COALESCE(
          SUM(
            (subscriptions.cost_microdollars::numeric / 1000000)
            * (30.0 / NULLIF(subscriptions.billing_period_days, 0))
          ) FILTER (
            WHERE subscriptions.status = 'past_due'
               OR (
                 subscriptions.status = 'active'
                 AND subscriptions.cancel_at_period_end = true
               )
          ),
          0
        ) AS revenue_at_risk_kilo_credits,
        COALESCE(
          SUM(
            (subscriptions.cost_microdollars::numeric / 1000000)
            * (30.0 / NULLIF(subscriptions.billing_period_days, 0))
          ) FILTER (WHERE subscriptions.status = 'past_due'),
          0
        ) AS past_due_mrr_kilo_credits,
        COUNT(*) FILTER (
          WHERE subscriptions.created_at >= (SELECT range_start FROM bounds)
            AND subscriptions.created_at < (SELECT now_at FROM bounds)
        )::int AS created_in_range,
        COUNT(*) FILTER (
          WHERE subscriptions.created_at >= (SELECT prior_range_start FROM bounds)
            AND subscriptions.created_at < (SELECT range_start FROM bounds)
        )::int AS created_in_prior_range,
        COUNT(*) FILTER (
          WHERE subscriptions.status = 'canceled'
            AND subscriptions.canceled_at IS NOT NULL
            AND subscriptions.canceled_at >= (SELECT range_start FROM bounds)
            AND subscriptions.canceled_at < (SELECT now_at FROM bounds)
        )::int AS canceled_in_range,
        COUNT(*) FILTER (
          WHERE subscriptions.created_at < (SELECT range_start FROM bounds)
            AND (
              subscriptions.canceled_at IS NULL
              OR subscriptions.canceled_at >= (SELECT range_start FROM bounds)
            )
        )::int AS live_at_range_start,
        COUNT(*) FILTER (
          WHERE subscriptions.created_at < (SELECT range_start FROM bounds)
            AND (
              subscriptions.canceled_at IS NULL
              OR subscriptions.canceled_at >= (SELECT range_start FROM bounds)
            )
            AND subscriptions.status <> 'canceled'
        )::int AS retained_from_range_start
      FROM coding_plan_subscriptions AS subscriptions
      WHERE subscriptions.plan_id IN (${catalogPlanIds})
      GROUP BY subscriptions.plan_id
    ),
    current_waiters AS (
      SELECT intents.plan_id, intents.created_at
      FROM coding_plan_availability_intents AS intents
      WHERE intents.plan_id IN (${catalogPlanIds})
        AND NOT EXISTS (
          SELECT 1
          FROM coding_plan_terms AS terms
          WHERE terms.user_id = intents.user_id
            AND terms.plan_id = intents.plan_id
            AND terms.kind = 'activation'
            AND terms.created_at >= intents.created_at
        )
    ),
    waiter_metrics AS (
      SELECT
        waiters.plan_id,
        COUNT(*)::int AS current_waitlist_total,
        COUNT(*) FILTER (
          WHERE waiters.created_at >= (SELECT range_start FROM bounds)
            AND waiters.created_at < (SELECT now_at FROM bounds)
        )::int AS current_waiters_joined_in_range,
        COUNT(*) FILTER (
          WHERE waiters.created_at >= (SELECT prior_range_start FROM bounds)
            AND waiters.created_at < (SELECT range_start FROM bounds)
        )::int AS current_waiters_joined_in_prior_range
      FROM current_waiters AS waiters
      GROUP BY waiters.plan_id
    )
    SELECT
      catalog.plan_id,
      COALESCE(subscriptions.live_subscriptions, 0) AS live_subscriptions,
      COALESCE(subscriptions.pending_cancellation, 0) AS pending_cancellation,
      COALESCE(subscriptions.past_due, 0) AS past_due,
      COALESCE(
        subscriptions.monthly_recurring_value_kilo_credits,
        0
      ) AS monthly_recurring_value_kilo_credits,
      COALESCE(subscriptions.revenue_at_risk_kilo_credits, 0) AS revenue_at_risk_kilo_credits,
      COALESCE(subscriptions.past_due_mrr_kilo_credits, 0) AS past_due_mrr_kilo_credits,
      COALESCE(subscriptions.created_in_range, 0) AS created_in_range,
      COALESCE(subscriptions.created_in_prior_range, 0) AS created_in_prior_range,
      COALESCE(subscriptions.canceled_in_range, 0) AS canceled_in_range,
      COALESCE(subscriptions.live_at_range_start, 0) AS live_at_range_start,
      COALESCE(subscriptions.retained_from_range_start, 0) AS retained_from_range_start,
      COALESCE(waiters.current_waiters_joined_in_range, 0) AS current_waiters_joined_in_range,
      COALESCE(
        waiters.current_waiters_joined_in_prior_range,
        0
      ) AS current_waiters_joined_in_prior_range,
      COALESCE(waiters.current_waitlist_total, 0) AS current_waitlist_total
    FROM catalog_plans AS catalog
    LEFT JOIN subscription_metrics AS subscriptions
      ON subscriptions.plan_id = catalog.plan_id
    LEFT JOIN waiter_metrics AS waiters
      ON waiters.plan_id = catalog.plan_id
    ORDER BY catalog.sort_order
  `);

  const plansById = new Map(rows.map(row => [row.plan_id, row]));
  const plans = CODING_PLAN_IDS.map(planId => {
    const row = plansById.get(planId);
    if (!row) return emptyAdminInsightPlanRow(planId);
    return {
      planId,
      liveSubscriptions: toNumericCount(row.live_subscriptions),
      pendingCancellation: toNumericCount(row.pending_cancellation),
      pastDue: toNumericCount(row.past_due),
      monthlyRecurringValueKiloCredits: toNumericCredits(row.monthly_recurring_value_kilo_credits),
      revenueAtRiskKiloCredits: toNumericCredits(row.revenue_at_risk_kilo_credits),
      pastDueMrrKiloCredits: toNumericCredits(row.past_due_mrr_kilo_credits),
      createdInRange: toNumericCount(row.created_in_range),
      createdInPriorRange: toNumericCount(row.created_in_prior_range),
      canceledInRange: toNumericCount(row.canceled_in_range),
      liveAtRangeStart: toNumericCount(row.live_at_range_start),
      retainedFromRangeStart: toNumericCount(row.retained_from_range_start),
      currentWaitersJoinedInRange: toNumericCount(row.current_waiters_joined_in_range),
      currentWaitersJoinedInPriorRange: toNumericCount(row.current_waiters_joined_in_prior_range),
      currentWaitlistTotal: toNumericCount(row.current_waitlist_total),
    };
  });

  return {
    rangeDays,
    totals: sumAdminInsightTotals(plans),
    plans: plans.map(toPublicAdminInsightPlan),
  };
}

function adminSubscriptionStatusFilter(
  status: z.infer<typeof AdminSubscriptionDisplayStatusSchema> | undefined
): SQL | undefined {
  if (!status) return undefined;
  if (status === 'active') {
    return and(
      eq(coding_plan_subscriptions.status, 'active'),
      eq(coding_plan_subscriptions.cancel_at_period_end, false)
    );
  }
  if (status === 'pending_cancellation') {
    return and(
      eq(coding_plan_subscriptions.status, 'active'),
      eq(coding_plan_subscriptions.cancel_at_period_end, true)
    );
  }
  return eq(coding_plan_subscriptions.status, status);
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
      features: plan.features,
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

  adminListSubscriptions: adminProcedure
    .input(AdminListSubscriptionsInputSchema)
    .query(async ({ input }) => {
      const filters = and(
        adminSubscriptionSearchFilter(input.search),
        adminSubscriptionStatusFilter(input.status)
      );
      const [{ total }] = await db
        .select({ total: count() })
        .from(coding_plan_subscriptions)
        .innerJoin(kilocode_users, eq(kilocode_users.id, coding_plan_subscriptions.user_id))
        .leftJoin(
          coding_plan_key_inventory,
          eq(coding_plan_key_inventory.id, coding_plan_subscriptions.key_inventory_id)
        )
        .where(filters);
      const totalPages = Math.ceil(total / ADMIN_SUBSCRIPTION_PAGE_SIZE);
      const page = totalPages === 0 || input.page > totalPages ? 1 : input.page;
      const subscriptions = await db
        .select({
          ...codingPlanSubscriptionColumns,
          upstreamPlanId: coding_plan_key_inventory.upstream_plan_id,
          userName: kilocode_users.google_user_name,
          userEmail: kilocode_users.google_user_email,
        })
        .from(coding_plan_subscriptions)
        .innerJoin(kilocode_users, eq(kilocode_users.id, coding_plan_subscriptions.user_id))
        .leftJoin(
          coding_plan_key_inventory,
          eq(coding_plan_key_inventory.id, coding_plan_subscriptions.key_inventory_id)
        )
        .where(filters)
        .orderBy(desc(coding_plan_subscriptions.created_at), desc(coding_plan_subscriptions.id))
        .limit(ADMIN_SUBSCRIPTION_PAGE_SIZE)
        .offset((page - 1) * ADMIN_SUBSCRIPTION_PAGE_SIZE);

      return {
        items: subscriptions.map(subscription => ({
          ...toCodingPlanSubscriptionView(subscription),
          userId: subscription.userId,
          userName: subscription.userName,
          userEmail: subscription.userEmail,
          inventoryKeyId: subscription.keyInventoryId,
          upstreamPlanId: subscription.upstreamPlanId,
        })),
        pagination: { page, total, totalPages },
      };
    }),

  adminSubscriptionOverview: adminProcedure.query(async () => {
    return getAdminSubscriptionSummary();
  }),

  adminAvailabilityIntentCounts: adminProcedure.input(z.object({})).query(async () => {
    return getCodingPlanAvailabilityIntentCounts();
  }),

  adminInsights: adminProcedure.input(AdminInsightsInputSchema).query(async ({ input }) => {
    return getAdminInsights(input.rangeDays);
  }),

  getSubscriptionDetail: baseProcedure
    .input(z.object({ subscriptionId: SubscriptionIdSchema }))
    .query(async ({ input, ctx }) => {
      const subscription = await getOwnedSubscription(ctx.user.id, input.subscriptionId);
      return toCodingPlanSubscriptionView(subscription);
    }),

  getUsage: baseProcedure
    .input(z.object({ subscriptionId: SubscriptionIdSchema }))
    .output(CodingPlanUsageOutputSchema)
    .query(async ({ input, ctx }) => {
      const subscription = await getOwnedSubscription(ctx.user.id, input.subscriptionId);
      try {
        return await getCodingPlanUsageResponse(ctx.user.id, subscription);
      } catch (error) {
        if (error instanceof CodingPlanUsageEligibilityError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
        }
        if (error instanceof CodingPlanUsageError) {
          throw new TRPCError({ code: 'BAD_GATEWAY', message: error.message });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Coding Plan usage is unavailable.',
          cause: error,
        });
      }
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
          (message.includes('Remove your existing') && message.includes('BYOK key from /byok'))
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
        providerId: CodingPlanProviderIdSchema,
        planId: CodingPlanIdSchema,
        entries: z.array(z.string().min(1)).min(1).max(1000),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await uploadKeysToInventory(input.providerId, input.planId, input.entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('<api key>::<upstream plan id>') ||
          message.includes('<api key>::<assigned BytePlus username>') ||
          message.includes('does not match provider') ||
          message.includes('failed validation') ||
          message.includes('already present in inventory') ||
          message.includes('BytePlus seats are already attached')
        ) {
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        const safeMessage =
          error instanceof CodingPlanInventoryUploadError
            ? error.message
            : 'Unable to upload Coding Plan inventory.';
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: safeMessage });
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

  adminCancelSubscription: adminProcedure
    .input(z.object({ subscriptionId: SubscriptionIdSchema }))
    .mutation(async ({ input }) => {
      try {
        await adminCancelCodingPlanSubscription(input.subscriptionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No active subscription')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  adminExtendSubscriptionPeriod: adminProcedure
    .input(
      z.object({
        subscriptionId: SubscriptionIdSchema,
        days: z.number().int().min(1).max(90),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await extendCodingPlanSubscriptionPeriod(
          input.subscriptionId,
          input.days,
          ctx.user.id
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No active subscription')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  adminReplaceInventoryCredential: adminProcedure
    .input(
      z.object({ inventoryKeyId: z.string().uuid(), apiKey: z.string().trim().min(1).max(500) })
    )
    .mutation(async ({ input }) => {
      try {
        await replaceInventoryCredential(input.inventoryKeyId, input.apiKey);
      } catch (error) {
        if (error instanceof CodingPlanInventoryReplacementError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to replace the inventory credential.',
        });
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
        subscriptionExpiresAt: toNullableIsoTimestamp(item.subscriptionExpiresAt),
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

  adminReplaceRevocationCredential: adminProcedure
    .input(
      z.object({ inventoryKeyId: z.string().uuid(), apiKey: z.string().trim().min(1).max(500) })
    )
    .mutation(async ({ input }) => {
      try {
        await replaceManualCredentialRevocation(input.inventoryKeyId, input.apiKey);
      } catch (error) {
        const message =
          error instanceof ManualCredentialReplacementError
            ? error.message
            : 'Unable to replace the credential.';
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
