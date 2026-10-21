import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { organizations, organization_memberships, kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-base-types';
import { grantEntityCreditForCategory } from '@kilocode/web-shared/lib/promotionalCredits';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

const RESET_INTERVAL_DAYS = 30;

type ResetResult = {
  organizationId: string;
  organizationName: string;
  previousBalance: number;
  newBalance: number;
  creditsGranted: number;
  skippedReason?: string;
  success: boolean;
  error?: string;
};

/**
 * Get the first owner of an organization.
 * Returns null if the org has no owners (e.g., invite not yet accepted).
 */
async function getOrganizationOwner(
  tx: DrizzleTransaction,
  organizationId: string
): Promise<User | null> {
  const result = await tx
    .select({
      user: kilocode_users,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(organization_memberships.kilo_user_id, kilocode_users.id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.role, 'owner')
      )
    )
    .limit(1);

  return result[0]?.user ?? null;
}

/**
 * Whether an organization is due for a top-up in the current window. Evaluated
 * both for candidate discovery and again under the row lock, so a run that lost
 * the window to a concurrent run sees the committed reset timestamp.
 */
function isDueForReset(settings: OrganizationSettings | null | undefined, cutoff: Date): boolean {
  if (!settings) return false;
  if (settings.oss_sponsorship_tier == null) return false;
  const monthlyAmountMicrodollars = settings.oss_monthly_credit_amount_microdollars ?? 0;
  if (!(monthlyAmountMicrodollars > 0)) return false;

  const lastResetAt = settings.oss_credits_last_reset_at;
  if (!lastResetAt) return true;
  return new Date(lastResetAt).getTime() < cutoff.getTime();
}

/**
 * Records the reset window without touching any other settings key: the merge
 * happens in Postgres against the row's current value.
 */
async function markResetTimestamp(
  tx: DrizzleTransaction,
  organizationId: string,
  resetAt: string
): Promise<void> {
  await tx
    .update(organizations)
    .set({
      settings: sql`jsonb_set(coalesce(${organizations.settings}, '{}'::jsonb), '{oss_credits_last_reset_at}', to_jsonb(${resetAt}::text))`,
    })
    .where(eq(organizations.id, organizationId));
}

/**
 * OSS Monthly Credit Top-up Cron Job
 *
 * Tops up credit balances for OSS sponsorship organizations every 30 days.
 * If the organization's balance is already at or above their monthly allocation,
 * no credits are granted (we don't take credits away).
 * Uses the standard credit granting function for proper audit trail and invariants.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
    console.warn(
      '[oss-monthly-reset] SECURITY: Invalid CRON job authorization attempt:',
      authHeader ? 'Invalid authorization header' : 'Missing authorization header'
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  console.log('[oss-monthly-reset] Starting OSS monthly credit top-up...');
  const startTime = Date.now();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - RESET_INTERVAL_DAYS);

  // Find OSS organizations due for credit top-up (using settings JSONB)
  const orgsDueForReset = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(
      and(
        // Is an OSS organization (has oss_sponsorship_tier in settings)
        sql`${organizations.settings}->>'oss_sponsorship_tier' IS NOT NULL`,
        // Has a monthly credit amount configured and > 0
        sql`(${organizations.settings}->>'oss_monthly_credit_amount_microdollars')::bigint > 0`,
        // Not deleted
        isNull(organizations.deleted_at),
        // Due for reset: never reset OR last reset was 30+ days ago
        or(
          sql`${organizations.settings}->>'oss_credits_last_reset_at' IS NULL`,
          lt(
            sql`(${organizations.settings}->>'oss_credits_last_reset_at')::timestamptz`,
            thirtyDaysAgo.toISOString()
          )
        )
      )
    );

  console.log(`[oss-monthly-reset] Found ${orgsDueForReset.length} organizations due for top-up`);

  const results: ResetResult[] = [];
  const now = new Date().toISOString();

  // Process each organization individually to prevent one failure from blocking others
  for (const rawOrg of orgsDueForReset) {
    const org = {
      ...rawOrg,
      currentBalance: rawOrg.total_microdollars_acquired - rawOrg.microdollars_used,
    };
    const result: ResetResult = {
      organizationId: org.id,
      organizationName: org.name,
      previousBalance: org.currentBalance,
      newBalance: org.currentBalance,
      creditsGranted: 0,
      success: false,
    };

    try {
      await db.transaction(async (tx: DrizzleTransaction) => {
        // The row lock is the first statement of the transaction, so the settings,
        // the balances and the due predicate are read after the organization's
        // reset window belongs to this run. A run that acquires the lock later
        // reads the committed timestamp and leaves the organization alone.
        const [lockedOrg] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, org.id))
          .for('update');

        if (!lockedOrg) {
          result.skippedReason = 'not_due_anymore';
          result.success = true;
          return;
        }

        const currentBalance = lockedOrg.total_microdollars_acquired - lockedOrg.microdollars_used;
        result.previousBalance = currentBalance;
        result.newBalance = currentBalance;

        const settings: OrganizationSettings = lockedOrg.settings ?? {};
        if (lockedOrg.deleted_at !== null || !isDueForReset(settings, thirtyDaysAgo)) {
          result.skippedReason = 'not_due_anymore';
          result.success = true;
          console.log(
            `[oss-monthly-reset] Skipped org ${lockedOrg.name} (${lockedOrg.id}): not due for a reset`
          );
          return;
        }

        const monthlyAmountMicrodollars = settings.oss_monthly_credit_amount_microdollars ?? 0;

        // Calculate how much to top up (only if below monthly allocation)
        const creditDeltaMicrodollars = monthlyAmountMicrodollars - currentBalance;

        // If balance is already at or above monthly allocation, just update timestamp
        if (creditDeltaMicrodollars <= 0) {
          await markResetTimestamp(tx, lockedOrg.id, now);

          result.skippedReason = 'balance_already_sufficient';
          result.success = true;
          console.log(
            `[oss-monthly-reset] Skipped org ${lockedOrg.name} (${lockedOrg.id}): balance ${currentBalance} >= monthly ${monthlyAmountMicrodollars}`
          );
          return;
        }

        // Get the organization owner for the credit grant
        const owner = await getOrganizationOwner(tx, lockedOrg.id);

        if (!owner) {
          // No owner yet (invite not accepted) - skip this org for now
          // We still update the timestamp so we don't keep retrying
          await markResetTimestamp(tx, lockedOrg.id, now);

          result.skippedReason = 'no_owner_found';
          result.success = true;
          console.log(
            `[oss-monthly-reset] Skipped org ${lockedOrg.name} (${lockedOrg.id}): no owner found (invite not accepted?)`
          );
          return;
        }

        // Grant credits using the standard function
        const creditDeltaUsd = creditDeltaMicrodollars / 1_000_000;
        const creditResult = await grantEntityCreditForCategory(
          { user: owner, organization: lockedOrg },
          {
            credit_category: 'oss-monthly-reset',
            counts_as_selfservice: false,
            amount_usd: creditDeltaUsd,
            description: `OSS sponsorship monthly top-up (tier ${settings.oss_sponsorship_tier ?? 'unknown'})`,
            dbOrTx: tx,
          }
        );

        if (!creditResult.success) {
          throw new Error(`Failed to grant credits: ${creditResult.message}`);
        }

        await markResetTimestamp(tx, lockedOrg.id, now);

        result.newBalance = monthlyAmountMicrodollars;
        result.creditsGranted = creditDeltaMicrodollars;
        result.success = true;
        console.log(
          `[oss-monthly-reset] Topped up org ${lockedOrg.name} (${lockedOrg.id}): ${currentBalance} -> ${monthlyAmountMicrodollars} (added ${creditDeltaMicrodollars})`
        );
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[oss-monthly-reset] Failed to top up credits for org ${org.name}:`, error);
      captureException(error, {
        tags: { endpoint: 'cron/oss-monthly-reset' },
        extra: {
          organizationId: org.id,
          organizationName: org.name,
        },
      });
    }

    results.push(result);
  }

  const duration = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;
  const skippedCount = results.filter(r => r.success && r.skippedReason).length;
  const toppedUpCount = results.filter(r => r.success && !r.skippedReason).length;

  const summary = {
    totalProcessed: orgsDueForReset.length,
    successCount,
    failureCount,
    skippedCount,
    toppedUpCount,
    results,
  };

  console.log(
    `[oss-monthly-reset] Completed in ${duration}ms: ${toppedUpCount} topped up, ${skippedCount} skipped, ${failureCount} failed`
  );

  return NextResponse.json(
    {
      success: failureCount === 0,
      summary,
      duration: `${duration}ms`,
      timestamp: now,
    },
    { status: 200 }
  );
}
