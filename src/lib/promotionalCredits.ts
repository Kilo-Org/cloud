import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { getCustomerInfo } from './customerInfo';
import type { User, Organization } from '@/db/schema';
import { credit_transactions, kilocode_users, organizations } from '@/db/schema';
import { and, count, eq, sql } from 'drizzle-orm';
import { createAuditLog } from './organizations/organization-audit-logs';
import { promoCreditCategoriesByKey } from './promoCreditCategories';
import PostHogClient from '@/lib/posthog';
import type { PromoCreditCategoryConfig } from './PromoCreditCategoryConfig';
import { toMicrodollars } from './utils';
import { logExceptInTest } from '@/lib/utils.server';
import { millisecondsInHour } from 'date-fns/constants';
import { successResult, type CustomResult } from '@/lib/maybe-result';

export type CreditEntity = { user: User; organization: Organization | null };

export type DbOrTx = typeof db | DrizzleTransaction;

export type GrantCreditOptions = Pick<PromoCreditCategoryConfig, 'credit_category'> & {
  counts_as_selfservice: boolean;
  /**
   * Optional transaction handle.
   *
   * When provided, all DB writes are executed on this transaction.
   */
  dbOrTx?: DbOrTx;
} & Partial<
    Pick<
      PromoCreditCategoryConfig,
      'amount_usd' | 'description' | 'credit_expiry_date' | 'expiry_hours'
    >
  >;

type GrantCreditResult = CustomResult<
  {
    message: string;
    amount_usd: number;
    credit_transaction_id: string;
  },
  { message: string }
>;

async function getTotalRedemptions(dbOrTx: DbOrTx, promoCreditCategory: string): Promise<number> {
  try {
    const result = await dbOrTx
      .select({ count: count() })
      .from(credit_transactions)
      .where(eq(credit_transactions.credit_category, promoCreditCategory));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { source: 'promotional_credits_redemption_count' },
      extra: { promoCreditCategory },
    });
    return 0;
  }
}

type EmailProcessResult = {
  success: boolean;
  message: string;
};

export async function redeemSelfServicePromoCode(
  user: User,
  credit_category: string
): Promise<EmailProcessResult> {
  return await grantCreditForCategory(user, { credit_category, counts_as_selfservice: true });
}

export function grantCreditForCategory(
  user: User,
  options: GrantCreditOptions
): Promise<GrantCreditResult> {
  return grantEntityCreditForCategory({ organization: null, user }, options);
}

export async function grantEntityCreditForCategory(
  entity: CreditEntity,
  options: GrantCreditOptions
): Promise<GrantCreditResult> {
  const promotion = promoCreditCategoriesByKey.get(options.credit_category);

  if (!promotion) {
    return { success: false, message: `Category ${options.credit_category} not found` };
  }
  return await grantCreditForCategoryConfig(entity, options, promotion);
}

