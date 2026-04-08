import { db } from '@/lib/drizzle';
import {
  exa_monthly_usage,
  exa_usage_log,
  kilocode_users,
  type MicrodollarUsage,
  type User,
} from '@kilocode/db/schema';
import { ABUSE_CLASSIFICATION } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';
import { ingestOrganizationTokenUsage } from '@/lib/organizations/organization-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@/lib/constants';

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
 * Records a single Exa request:
 * 1. Upserts exa_monthly_usage counter (atomic increment).
 * 2. Appends to exa_usage_log (audit trail).
 * 3. If chargedToBalance, deducts from the user's (or org's) Kilo credit balance.
 */
export async function recordExaUsage(params: {
  userId: string;
  organizationId: string | undefined;
  path: string;
  costMicrodollars: number;
  chargedToBalance: boolean;
  freeAllowanceMicrodollars: number;
}): Promise<void> {
  const {
    userId,
    organizationId,
    path,
    costMicrodollars,
    chargedToBalance,
    freeAllowanceMicrodollars,
  } = params;
  const chargedAmount = chargedToBalance ? costMicrodollars : 0;

  // 1. Append to the usage log first. This is the source of truth for balance
  // recomputation, so it must succeed before we touch any counters. If this
  // fails (e.g. missing partition), nothing else is modified and recompute
  // can still reconcile from the log rows that do exist.
  await db.insert(exa_usage_log).values({
    kilo_user_id: userId,
    organization_id: organizationId ?? null,
    path,
    cost_microdollars: costMicrodollars,
    charged_to_balance: chargedToBalance,
  });

  // 2. Upsert the monthly counter (atomic increment).
  // free_allowance_microdollars is set on INSERT (first request of the month)
  // but NOT updated on conflict — the first-of-month value is locked in.
  // Two partial unique indexes exist: one for personal (org IS NULL) and one
  // for org usage (org IS NOT NULL), so the upsert must target the right one.
  await upsertMonthlyCounter({
    userId,
    organizationId,
    costMicrodollars,
    chargedAmount,
    freeAllowanceMicrodollars,
  });

  // 3. If over the free tier, deduct from the Kilo credit balance.
  // If this fails, the log row exists so recompute can recover.
  if (chargedToBalance && costMicrodollars > 0) {
    await deductFromBalance(userId, organizationId, costMicrodollars, path);
  }
}

/**
 * Upserts the monthly counter row, targeting the correct partial unique index
 * based on whether the request is personal (no org) or org-scoped.
 */
async function upsertMonthlyCounter(params: {
  userId: string;
  organizationId: string | undefined;
  costMicrodollars: number;
  chargedAmount: number;
  freeAllowanceMicrodollars: number;
}): Promise<void> {
  const { userId, organizationId, costMicrodollars, chargedAmount, freeAllowanceMicrodollars } =
    params;

  const doUpdateSet = sql`
    total_cost_microdollars = ${exa_monthly_usage.total_cost_microdollars} + ${costMicrodollars},
    total_charged_microdollars = ${exa_monthly_usage.total_charged_microdollars} + ${chargedAmount},
    request_count = ${exa_monthly_usage.request_count} + 1,
    updated_at = now()
  `;

  if (organizationId) {
    await db.execute(sql`
      INSERT INTO ${exa_monthly_usage} (
        kilo_user_id, organization_id, month,
        total_cost_microdollars, total_charged_microdollars, request_count, free_allowance_microdollars
      ) VALUES (
        ${userId}, ${organizationId}, date_trunc('month', now())::date,
        ${costMicrodollars}, ${chargedAmount}, 1, ${freeAllowanceMicrodollars}
      )
      ON CONFLICT (kilo_user_id, organization_id, month)
        WHERE organization_id IS NOT NULL
      DO UPDATE SET ${doUpdateSet}
    `);
  } else {
    await db.execute(sql`
      INSERT INTO ${exa_monthly_usage} (
        kilo_user_id, month,
        total_cost_microdollars, total_charged_microdollars, request_count, free_allowance_microdollars
      ) VALUES (
        ${userId}, date_trunc('month', now())::date,
        ${costMicrodollars}, ${chargedAmount}, 1, ${freeAllowanceMicrodollars}
      )
      ON CONFLICT (kilo_user_id, month)
        WHERE organization_id IS NULL
      DO UPDATE SET ${doUpdateSet}
    `);
  }
}

/**
 * Deducts Exa overage cost from the user's personal balance or their org's balance.
 * Personal: increments kilocode_users.microdollars_used.
 * Org: delegates to ingestOrganizationTokenUsage which handles org balance + daily limits + alerts.
 */
async function deductFromBalance(
  userId: string,
  organizationId: string | undefined,
  costMicrodollars: number,
  path: string
): Promise<void> {
  if (organizationId) {
    // Org billing: reuse the existing org billing pipeline which handles
    // balance updates, per-user daily tracking, and low-balance alerts.
    const usageRecord = {
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: costMicrodollars,
      organization_id: organizationId,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: new Date().toISOString(),
      provider: 'exa',
      model: path,
      requested_model: null,
      cache_discount: null,
      has_error: false,
      abuse_classification: ABUSE_CLASSIFICATION.NOT_CLASSIFIED,
      inference_provider: null,
      project_id: null,
    } satisfies MicrodollarUsage;

    await ingestOrganizationTokenUsage(usageRecord);
  } else {
    // Personal billing: directly increment the user's usage counter.
    // WARNING: Do NOT also insert into microdollar_usage here. Recompute
    // (recomputeUserBalances) already picks up personal Exa charges from
    // exa_usage_log. Adding a microdollar_usage row would double-count.
    await db
      .update(kilocode_users)
      .set({
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
      })
      .where(eq(kilocode_users.id, userId));
  }
}
