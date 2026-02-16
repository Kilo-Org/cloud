import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { organizations, organization_memberships, kilocode_users } from '@/db/schema';
import type { Organization, User } from '@/db/schema';
import type { OrganizationSettings } from '@/lib/organizations/organization-base-types';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';

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
      currentBalance:
        sql<number>`${organizations.total_microdollars_acquired} - ${organizations.microdollars_used}`.as(
          'currentBalance'
        ),
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
  for (const org of orgsDueForReset) {
    const monthlyAmountMicrodollars = org.settings.oss_monthly_credit_amount_microdollars ?? 0;

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
        // Calculate how much to top up (only if below monthly allocation)
        const creditDeltaMicrodollars = monthlyAmountMicrodollars - org.currentBalance;

        // Always update the reset timestamp in settings
        const updatedSettings: OrganizationSettings = {
          ...org.settings,
          oss_credits_last_reset_at: now,
        };

        // If balance is already at or above monthly allocation, just update timestamp
        if (creditDeltaMicrodollars <= 0) {
          await tx
            .update(organizations)
            .set({ settings: updatedSettings })
            .where(eq(organizations.id, org.id));

          result.skippedReason = 'balance_already_sufficient';
          result.success = true;
          console.log(
            `[oss-monthly-reset] Skipped org ${org.name} (${org.id}): balance ${org.currentBalance} >= monthly ${monthlyAmountMicrodollars}`
          );
          return;
        }

        // Get the organization owner for the credit grant
        const owner = await getOrganizationOwner(tx, org.id);

        if (!owner) {
          // No owner yet (invite not accepted) - skip this org for now
          // We still update the timestamp so we don't keep retrying
          await tx
            .update(organizations)
            .set({ settings: updatedSettings })
            .where(eq(organizations.id, org.id));

          result.skippedReason = 'no_owner_found';
          result.success = true;
          console.log(
            `[oss-monthly-reset] Skipped org ${org.name} (${org.id}): no owner found (invite not accepted?)`
          );
          return;
        }

        // Fetch the full organization record for the credit grant
        const [orgRecord] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, org.id))
          .limit(1);

        if (!orgRecord) {
          throw new Error(`Organization ${org.id} not found`);
        }

        // Grant credits using the standard function
        const creditDeltaUsd = creditDeltaMicrodollars / 1_000_000;
        const creditResult = await grantEntityCreditForCategory(
          { user: owner, organization: orgRecord as Organization },
          {
            credit_category: 'oss-monthly-reset',
            counts_as_selfservice: false,
            amount_usd: creditDeltaUsd,
            description: `OSS sponsorship monthly top-up (tier ${org.settings.oss_sponsorship_tier ?? 'unknown'})`,
            dbOrTx: tx,
          }
        );

        if (!creditResult.success) {
          throw new Error(`Failed to grant credits: ${creditResult.message}`);
        }

        // Update the reset timestamp in settings
        await tx
          .update(organizations)
          .set({ settings: updatedSettings })
          .where(eq(organizations.id, org.id));

        result.newBalance = monthlyAmountMicrodollars;
        result.creditsGranted = creditDeltaMicrodollars;
        result.success = true;
        console.log(
          `[oss-monthly-reset] Topped up org ${org.name} (${org.id}): ${org.currentBalance} -> ${monthlyAmountMicrodollars} (added ${creditDeltaMicrodollars})`
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
