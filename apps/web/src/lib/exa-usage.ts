import { randomUUID } from 'node:crypto';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { exa_monthly_usage, exa_usage_log, kilocode_users, type User } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { scheduleOrganizationLowBalanceAlert } from '@kilocode/web-shared/lib/organizations/organization-usage';
import type { OrganizationUsageMutationResult } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@kilocode/web-shared/lib/constants';
import { recordOrganizationConsumption } from '@kilocode/web-shared/lib/kilo-pass-org/consumption';

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
 * The part of a request's cost that lies above the free allowance for the
 * month. `usageBefore` is the user's committed monthly total before this
 * request, so a request that straddles the boundary pays only its excess.
 */
function chargeAboveAllowance(
  usageBefore: number,
  costMicrodollars: number,
  allowanceMicrodollars: number
): number {
  const excessBefore = Math.max(0, usageBefore - allowanceMicrodollars);
  const excessAfter = Math.max(0, usageBefore + costMicrodollars - allowanceMicrodollars);
  return excessAfter - excessBefore;
}

/**
 * Records the source row, monthly counter, and charged owner mutation atomically.
 * Low-balance notification scheduling happens only after commit.
 *
 * The charged amount is derived here, from the locked monthly total, rather than
 * from a decision made before the upstream request: the free allowance covers
 * the first `allowanceMicrodollars` of the month, and every microdollar beyond
 * it is charged to the context that made the request.
 */
export async function recordExaUsage(params: {
  userId: string;
  organizationId: string | undefined;
  path: string;
  costMicrodollars: number;
  freeAllowanceMicrodollars: number;
  featureId?: string;
  type?: string;
}): Promise<void> {
  const {
    userId,
    organizationId,
    path,
    costMicrodollars,
    freeAllowanceMicrodollars,
    featureId,
    type,
  } = params;
  const sourceId = randomUUID();
  const occurredAt = new Date().toISOString();

  const organizationUsage = await db.transaction(async tx => {
    // Serialize this user's monthly accounting so each request observes the
    // committed total of the requests recorded before it. Transaction-scoped:
    // released on commit or rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`exa-monthly-usage:${userId}`}, 0))`
    );

    const [current] = await tx
      .select({
        usage: sql<number>`coalesce(sum(${exa_monthly_usage.total_cost_microdollars}), 0)`,
        freeAllowance: sql<number | null>`min(${exa_monthly_usage.free_allowance_microdollars})`,
      })
      .from(exa_monthly_usage)
      .where(
        sql`${exa_monthly_usage.kilo_user_id} = ${userId} AND ${exa_monthly_usage.month} = date_trunc('month', ${occurredAt}::timestamptz AT TIME ZONE 'UTC')::date`
      );

    const usageBefore = Number(current?.usage ?? 0);
    const allowance =
      current?.freeAllowance != null ? Number(current.freeAllowance) : freeAllowanceMicrodollars;
    const chargedAmount = chargeAboveAllowance(usageBefore, costMicrodollars, allowance);
    const chargedToBalance = chargedAmount > 0;

    await tx.insert(exa_usage_log).values({
      id: sourceId,
      kilo_user_id: userId,
      organization_id: organizationId ?? null,
      path,
      cost_microdollars: costMicrodollars,
      charged_microdollars: chargedAmount,
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
      freeAllowanceMicrodollars: allowance,
    });

    if (!chargedToBalance) return null;

    const result = await deductFromBalance(tx, {
      userId,
      organizationId,
      occurredAt,
      amountMicrodollars: chargedAmount,
      sourceId,
    });

    return result;
  });

  if (organizationId && organizationUsage) {
    scheduleOrganizationLowBalanceAlert(organizationId, organizationUsage);
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
    amountMicrodollars: number;
    sourceId: string;
  }
): Promise<OrganizationUsageMutationResult | null> {
  const { userId, organizationId, occurredAt, amountMicrodollars, sourceId } = params;
  if (organizationId) {
    const result = await recordOrganizationConsumption(tx, {
      organizationId,
      kiloUserId: userId,
      amountMicrodollars,
      occurredAt,
      source: 'exa',
      sourceId,
    });
    return result.organizationUsage;
  }

  const updated = await tx
    .update(kilocode_users)
    .set({
      microdollars_used: sql`${kilocode_users.microdollars_used} + ${amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, userId));
  // Charged usage must never commit without its balance debit. The organization
  // branch already fails when its row disappears; this keeps the personal branch
  // atomic now that it no longer depends on a mandatory Cost Insights capture.
  if ((updated.rowCount ?? 0) === 0) {
    throw new Error('user disappeared during Exa consumption');
  }
  return null;
}
