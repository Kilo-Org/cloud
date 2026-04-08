import { db } from '@/lib/drizzle';
import {
  exa_monthly_usage,
  exa_usage_log,
  kilocode_users,
  type MicrodollarUsage,
} from '@kilocode/db/schema';
import { ABUSE_CLASSIFICATION } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';
import { ingestOrganizationTokenUsage } from '@/lib/organizations/organization-usage';
import { captureException } from '@sentry/nextjs';

/**
 * Returns the user's total Exa spend (microdollars) for the current calendar month.
 * Single-row lookup on the counter table — always O(1).
 */
export async function getExaMonthlyUsage(userId: string): Promise<number> {
  const result = await db
    .select({ total: exa_monthly_usage.total_cost_microdollars })
    .from(exa_monthly_usage)
    .where(
      sql`${exa_monthly_usage.kilo_user_id} = ${userId} AND ${exa_monthly_usage.month} = date_trunc('month', now())::date`
    )
    .limit(1);

  return result[0]?.total ?? 0;
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
}): Promise<void> {
  const { userId, organizationId, path, costMicrodollars, chargedToBalance } = params;
  const chargedAmount = chargedToBalance ? costMicrodollars : 0;

  // 1. Upsert the monthly counter (atomic increment)
  await db.execute(sql`
    INSERT INTO ${exa_monthly_usage} (
      kilo_user_id, month, total_cost_microdollars, total_charged_microdollars, request_count
    )
    VALUES (
      ${userId},
      date_trunc('month', now())::date,
      ${costMicrodollars},
      ${chargedAmount},
      1
    )
    ON CONFLICT (kilo_user_id, month) DO UPDATE SET
      total_cost_microdollars = ${exa_monthly_usage.total_cost_microdollars} + ${costMicrodollars},
      total_charged_microdollars = ${exa_monthly_usage.total_charged_microdollars} + ${chargedAmount},
      request_count = ${exa_monthly_usage.request_count} + 1,
      updated_at = now()
  `);

  // 2. Append to the audit log (fire-and-forget — failure shouldn't block billing)
  try {
    await db.insert(exa_usage_log).values({
      kilo_user_id: userId,
      organization_id: organizationId ?? null,
      path,
      cost_microdollars: costMicrodollars,
      charged_to_balance: chargedToBalance,
    });
  } catch (error) {
    // Log table insert failure is non-fatal (partition might not exist yet)
    console.error('[exa] failed to insert usage log', error);
    captureException(error, { tags: { source: 'recordExaUsage-log' } });
  }

  // 3. If over the free tier, deduct from the Kilo credit balance
  if (chargedToBalance && costMicrodollars > 0) {
    await deductFromBalance(userId, organizationId, costMicrodollars, path);
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
    // Personal billing: directly increment the user's usage counter
    await db
      .update(kilocode_users)
      .set({
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
      })
      .where(eq(kilocode_users.id, userId));
  }
}