export async function grantCreditForCategoryConfig(
  entity: CreditEntity,
  options: GrantCreditOptions,
  promotion: PromoCreditCategoryConfig
): Promise<GrantCreditResult> {
  const dbOrTx = options.dbOrTx ?? db;

  const user = entity.user;
  const organization_id = entity.organization?.id;
  if (options.counts_as_selfservice && !promotion.is_user_selfservicable) {
    return { success: false, message: 'Invalid promotional code' };
  }

  if (promotion.promotion_ends_at && new Date() > promotion.promotion_ends_at) {
    return { success: false, message: 'This promotional code has expired' };
  }

  if (typeof promotion.total_redemptions_allowed === 'number') {
    const totalRedemptions = await getTotalRedemptions(dbOrTx, promotion.credit_category);
    if (totalRedemptions >= promotion.total_redemptions_allowed) {
      return {
        success: false,
        message: 'This promotional code has reached its redemption limit',
      };
    }
  }

  const amount_usd = options.amount_usd ?? promotion.amount_usd;
  if (amount_usd === undefined) {
    return {
      success: false,
      message: `Missing required amount_usd for credit category ${promotion.credit_category}`,
    };
  }

  try {
    if (promotion.organization_requirement) {
      if (entity.organization == null)
        return {
          success: false,
          message: `Promo ${promotion.credit_category} applies to organizations only.`,
        };
      const requirementCheck = await promotion.organization_requirement(entity.organization);
      if (!requirementCheck.success) {
        logExceptInTest(
          `Organization requirement not met for ${promotion.credit_category}: ${requirementCheck.error}`
        );
        return { success: false, message: requirementCheck.error };
      }
    }

    if (promotion.customer_requirement) {
      if (entity.organization != null)
        return {
          success: false,
          message: `Promo ${promotion.credit_category} applies to individuals only.`,
        };
      const customerInfo = await getCustomerInfo(user, {});

      const requirementCheck = await promotion.customer_requirement(customerInfo);
      if (!requirementCheck.success) return { success: false, message: requirementCheck.error };
    }

    const entityName = entity.organization?.name ?? user.google_user_email;
    const description = options.description ?? promotion.description;
    const explicit_expiry_date = options.credit_expiry_date ?? promotion.credit_expiry_date;
    const expiry_hours = options.expiry_hours ?? promotion.expiry_hours;
    const expiryFromHours = computeExpiryDateFromHours(expiry_hours);
    const credit_expiry_date = getEarlierDate(explicit_expiry_date, expiryFromHours);
    const new_credit_transaction_id = crypto.randomUUID();
    const insertStatementBase = dbOrTx.insert(credit_transactions).values({
      id: new_credit_transaction_id,
      kilo_user_id: user.id,
      organization_id: organization_id,
      is_free: true,
      amount_microdollars: toMicrodollars(amount_usd),
      description: description,
      credit_category: promotion.credit_category,
      expiry_date: credit_expiry_date?.toISOString() || null,
      expiration_baseline_microdollars_used: credit_expiry_date
        ? organization_id
          ? (entity.organization?.microdollars_used ?? 0)
          : user.microdollars_used
        : null,
      original_baseline_microdollars_used: user.microdollars_used,
      check_category_uniqueness: promotion.is_idempotent,
    });
    const insertResult = await (promotion.is_idempotent
      ? insertStatementBase.onConflictDoNothing()
      : insertStatementBase);

    // Check if any rows were inserted
    if (insertResult.rowCount === 0) {
      return {
        success: false,
        message: promotion.is_idempotent
          ? `Code ${promotion.credit_category} has already been applied to ${entityName}.`
          : `FAIL: Code ${promotion.credit_category} not applied to ${entityName}.`,
      };
    }
    logExceptInTest(
      !organization_id
        ? `Adding ${amount_usd} promotional credits to user ${user.id}, ID: ${new_credit_transaction_id}`
        : `Granting ${amount_usd} promotional credits to organization ${organization_id} for user ${user.id}, ID: ${new_credit_transaction_id}`
    );

    if (!organization_id) {
      await dbOrTx
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(amount_usd)}`,
          // Update next_credit_expiration_at to the earlier of current value and new expiry
          ...(credit_expiry_date && {
            next_credit_expiration_at: sql`LEAST(${kilocode_users.next_credit_expiration_at}, ${credit_expiry_date.toISOString()})`,
          }),
        })
        .where(eq(kilocode_users.id, user.id));
    } else {
      await dbOrTx
        .update(organizations)
        .set({
          microdollars_balance: sql`${organizations.microdollars_balance} + ${toMicrodollars(amount_usd)}`,
          total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${toMicrodollars(amount_usd)}`,
          ...(credit_expiry_date && {
            next_credit_expiration_at: sql`LEAST(${organizations.next_credit_expiration_at}, ${credit_expiry_date.toISOString()})`,
          }),
        })
        .where(eq(organizations.id, organization_id));

      await createAuditLog({
        action: 'organization.promo_credit_granted',
        actor_id: user.id,
        actor_email: user.google_user_email,
        actor_name: user.google_user_name,
        organization_id: organization_id,
        message: `Granted $${amount_usd} promotional credit: ${description}`,
      });
    }

    try {
      const org_props = entity.organization
        ? {
            organization_id: organization_id,
            organization_name: entity.organization.name,
          }
        : {};
      PostHogClient().capture({
        distinctId: user.google_user_email,
        event: entity.organization
          ? 'organization_promotional_credits_issued'
          : 'promotional_credits_issued',
        properties: {
          credit_amount: amount_usd,
          credit_description: description,
          credit_category: promotion.credit_category,
          user_id: user.id,
          is_idempotent: !!promotion.is_idempotent,
          is_user_selfservicable: !!promotion.is_user_selfservicable,
          has_expiry: !!credit_expiry_date,
          expiry_date: credit_expiry_date?.toISOString(),
          ...org_props,
        },
      });
    } catch {
      // ignore PostHog errors
    }

    return successResult({
      message: !entity.organization
        ? `Successfully added $${amount_usd} credits to user ${user.id} (${user.google_user_email})`
        : `Successfully added $${amount_usd} credits to organization ${entity.organization.id} (${entity.organization.name})`,
      amount_usd,
      credit_transaction_id: new_credit_transaction_id,
    });
  } catch (error: unknown) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null) {
      errorMessage = JSON.stringify(error);
    } else if (error !== undefined && error !== null) {
      errorMessage = String(error);
    }
    return { success: false, message: errorMessage };
  }
}

/**
 * Check if a user has received a promotional credit category
 */
export async function hasReceivedPromotion(userId: string, promoId: string): Promise<boolean> {
  const result = await db
    .select({ id: credit_transactions.id })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, userId),
        eq(credit_transactions.credit_category, promoId)
      )
    )
    .limit(1);
  return result.length > 0;
}

const computeExpiryDateFromHours = (expiry_hours: number | undefined) =>
  expiry_hours ? new Date(Date.now() + expiry_hours * millisecondsInHour) : null;

const getEarlierDate = (
  date1: Date | null | undefined,
  date2: Date | null | undefined
): Date | null => (!(date1 && date2) ? (date1 ?? date2 ?? null) : date1 < date2 ? date1 : date2);
