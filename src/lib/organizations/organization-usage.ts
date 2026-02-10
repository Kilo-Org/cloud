import type { MicrodollarUsage, Organization, OrganizationUserLimitType, User } from '@/db/schema';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import {
  organization_user_limits,
  organization_user_usage,
  organizations,
  organization_memberships,
  microdollar_usage,
  sharedCliSessions,
  cloud_agent_code_reviews,
} from '@/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { and, eq, sql, gte, lte, not, inArray, count } from 'drizzle-orm';
import { fromMicrodollars, toMicrodollars } from '@/lib/utils';
import { logExceptInTest } from '@/lib/utils.server';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { getBalanceForUser } from '@/lib/user.balance';
import { startInactiveSpan } from '@sentry/nextjs';
import { AUTOCOMPLETE_MODEL } from '@/lib/constants';
import { sendBalanceAlertEmail } from '@/lib/email';
import { after } from 'next/server';
import { maybePerformOrganizationAutoTopUp } from '@/lib/autoTopUp';

/**
 * @param fromDb - Database instance to use (defaults to primary db, pass readDb for replica)
 */
export async function getBalanceAndOrgSettings(
  organizationId: string | undefined,
  user: User,
  fromDb: typeof db = db
): Promise<{
  balance: number;
  settings?: OrganizationSettings;
  plan?: OrganizationPlan;
}> {
  const balanceSpan = startInactiveSpan({ name: 'balance-check' });
  const result = organizationId
    ? await getBalanceForOrganizationUser(organizationId, user.id, { fromDb })
    : await getBalanceForUser(user);
  balanceSpan.end();
  return result;
}

export async function getBalanceForOrganizationUser(
  organizationId: Organization['id'],
  userId: User['id'],
  options: {
    /** Limit type to check (defaults to 'daily') */
    limitType?: OrganizationUserLimitType;
    /** Database instance to use (defaults to primary db, pass readDb for replica) */
    fromDb?: typeof db;
  } = {}
): Promise<{ balance: number; settings?: OrganizationSettings; plan?: OrganizationPlan }> {
  const { limitType = 'daily', fromDb = db } = options;
  const startTime = performance.now();
  logExceptInTest(
    `[getBalanceForOrganizationUser] Starting balance check for user ${userId} in org ${organizationId}`
  );

  // Single query to get user limits, usage, organization balance, require_seats, and verify membership
  const result = await fromDb
    .select({
      microdollar_limit: organization_user_limits.microdollar_limit,
      microdollar_usage: organization_user_usage.microdollar_usage,
      organization_balance: organizations.microdollars_balance,
      settings: organizations.settings,
      require_seats: organizations.require_seats,
      plan: organizations.plan,
      auto_top_up_enabled: organizations.auto_top_up_enabled,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .leftJoin(
      organization_user_limits,
      and(
        eq(organization_user_limits.organization_id, organizations.id),
        eq(organization_user_limits.kilo_user_id, userId),
        eq(organization_user_limits.limit_type, limitType)
      )
    )
    .leftJoin(
      organization_user_usage,
      and(
        eq(organization_user_usage.organization_id, organizations.id),
        eq(organization_user_usage.kilo_user_id, userId),
        eq(organization_user_usage.limit_type, limitType),
        eq(organization_user_usage.usage_date, sql`CURRENT_DATE`)
      )
    )
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organization_memberships.kilo_user_id, userId),
        not(eq(organization_memberships.role, 'billing_manager'))
      )
    )
    .limit(1);

  // If no result, user is not a member of the organization
  if (result.length === 0) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    logExceptInTest(
      `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: 0 (not a member)`
    );

    return { balance: 0, settings: {} };
  }

  const {
    microdollar_limit,
    microdollar_usage,
    organization_balance,
    settings,
    require_seats,
    plan,
    auto_top_up_enabled,
  } = result[0];

  // Trigger org auto-top-up on balance observation (mirrors user pattern in getBalanceForUser)
  after(() =>
    maybePerformOrganizationAutoTopUp({
      id: organizationId,
      auto_top_up_enabled,
      microdollars_balance: organization_balance,
    })
  );

  // If organization requires seats, ignore any user limits and return full organization balance
  if (require_seats) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    logExceptInTest(
      `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: ${fromMicrodollars(organization_balance)} (require_seats: ignoring limits)`
    );

    return { balance: fromMicrodollars(organization_balance), settings, plan };
  }

  // If user has no limits set, return organization's total balance
  if (microdollar_limit == null) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    logExceptInTest(
      `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: ${fromMicrodollars(organization_balance)} (no limits)`
    );

    return { balance: fromMicrodollars(organization_balance), settings, plan };
  }

  // User has limits - calculate remaining allowance
  const usageAmount = microdollar_usage || 0;
  const remainingAllowance = microdollar_limit - usageAmount;

  // Cap the remaining allowance at the organization's actual balance
  // This ensures a user's balance cannot exceed what the organization has available
  const cappedBalance = Math.min(remainingAllowance, organization_balance);

  // Return capped balance (can be negative if over limit or org has negative balance)
  const endTime = performance.now();
  const duration = endTime - startTime;
  logExceptInTest(
    `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: ${fromMicrodollars(cappedBalance)} (allowance: ${fromMicrodollars(remainingAllowance)}, org balance: ${fromMicrodollars(organization_balance)})`
  );

  return { balance: fromMicrodollars(cappedBalance), settings, plan };
}

