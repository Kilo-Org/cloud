import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { getCustomerInfo } from './customerInfo';
import type { User, Organization } from '@kilocode/db/schema';
import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { and, count, eq, sql } from 'drizzle-orm';
import { createAuditLog } from './organizations/organization-audit-logs';
import { promoCreditCategoriesByKey } from './promoCreditCategories';
import PostHogClient from '@kilocode/web-shared/lib/posthog';
import type { PromoCreditCategoryConfig } from './PromoCreditCategoryConfig';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { millisecondsInHour } from 'date-fns/constants';
import { successResult, type CustomResult } from '@kilocode/web-shared/lib/maybe-result';

export type CreditEntity = { user: User; organization: Organization | null };

export type DbOrTx = typeof db | DrizzleTransaction;

export type GrantCreditOptions = Pick<PromoCreditCategoryConfig, 'credit_category'> & {
  counts_as_selfservice: boolean;
  /**
   * Optional transaction handle.
   *
   * When provided, all DB writes are executed on this transaction. Passing a
   * non-transactional `db` handle is not supported: the grant flow (cap check,
   * insert, balance updates) must commit atomically.
   */
  dbOrTx?: DrizzleTransaction;
  created_by_kilo_user_id?: User['id'];
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

/**
 * Substrings embedded in the failure `message` of `GrantCreditResult` that
 * callers (like `grantCreditCampaignBonus` in credit-campaigns.ts) branch
 * on to recover from expected race/idempotency outcomes. Exporting as
 * named constants so the message text and the caller stay pinned to the
 * same source of truth — changing the message below will break callers
 * at compile/test time rather than silently routing to the generic error
 * branch.
 */
export const GRANT_MSG_ALREADY_APPLIED = 'has already been applied';
export const GRANT_MSG_CAP_REACHED = 'reached its redemption limit';

async function getTotalRedemptions(dbOrTx: DbOrTx, promoCreditCategory: string): Promise<number> {
  const result = await dbOrTx
    .select({ count: count() })
    .from(credit_transactions)
    .where(eq(credit_transactions.credit_category, promoCreditCategory));

  return result[0]?.count || 0;
}

type EmailProcessResult = {
  success: boolean;
  message: string;
};

export async function redeemSelfServicePromoCode(
  user: User,
  credit_category: string
): Promise<EmailProcessResult> {
  return await grantCreditForCategory(user, {
    credit_category,
    counts_as_selfservice: true,
  });
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
    return {
      success: false,
      message: `Category ${options.credit_category} not found`,
    };
  }
  return await grantCreditForCategoryConfig(entity, options, promotion);
}

export async function grantCreditForCategoryConfig(
  entity: CreditEntity,
  options: GrantCreditOptions,
  promotion: PromoCreditCategoryConfig
): Promise<GrantCreditResult> {
  const user = entity.user;
  if (options.counts_as_selfservice && !promotion.is_user_selfservicable) {
    return { success: false, message: 'Invalid promotional code' };
  }

  if (promotion.promotion_ends_at && new Date() > promotion.promotion_ends_at) {
    return { success: false, message: 'This promotional code has expired' };
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

    // The redemption cap must be enforced in the same transaction as the
    // insert. Serialize capped categories on a transaction-scoped advisory
    // lock, then check the count inside the transaction that inserts.
    const capped = typeof promotion.total_redemptions_allowed === 'number';
    if (options.dbOrTx) {
      if (capped) {
        await takePromoCapLock(options.dbOrTx, promotion.credit_category);
      }
      return await executeGrant({
        entity,
        options,
        promotion,
        dbOrTx: options.dbOrTx,
        amount_usd,
      });
    }
    return await db.transaction(async tx => {
      if (capped) {
        await takePromoCapLock(tx, promotion.credit_category);
      }
      return await executeGrant({ entity, options, promotion, dbOrTx: tx, amount_usd });
    });
  } catch (error: unknown) {
    // Error details are reported to internal monitoring; callers and users
    // get a generic message.
    captureException(error, {
      tags: { source: 'promotional_credits_grant' },
    });
    return { success: false, message: 'Failed to apply promotional credit' };
  }
}

const PROMO_CAP_LOCK_NAMESPACE = 'promo-credit-cap';

/**
 * Serialize redemptions of one capped credit category for the duration of the
 * caller's transaction. The lock key is namespaced so it cannot contend with
 * other features' advisory locks. Released automatically on commit/rollback.
 */
async function takePromoCapLock(
  tx: DrizzleTransaction,
  promoCreditCategory: string
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${PROMO_CAP_LOCK_NAMESPACE}:${promoCreditCategory}`}))`
  );
}

async function executeGrant({
  entity,
  options,
  promotion,
  dbOrTx,
  amount_usd,
}: {
  entity: CreditEntity;
  options: GrantCreditOptions;
  promotion: PromoCreditCategoryConfig;
  // Callers either pass `options.dbOrTx` (always a transaction in practice)
  // or a freshly opened transaction from `db.transaction`.
  dbOrTx: DrizzleTransaction;
  amount_usd: number;
}): Promise<GrantCreditResult> {
  const user = entity.user;
  const organization_id = entity.organization?.id;

  if (typeof promotion.total_redemptions_allowed === 'number') {
    // The count is read on the granting transaction; a query error here
    // propagates and rolls the transaction back, and the outer catch
    // reports it.
    const totalRedemptions = await getTotalRedemptions(dbOrTx, promotion.credit_category);
    if (totalRedemptions >= promotion.total_redemptions_allowed) {
      return {
        success: false,
        message: `This promotional code ${GRANT_MSG_CAP_REACHED}`,
      };
    }
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
    created_by_kilo_user_id: options.created_by_kilo_user_id,
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
    original_baseline_microdollars_used: organization_id
      ? (entity.organization?.microdollars_used ?? 0)
      : user.microdollars_used,
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
        ? `Code ${promotion.credit_category} ${GRANT_MSG_ALREADY_APPLIED} to ${entityName}.`
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
          next_credit_expiration_at: sql`COALESCE(LEAST(${kilocode_users.next_credit_expiration_at}, ${credit_expiry_date.toISOString()}), ${credit_expiry_date.toISOString()})`,
        }),
      })
      .where(eq(kilocode_users.id, user.id));
  } else {
    await dbOrTx
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${toMicrodollars(amount_usd)}`,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${toMicrodollars(amount_usd)}`,
        ...(credit_expiry_date && {
          next_credit_expiration_at: sql`COALESCE(LEAST(${organizations.next_credit_expiration_at}, ${credit_expiry_date.toISOString()}), ${credit_expiry_date.toISOString()})`,
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
      tx: dbOrTx,
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
