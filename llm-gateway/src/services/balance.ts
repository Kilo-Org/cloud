import { eq, and, not, sql, gt, notExists } from 'drizzle-orm';
import {
  kilocode_users,
  organizations,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  credit_transactions,
  kilo_pass_issuance_items,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import type { WorkerDb } from '../lib/db.js';
import { logger } from '../logger.js';

type OrganizationSettings = {
  model_allow_list?: string[];
  provider_allow_list?: string[];
  data_collection?: 'allow' | 'deny';
  minimum_balance?: number;
  minimum_balance_alert_email?: string[];
};

type BalanceResult = {
  balance: number;
  settings?: OrganizationSettings;
  plan?: 'teams' | 'enterprise';
};

const APP_URL = 'https://app.kilo.ai';
const FIRST_TOPUP_BONUS_AMOUNT = 20;

export async function getBalanceAndOrgSettings(
  organizationId: string | undefined,
  user: User,
  db: WorkerDb
): Promise<BalanceResult> {
  if (organizationId) {
    return getBalanceForOrganizationUser(organizationId, user.id, db);
  }

  // For individual users, balance = credits - usage
  const [freshUser] = await db
    .select({
      microdollars_used: kilocode_users.microdollars_used,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, user.id))
    .limit(1);

  if (!freshUser) {
    return { balance: 0 };
  }

  const balance =
    (Number(freshUser.total_microdollars_acquired) - Number(freshUser.microdollars_used)) /
    1_000_000;
  return { balance };
}

async function getBalanceForOrganizationUser(
  organizationId: string,
  userId: string,
  db: WorkerDb
): Promise<BalanceResult> {
  const result = await db
    .select({
      microdollar_limit: organization_user_limits.microdollar_limit,
      microdollar_usage: organization_user_usage.microdollar_usage,
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
      require_seats: organizations.require_seats,
      plan: organizations.plan,
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
        eq(organization_user_limits.limit_type, 'daily')
      )
    )
    .leftJoin(
      organization_user_usage,
      and(
        eq(organization_user_usage.organization_id, organizations.id),
        eq(organization_user_usage.kilo_user_id, userId),
        eq(organization_user_usage.limit_type, 'daily'),
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
    logger.debug('User is not a member of the organization');
    return { balance: 0, settings: {} };
  }

  const {
    microdollar_limit,
    microdollar_usage,
    total_microdollars_acquired,
    microdollars_used,
    settings,
    require_seats,
    plan,
  } = result[0];

  // TODO: Port credit expiration processing (processOrganizationExpirations)
  const organization_balance = total_microdollars_acquired - microdollars_used;

  // If organization requires seats, ignore any user limits
  if (require_seats) {
    return {
      balance: organization_balance / 1_000_000,
      settings: settings as OrganizationSettings,
      plan: plan as BalanceResult['plan'],
    };
  }

  // If user has no limits set, return organization's total balance
  if (microdollar_limit == null) {
    return {
      balance: organization_balance / 1_000_000,
      settings: settings as OrganizationSettings,
      plan: plan as BalanceResult['plan'],
    };
  }

  // User has limits - calculate remaining allowance
  const usageAmount = microdollar_usage || 0;
  const remainingAllowance = microdollar_limit - usageAmount;
  const cappedBalance = Math.min(remainingAllowance, organization_balance);

  return {
    balance: cappedBalance / 1_000_000,
    settings: settings as OrganizationSettings,
    plan: plan as BalanceResult['plan'],
  };
}

// --- usageLimitExceededResponse ---

async function summarizeUserPayments(
  userId: string,
  db: WorkerDb
): Promise<{ payments_count: number; payments_total_microdollars: number }> {
  const result = await db
    .select({
      payments_count: sql<number>`count(*)::int`,
      payments_total_microdollars: sql<number>`coalesce(sum(${credit_transactions.amount_microdollars}), 0)::float`,
    })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, userId),
        eq(credit_transactions.is_free, false),
        gt(credit_transactions.amount_microdollars, 0),
        notExists(
          db
            .select({ id: kilo_pass_issuance_items.id })
            .from(kilo_pass_issuance_items)
            .where(eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id))
        )
      )
    );

  return result[0] ?? { payments_count: 0, payments_total_microdollars: 0 };
}

export async function usageLimitExceededResponse(
  userId: string,
  balance: number | undefined,
  db: WorkerDb
): Promise<Response> {
  const payments = await summarizeUserPayments(userId, db);

  const title = !payments.payments_count ? 'Paid Model - Credits Required' : 'Low Credit Warning!';

  const message = !payments.payments_count
    ? `This is a paid model. To use paid models, you need to add credits. Get $${FIRST_TOPUP_BONUS_AMOUNT} free on your first topup!`
    : 'Add credits to continue, or switch to a free model';

  return Response.json(
    {
      error: {
        title,
        message,
        balance,
        buyCreditsUrl: APP_URL + '/profile',
      },
    },
    { status: 402 }
  );
}