export async function ingestOrganizationTokenUsage(usage: MicrodollarUsage): Promise<void> {
  const { cost, kilo_user_id, organization_id } = usage;

  if (!organization_id) return;
  return await db.transaction(async tx => {
    // Get current balance and settings before the update
    const [orgData] = await tx
      .select({
        microdollars_balance: organizations.microdollars_balance,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.id, organization_id))
      .limit(1);

    const currentBalance = orgData?.microdollars_balance ?? 0;

    const minimumBalance = orgData?.settings?.minimum_balance
      ? toMicrodollars(orgData?.settings?.minimum_balance)
      : null;

    const newBalance = currentBalance - cost;

    // Check if balance is crossing the minimum_balance threshold
    if (minimumBalance != null && currentBalance >= minimumBalance && newBalance < minimumBalance) {
      const alertEmails = orgData?.settings?.minimum_balance_alert_email ?? [];
      // Send email notification about low balance (fire and forget - don't block the transaction)
      sendBalanceAlertEmail({
        organizationId: organization_id,
        minimum_balance: fromMicrodollars(minimumBalance),
        to: alertEmails,
      }).catch(err => {
        console.error('[ingestOrganizationTokenUsage] Failed to send balance alert email:', err);
      });
    }

    // Update organization balance and usage (always happens regardless of membership)
    await tx
      .update(organizations)
      .set({
        microdollars_balance: sql`${organizations.microdollars_balance} - ${cost}`,
        microdollars_used: sql`${organizations.microdollars_used} + ${cost}`,
      })
      .where(eq(organizations.id, organization_id));

    const limitType: OrganizationUserLimitType = 'daily';
    // Track user usage only if they are a member of the organization
    // Use INSERT with a subquery that only inserts if the user is a member
    await tx.execute(sql`
      INSERT INTO ${organization_user_usage} (
        organization_id,
        kilo_user_id,
        usage_date,
        limit_type,
        microdollar_usage,
        created_at,
        updated_at
      )
      SELECT
        ${organization_id},
        ${kilo_user_id},
        CURRENT_DATE,
        ${limitType},
        ${cost},
        NOW(),
        NOW()
      ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
      DO UPDATE SET
        microdollar_usage = ${organization_user_usage.microdollar_usage} + ${cost},
        updated_at = NOW()
    `);
  });
}

const MAX_DAILY_LIMIT_USD = 2000;

