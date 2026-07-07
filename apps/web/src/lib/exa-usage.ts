import { randomUUID } from 'node:crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { exa_monthly_usage, exa_usage_log, kilocode_users, type User } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  mutateOrganizationUsage,
  scheduleOrganizationLowBalanceAlert,
} from '@/lib/organizations/organization-usage';
import type { OrganizationUsageMutationResult } from '@/lib/organizations/organization-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@/lib/constants';
import {
  captureCostInsightSpend,
  COST_INSIGHT_DRIVER_FALLBACK,
  COST_INSIGHT_EXA_PRODUCT_KEY,
} from '@kilocode/db/cost-insights-rollups';
import { scheduleCostInsightEvaluationAfterSpend } from '@/lib/cost-insights/evaluation';
import { getExaCostInsightFeatureKey } from '@/lib/exa-paths';

export type ExaMonthlyUsageResult = {
  /** Total spend in microdollars for the current month. */
  usage: number;
  /** Stored free allowance for this month, or null if no row exists yet. */
  freeAllowance: number | null;
};

/**
 * Returns the free Exa allowance for a given user-month.
 * Pure function, no IO. Today returns the global constant for everyone.
 * When per-user tiers are needed, modify this function only.
 */
export function getExaFreeAllowanceMicrodollars(_date: Date, _user: User): number {
  return EXA_MONTHLY_ALLOWANCE_MICRODOLLARS;
}

/**
 * Returns the user's total Exa spend (microdollars) and stored free allowance
 * for the current calendar month. Aggregates across personal and org rows.
 *
 * The free allowance is intentionally per-user, not per-context. This means
 * org usage counts toward the same free tier as personal usage. Once exhausted,
 * the charge goes to whichever context (personal or org) makes the request.
 * This prevents gaming via multiple orgs.
 *
 * `freeAllowance` is null when no rows exist yet (first request of the month),
 * signaling the caller to compute via `getExaFreeAllowanceMicrodollars`.
 */
export async function getExaMonthlyUsage(
  userId: string,
  fromDb: typeof db = db
): Promise<ExaMonthlyUsageResult> {
  const result = await fromDb
    .select({
      total: sql<number>`coalesce(sum(${exa_monthly_usage.total_cost_microdollars}), 0)`,
      freeAllowance: sql<number | null>`min(${exa_monthly_usage.free_allowance_microdollars})`,
    })
    .from(exa_monthly_usage)
    .where(
      sql`${exa_monthly_usage.kilo_user_id} = ${userId} AND ${exa_monthly_usage.month} = date_trunc('month', now())::date`
    );

  const total = Number(result[0]?.total ?? 0);
  // min() returns null when there are no rows, which signals "no row yet"
  const freeAllowance = result[0]?.freeAllowance != null ? Number(result[0].freeAllowance) : null;

  return { usage: total, freeAllowance };
}

/**
 * Records the source row, monthly counter, charged owner mutation, and Cost Insights
 * rollup atomically. Low-balance notification scheduling happens only after commit.
 */
