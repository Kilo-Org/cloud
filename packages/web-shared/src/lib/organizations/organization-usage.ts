import type {
  MicrodollarUsage,
  Organization,
  OrganizationUserLimitType,
  User,
} from '@kilocode/db/schema';
import type { OrganizationPlan } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  organization_user_limits,
  organization_user_usage,
  organizations,
  organization_memberships,
  microdollar_usage,
  sharedCliSessions,
  cloud_agent_code_reviews,
  kilocode_users,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, sql, gte, lte, not, inArray, count } from 'drizzle-orm';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getBalanceForUser } from '@kilocode/web-shared/lib/user/balance';
import { processOrganizationExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import { startInactiveSpan } from '@sentry/nextjs';
import { AUTOCOMPLETE_MODEL } from '@kilocode/web-shared/lib/constants';
import { sendBalanceAlertEmail } from '@kilocode/web-shared/lib/email';
import { dispatchLowBalancePush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { after } from 'next/server';
import { subHours } from 'date-fns';
import { maybePerformOrganizationAutoTopUp } from '@kilocode/web-shared/lib/autoTopUp';

/**
 * The paying account's row as the balance check read it: the user for a personal request, the
 * organization for an org request. Bouncer's decide uses it to judge whether an account is
 * established.
 */
export type BalancePayer = {
  createdAt: string;
  microdollarsUsed: number;
  totalMicrodollarsAcquired: number;
};

type BalanceAndOrgSettings = {
  balance: number;
  settings?: OrganizationSettings;
  plan?: OrganizationPlan;
  balanceLimitedByUserAllowance?: boolean;
  /** Absent when the user is not a member of the organization. */
  payer?: BalancePayer;
};

/**
 * @param fromDb - Database instance to use (defaults to primary db, pass readDb for replica)
 */
export async function getBalanceAndOrgSettings(
  organizationId: string | undefined,
  user: User,
  fromDb: typeof db = db
): Promise<BalanceAndOrgSettings> {
  const balanceSpan = startInactiveSpan({ name: 'balance-check' });
  const result = organizationId
    ? await getBalanceForOrganizationUser(organizationId, user.id, { fromDb })
    : {
        ...(await getBalanceForUser(user)),
        balanceLimitedByUserAllowance: false,
        payer: {
          createdAt: user.created_at,
          microdollarsUsed: user.microdollars_used,
          totalMicrodollarsAcquired: user.total_microdollars_acquired,
        },
      };
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
): Promise<BalanceAndOrgSettings> {
  const { limitType = 'daily', fromDb = db } = options;
  const startTime = performance.now();
  logExceptInTest(
    `[getBalanceForOrganizationUser] Starting balance check for user ${userId} in org ${organizationId}`
  );

  const result = await fromDb
    .select({
      microdollar_limit: organization_user_limits.microdollar_limit,
      microdollar_usage: organization_user_usage.microdollar_usage,
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
      require_seats: organizations.require_seats,
      plan: organizations.plan,
      auto_top_up_enabled: organizations.auto_top_up_enabled,
      next_credit_expiration_at: organizations.next_credit_expiration_at,
      created_at: organizations.created_at,
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

  if (result.length === 0) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    logExceptInTest(
      `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: 0 (not a member)`
    );

    return { balance: 0, settings: {}, balanceLimitedByUserAllowance: false };
  }

  const {
    microdollar_limit,
    microdollar_usage,
    total_microdollars_acquired: initial_total_microdollars_acquired,
    microdollars_used,
    settings,
    require_seats,
    plan,
    auto_top_up_enabled,
    next_credit_expiration_at,
    created_at,
  } = result[0];

  let total_microdollars_acquired = initial_total_microdollars_acquired;
  let organization_balance = total_microdollars_acquired - microdollars_used;

  // Lazy credit expiry check (mirrors user pattern in getBalanceForUser)
  const expireBefore = subHours(new Date(), Math.random());
  const needsExpirationComputation =
    next_credit_expiration_at && expireBefore >= new Date(next_credit_expiration_at);

  if (needsExpirationComputation) {
    const expiryResult = await processOrganizationExpirations(
      {
        id: organizationId,
        microdollars_used,
        next_credit_expiration_at,
        total_microdollars_acquired,
      },
      expireBefore
    );
    if (expiryResult) {
      total_microdollars_acquired = expiryResult.total_microdollars_acquired;
      organization_balance = total_microdollars_acquired - microdollars_used;
    }
  }

  // Trigger org auto-top-up after expiration check so it receives post-expiry values
  after(() =>
    maybePerformOrganizationAutoTopUp({
      id: organizationId,
      auto_top_up_enabled,
      total_microdollars_acquired,
      microdollars_used,
    })
  );

  const payer: BalancePayer = {
    createdAt: created_at,
    microdollarsUsed: microdollars_used,
    totalMicrodollarsAcquired: total_microdollars_acquired,
  };

  // If organization requires seats, ignore any user limits and return full organization balance
  if (require_seats) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    logExceptInTest(
      `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: ${fromMicrodollars(organization_balance)} (require_seats: ignoring limits)`
    );

    return {
      balance: fromMicrodollars(organization_balance),
      settings,
      plan,
      balanceLimitedByUserAllowance: false,
      payer,
    };
  }

  if (microdollar_limit == null) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    logExceptInTest(
      `[getBalanceForOrganizationUser] Completed balance check for user ${userId} in org ${organizationId} in ${duration.toFixed(2)}ms - balance: ${fromMicrodollars(organization_balance)} (no limits)`
    );

    return {
      balance: fromMicrodollars(organization_balance),
      settings,
      plan,
      balanceLimitedByUserAllowance: false,
      payer,
    };
  }

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

  return {
    balance: fromMicrodollars(cappedBalance),
    settings,
    plan,
    // An organization top-up raises only the organization balance, so it clears
    // the block only while the member still has allowance left. An exhausted
    // allowance (remainingAllowance <= 0) is a per-user limit no top-up fixes.
    balanceLimitedByUserAllowance: remainingAllowance <= 0,
    payer,
  };
}

export type OrganizationUsageMutationResult = {
  crossedMinimumBalance: boolean;
  recipients: string[];
  minimumBalanceMicrodollars: number | null;
};

const NO_ORGANIZATION_BALANCE_ALERT: OrganizationUsageMutationResult = {
  crossedMinimumBalance: false,
  recipients: [],
  minimumBalanceMicrodollars: null,
};

export type OrganizationUsageMutationInput = Pick<
  MicrodollarUsage,
  'kilo_user_id' | 'organization_id' | 'cost' | 'created_at'
>;

export async function mutateOrganizationUsage(
  tx: DrizzleTransaction,
  usage: OrganizationUsageMutationInput
): Promise<OrganizationUsageMutationResult> {
  const { cost, kilo_user_id, organization_id, created_at } = usage;
  if (!organization_id) return NO_ORGANIZATION_BALANCE_ALERT;

  const limitType: OrganizationUserLimitType = 'daily';
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
      (${created_at}::timestamptz AT TIME ZONE 'UTC')::date,
      ${limitType},
      ${cost},
      NOW(),
      NOW()
    WHERE EXISTS (
      SELECT 1
      FROM ${organization_memberships}
      WHERE ${organization_memberships.organization_id} = ${organization_id}
        AND ${organization_memberships.kilo_user_id} = ${kilo_user_id}
    )
      AND EXISTS (
        SELECT 1
        FROM ${organizations}
        WHERE ${organizations.id} = ${organization_id}
      )
    ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
    DO UPDATE SET
      microdollar_usage = ${organization_user_usage.microdollar_usage} + ${cost},
      updated_at = NOW()
  `);

  const [orgData] = await tx
    .update(organizations)
    .set({
      microdollars_used: sql`${organizations.microdollars_used} + ${cost}`,
      microdollars_balance: sql`${organizations.microdollars_balance} - ${cost}`,
    })
    .where(eq(organizations.id, organization_id))
    .returning({
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      previous_microdollars_used: sql<number>`${organizations.microdollars_used} - ${cost}`.mapWith(
        Number
      ),
      new_microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
    });

  if (!orgData) return NO_ORGANIZATION_BALANCE_ALERT;

  const currentBalance = orgData.total_microdollars_acquired - orgData.previous_microdollars_used;
  const newBalance = orgData.total_microdollars_acquired - orgData.new_microdollars_used;
  const minimumBalance = orgData.settings?.minimum_balance
    ? toMicrodollars(orgData.settings.minimum_balance)
    : null;
  const crossedMinimumBalance =
    minimumBalance != null && currentBalance >= minimumBalance && newBalance < minimumBalance;
  const recipients = crossedMinimumBalance
    ? (orgData.settings?.minimum_balance_alert_email ?? [])
    : [];

  return {
    crossedMinimumBalance,
    recipients,
    minimumBalanceMicrodollars: minimumBalance,
  };
}

export function scheduleOrganizationLowBalanceAlert(
  organizationId: Organization['id'],
  result: OrganizationUsageMutationResult
): void {
  const { crossedMinimumBalance, minimumBalanceMicrodollars, recipients } = result;
  if (!crossedMinimumBalance || minimumBalanceMicrodollars == null) return;

  logExceptInTest(
    `[ingestOrganizationTokenUsage] Balance alert triggered for org ${organizationId}: threshold=${fromMicrodollars(minimumBalanceMicrodollars)} recipients=${recipients.length}`
  );
  after(async () => {
    await sendBalanceAlertEmail({
      organizationId,
      minimum_balance: fromMicrodollars(minimumBalanceMicrodollars),
      to: recipients,
    }).catch(err => {
      console.error('[ingestOrganizationTokenUsage] Failed to send balance alert email:', err);
    });

    // Best-effort mobile push: never block or fail the email path.
    try {
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      if (!org) {
        console.error(
          `[ingestOrganizationTokenUsage] Skipping low-balance push: org ${organizationId} not found`
        );
        return;
      }

      if (recipients.length === 0) return;

      const memberUsers = await db
        .select({ id: kilocode_users.id })
        .from(kilocode_users)
        .innerJoin(
          organization_memberships,
          and(
            eq(organization_memberships.kilo_user_id, kilocode_users.id),
            eq(organization_memberships.organization_id, organizationId)
          )
        )
        .where(inArray(kilocode_users.google_user_email, recipients));

      const recipientUserIds = [...new Set(memberUsers.map(u => u.id))];
      if (recipientUserIds.length === 0) return;

      await dispatchLowBalancePush({
        recipientUserIds,
        organizationId,
        organizationName: org.name,
        minimumBalanceUsd: fromMicrodollars(minimumBalanceMicrodollars),
      }).catch(err => {
        console.error('[ingestOrganizationTokenUsage] Failed to dispatch low-balance push:', err);
      });
    } catch (err) {
      console.error('[ingestOrganizationTokenUsage] Failed to dispatch low-balance push:', err);
    }
  });
}

export async function ingestOrganizationTokenUsage(usage: MicrodollarUsage): Promise<void> {
  if (!usage.organization_id) return;
  const result = await db.transaction(tx => mutateOrganizationUsage(tx, usage));
  scheduleOrganizationLowBalanceAlert(usage.organization_id, result);
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