export async function updateOrganizationUserLimit(
  organizationId: Organization['id'],
  userId: User['id'],
  dailyUsageLimitUsd: number | null,
  limitType: OrganizationUserLimitType = 'daily',
  txn?: DrizzleTransaction
): Promise<void> {
  const dbInstance = txn || db;

  if (dailyUsageLimitUsd === null) {
    // Delete existing limit for unlimited usage
    await dbInstance
      .delete(organization_user_limits)
      .where(
        and(
          eq(organization_user_limits.organization_id, organizationId),
          eq(organization_user_limits.kilo_user_id, userId),
          eq(organization_user_limits.limit_type, limitType)
        )
      );
  } else {
    // Validate the limit is within acceptable range
    if (dailyUsageLimitUsd < 0 || dailyUsageLimitUsd > MAX_DAILY_LIMIT_USD) {
      throw new Error(`Daily usage limit must be between $0 and $${MAX_DAILY_LIMIT_USD}`);
    }

    // Insert or update limit (including 0 for no usage allowed)
    const microdollarLimit = toMicrodollars(dailyUsageLimitUsd);
    await dbInstance
      .insert(organization_user_limits)
      .values({
        organization_id: organizationId,
        kilo_user_id: userId,
        limit_type: limitType,
        microdollar_limit: microdollarLimit,
      })
      .onConflictDoUpdate({
        target: [
          organization_user_limits.organization_id,
          organization_user_limits.kilo_user_id,
          organization_user_limits.limit_type,
        ],
        set: { microdollar_limit: microdollarLimit },
      });
  }
}

/**
 * Fetch agent interactions (non-autocomplete usage) per day for given users
 */
export async function getAgentInteractionsPerDay(
  organizationId: Organization['id'],
  userIds: string[],
  startDate: string,
  endDate: string
) {
  return await db
    .select({
      userId: microdollar_usage.kilo_user_id,
      date: sql<string>`DATE(${microdollar_usage.created_at})`.as('date'),
      requestCount: count(microdollar_usage.id),
    })
    .from(microdollar_usage)
    .where(
      and(
        eq(microdollar_usage.organization_id, organizationId),
        gte(microdollar_usage.created_at, startDate),
        lte(microdollar_usage.created_at, endDate),
        not(eq(microdollar_usage.model, AUTOCOMPLETE_MODEL)),
        inArray(microdollar_usage.kilo_user_id, userIds)
      )
    )
    .groupBy(microdollar_usage.kilo_user_id, sql`DATE(${microdollar_usage.created_at})`);
}

/**
 * Fetch cloud agent sessions per day for given users
 */
export async function getCloudAgentSessionsPerDay(
  userIds: string[],
  startDate: string,
  endDate: string
) {
  return await db
    .select({
      userId: sharedCliSessions.kilo_user_id,
      date: sql<string>`DATE(${sharedCliSessions.created_at})`.as('date'),
      sessionCount: count(sharedCliSessions.share_id),
    })
    .from(sharedCliSessions)
    .where(
      and(
        gte(sharedCliSessions.created_at, startDate),
        lte(sharedCliSessions.created_at, endDate),
        inArray(sharedCliSessions.kilo_user_id, userIds)
      )
    )
    .groupBy(sharedCliSessions.kilo_user_id, sql`DATE(${sharedCliSessions.created_at})`);
}

/**
 * Fetch code review runs per day for given users
 */
export async function getCodeReviewsPerDay(
  organizationId: Organization['id'],
  userIds: string[],
  startDate: string,
  endDate: string
) {
  return await db
    .select({
      userId: cloud_agent_code_reviews.owned_by_user_id,
      date: sql<string>`DATE(${cloud_agent_code_reviews.created_at})`.as('date'),
      reviewCount: count(cloud_agent_code_reviews.id),
    })
    .from(cloud_agent_code_reviews)
    .where(
      and(
        eq(cloud_agent_code_reviews.owned_by_organization_id, organizationId),
        gte(cloud_agent_code_reviews.created_at, startDate),
        lte(cloud_agent_code_reviews.created_at, endDate),
        inArray(cloud_agent_code_reviews.owned_by_user_id, userIds)
      )
    )
    .groupBy(
      cloud_agent_code_reviews.owned_by_user_id,
      sql`DATE(${cloud_agent_code_reviews.created_at})`
    );
}