export async function recordExaUsage(params: {
  userId: string;
  organizationId: string | undefined;
  path: string;
  costMicrodollars: number;
  chargedToBalance: boolean;
  freeAllowanceMicrodollars: number;
  featureId?: string;
  type?: string;
}): Promise<void> {
  const {
    userId,
    organizationId,
    path,
    costMicrodollars,
    chargedToBalance,
    freeAllowanceMicrodollars,
    featureId,
    type,
  } = params;
  const chargedAmount = chargedToBalance ? costMicrodollars : 0;
  const sourceId = randomUUID();
  const occurredAt = new Date().toISOString();

  const organizationUsage = await db.transaction(async tx => {
    await tx.insert(exa_usage_log).values({
      id: sourceId,
      kilo_user_id: userId,
      organization_id: organizationId ?? null,
      path,
      cost_microdollars: costMicrodollars,
      charged_to_balance: chargedToBalance,
      feature_id: featureId ?? null,
      type: type ?? null,
      created_at: occurredAt,
    });

    await upsertMonthlyCounter(tx, {
      userId,
      organizationId,
      occurredAt,
      costMicrodollars,
      chargedAmount,
      freeAllowanceMicrodollars,
    });

    if (!chargedToBalance || costMicrodollars <= 0) return null;

    const result = await deductFromBalance(tx, {
      userId,
      organizationId,
      occurredAt,
      costMicrodollars,
    });

    await captureCostInsightSpend(tx, {
      owner: organizationId
        ? { type: 'organization', id: organizationId }
        : { type: 'user', id: userId },
      actorUserId: userId,
      occurredAt,
      amountMicrodollars: costMicrodollars,
      category: 'variable',
      source: 'other',
      productKey: COST_INSIGHT_EXA_PRODUCT_KEY,
      featureKey: getExaCostInsightFeatureKey(path),
      modelOrPlanKey: COST_INSIGHT_DRIVER_FALLBACK,
      providerKey: COST_INSIGHT_EXA_PRODUCT_KEY,
    });

    return result;
  });

  if (organizationId && organizationUsage) {
    scheduleOrganizationLowBalanceAlert(organizationId, organizationUsage);
  }
  if (chargedToBalance && costMicrodollars > 0) {
    scheduleCostInsightEvaluationAfterSpend(
      organizationId ? { type: 'organization', id: organizationId } : { type: 'user', id: userId }
    );
  }
}

/**
 * Upserts the monthly counter row, targeting the correct partial unique index
 * based on whether the request is personal (no org) or org-scoped.
 */
async function upsertMonthlyCounter(
  tx: DrizzleTransaction,
  params: {
    userId: string;
    organizationId: string | undefined;
    occurredAt: string;
    costMicrodollars: number;
    chargedAmount: number;
    freeAllowanceMicrodollars: number;
  }
): Promise<void> {
  const {
    userId,
    organizationId,
    occurredAt,
    costMicrodollars,
    chargedAmount,
    freeAllowanceMicrodollars,
  } = params;

  const doUpdateSet = sql`
    total_cost_microdollars = ${exa_monthly_usage.total_cost_microdollars} + ${costMicrodollars},
    total_charged_microdollars = ${exa_monthly_usage.total_charged_microdollars} + ${chargedAmount},
    request_count = ${exa_monthly_usage.request_count} + 1,
    updated_at = now()
  `;

  if (organizationId) {
    await tx.execute(sql`
      INSERT INTO ${exa_monthly_usage} (
        kilo_user_id, organization_id, month,
        total_cost_microdollars, total_charged_microdollars, request_count, free_allowance_microdollars
      ) VALUES (
        ${userId}, ${organizationId}, date_trunc('month', ${occurredAt}::timestamptz AT TIME ZONE 'UTC')::date,
        ${costMicrodollars}, ${chargedAmount}, 1, ${freeAllowanceMicrodollars}
      )
      ON CONFLICT (kilo_user_id, organization_id, month)
        WHERE organization_id IS NOT NULL
      DO UPDATE SET ${doUpdateSet}
    `);
  } else {
    await tx.execute(sql`
      INSERT INTO ${exa_monthly_usage} (
        kilo_user_id, month,
        total_cost_microdollars, total_charged_microdollars, request_count, free_allowance_microdollars
      ) VALUES (
        ${userId}, date_trunc('month', ${occurredAt}::timestamptz AT TIME ZONE 'UTC')::date,
        ${costMicrodollars}, ${chargedAmount}, 1, ${freeAllowanceMicrodollars}
      )
      ON CONFLICT (kilo_user_id, month)
        WHERE organization_id IS NULL
      DO UPDATE SET ${doUpdateSet}
    `);
  }
}

async function deductFromBalance(
  tx: DrizzleTransaction,
  params: {
    userId: string;
    organizationId: string | undefined;
    occurredAt: string;
    costMicrodollars: number;
  }
): Promise<OrganizationUsageMutationResult | null> {
  const { userId, organizationId, occurredAt, costMicrodollars } = params;
  if (organizationId) {
    return mutateOrganizationUsage(tx, {
      kilo_user_id: userId,
      organization_id: organizationId,
      cost: costMicrodollars,
      created_at: occurredAt,
    });
  }

  await tx
    .update(kilocode_users)
    .set({
      microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
    })
    .where(eq(kilocode_users.id, userId));
  return null;
}
