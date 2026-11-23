import { z } from 'zod';
import type { CreditTransactionForBlocks } from '@kilocode/web-shared/lib/creditExpiration';
import { promoCreditCategoriesByKey } from '@kilocode/web-shared/lib/promoCreditCategories';
import { CREDIT_CAMPAIGN_CATEGORY_PREFIX } from '@/lib/credit-campaigns-shared';
import { getCodingPlanPrice } from '@/lib/coding-plans/pricing';
import { computeExpiration, computeCreditLotAllocations } from '@kilocode/db/credit-expiration';
import { toNonNullish } from '@/lib/utils';

type EntityForCreditBlocks = {
  id: string;
  microdollars_used: number;
  total_microdollars_acquired: number;
};

/**
 * The coding plan a negative row charged, as the plan catalog names it, or null
 * when the category names no plan the catalog knows.
 *
 * A charge category names its plan directly (`coding-plan:<planId>:<key>`). A
 * renewal category names the subscription it renewed instead
 * (`coding-plan:renewal:<subscriptionId>:<creditRenewalAt>`), so the caller
 * resolves that subscription to its plan and passes the names in; without an
 * entry the row keeps its stored description rather than guess a plan.
 */
function codingPlanNameOf(
  creditCategory: string | null,
  codingPlanNamesBySubscription: ReadonlyMap<string, string>
): string | null {
  if (creditCategory === null) {
    return null;
  }
  const codingPlanSegment = creditCategory.match(/^coding-plan:([^:]+):/)?.[1];
  if (codingPlanSegment == null) {
    return null;
  }
  const plan = getCodingPlanPrice(codingPlanSegment);
  if (plan) {
    return `${plan.providerName} ${plan.name}`;
  }
  // A renewal category names the subscription, and the subscription names the
  // plan it bought. An extension row puts the literal `extension` first and its
  // minutes are a zero-amount adjustment, so the lookup misses and it keeps its
  // stored description.
  const subscriptionId =
    creditCategory.match(/^coding-plan:renewal:([^:]+):/)?.[1] ?? codingPlanSegment;
  return codingPlanNamesBySubscription.get(subscriptionId) ?? null;
}

/**
 * Why a negative row drew credit and, for a coding-plan charge, the plan it
 * charged, read from the row's own category so a client titles the row in the
 * reader's language instead of printing the stored English description. Null
 * where the category carries no reason the app can name: expiry and void rows
 * point at a grant that the row already shows, internal and legacy
 * reconciliation rows never funded the balance, and an unknown writer must keep
 * its stored description rather than borrow another writer's wording.
 */
function deductionOf(
  creditCategory: string | null,
  codingPlanNamesBySubscription: ReadonlyMap<string, string>
): { reason: CreditDeductionReason | null; planName: string | null } {
  const planName = codingPlanNameOf(creditCategory, codingPlanNamesBySubscription);
  if (planName != null) {
    return { reason: 'coding_plan', planName };
  }
  // A negative row that records no category is the balance's own usage charge:
  // the metering writer is the only one that leaves it empty, while every other
  // writer records the category that identifies it.
  if (creditCategory === null) {
    return { reason: 'usage', planName: null };
  }
  if (creditCategory === 'stripe-dispute-enforcement') {
    return { reason: 'dispute', planName: null };
  }
  if (creditCategory === 'manual_decrement') {
    return { reason: 'admin_debit', planName: null };
  }
  if (creditCategory === 'accounting_adjustment') {
    return { reason: 'correction', planName: null };
  }
  if (creditCategory.startsWith('admin-cancel-')) {
    return { reason: 'admin_cancel', planName: null };
  }
  // A store refund names the store that refunded, so the client can say which
  // one; a provider it does not know is not guessed at.
  const refundProvider = creditCategory.match(/^store-credit-refund:([^:]+):/)?.[1];
  if (refundProvider === 'app_store') {
    return { reason: 'refund_app_store', planName: null };
  }
  if (refundProvider === 'google_play') {
    return { reason: 'refund_google_play', planName: null };
  }
  // Expiries, voids, internal reconciliation rows, legacy migration rows, and
  // categories no writer has classified all land here.
  return { reason: null, planName: null };
}

/**
 * `codingPlanNamesBySubscription` maps a coding-plan subscription id to the
 * plan the catalog knows it bought, formatted as "<Provider> <Plan>". It is what
 * lets a renewal row name its plan: the row's category carries only the
 * subscription id.
 */
export function getCreditBlocks(
  transactions: CreditTransactionForBlocks[],
  now: Date,
  entity: EntityForCreditBlocks,
  kilo_user_id: string,
  codingPlanNamesBySubscription: ReadonlyMap<string, string> = new Map()
) {
  const paidTransactionsCount = transactions.filter(
    t =>
      t.amount_microdollars > 0 &&
      (!t.is_free || t.paid_credit_policy != null) &&
      t.paid_credit_policy !== 'settlement' &&
      t.source_transaction_id == null
  ).length;
  const isFirstPurchase = paidTransactionsCount === 0;

  // Build lookup sets for processed transactions
  const processedById = new Set<string>();

  for (const t of transactions) {
    if (
      t.credit_category === 'credits_expired' ||
      t.credit_category === 'orb_credit_expired' ||
      t.credit_category === 'orb_credit_voided'
    ) {
      if (t.original_transaction_id) processedById.add(t.original_transaction_id);
    }
  }

  // Filter to unprocessed transactions with expiry dates
  const all_expiring_transactions = transactions.filter(
    t => t.amount_microdollars > 0 && t.expiry_date != null && !processedById.has(t.id)
  );

  const max_expiration_date = all_expiring_transactions.reduce(
    (max, t) => (t.expiry_date && new Date(t.expiry_date) > max ? new Date(t.expiry_date) : max),
    now
  );

  const expirationResult = computeExpiration(
    all_expiring_transactions,
    entity,
    max_expiration_date,
    kilo_user_id
  );
  const expiringById = new Map(all_expiring_transactions.map(t => [t.id, t]));

  const expiredWithBalance = expirationResult.newTransactions
    .map(t => {
      const block = toNonNullish(expiringById.get(t.original_transaction_id || ''));
      const balance_mUsd = -t.amount_microdollars;
      return {
        id: block.id,
        effective_date: block.created_at,
        expiry_date: block.expiry_date,
        balance_mUsd,
        amount_mUsd: block.amount_microdollars,
        is_free: block.is_free,
      };
    })
    .filter(t => t.balance_mUsd > 0);
  const totalBalance_mUsd = entity.total_microdollars_acquired - entity.microdollars_used;
  const expiringBalance_mUsd = expiredWithBalance.reduce((sum, t) => sum + t.balance_mUsd, 0);
  const nonExpiringBalance_mUsd = totalBalance_mUsd - expiringBalance_mUsd;
  let remainingNonExpiringBalance = Math.max(0, nonExpiringBalance_mUsd);
  const nonExpiring = computeCreditLotAllocations(
    transactions.filter(transaction => !processedById.has(transaction.id)),
    entity
  )
    .filter(({ transaction }) => transaction.expiry_date === null)
    .map(({ transaction, remaining_microdollars }) => {
      const balance_mUsd = Math.min(remaining_microdollars, remainingNonExpiringBalance);
      remainingNonExpiringBalance -= balance_mUsd;
      return {
        id: transaction.id,
        effective_date: transaction.created_at,
        expiry_date: transaction.expiry_date,
        amount_mUsd: transaction.amount_microdollars,
        balance_mUsd,
        is_free: transaction.is_free,
      };
    })
    .filter(transaction => transaction.balance_mUsd > 0);

  const creditBlocks = [...expiredWithBalance, ...nonExpiring];

  // Extract deduction transactions (negative amounts) for display.
  // These include KiloClaw subscription charges and settlement deductions.
  // An expiry row points at the grant it closed through
  // `original_transaction_id`, so the row can show the purchase it ended.
  const transactionById = new Map(transactions.map(transaction => [transaction.id, transaction]));
  const deductions = transactions
    .filter(tx => tx.amount_microdollars < 0)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(tx => {
      const source = tx.original_transaction_id
        ? transactionById.get(tx.original_transaction_id)
        : undefined;
      // The row's own category decides: only a closed grant expires or is
      // voided, and every other deduction is neither.
      const expiry: 'expired' | 'voided' | null =
        tx.credit_category === 'credits_expired' || tx.credit_category === 'orb_credit_expired'
          ? 'expired'
          : tx.credit_category === 'orb_credit_voided'
            ? 'voided'
            : null;
      // Not every expiring source is a purchase: promotional, referral, Pass,
      // and admin credits are grants the user did not pay for directly. The
      // pair needs the grant's own free flag and recorded source to label it,
      // and its reason so the client can title the grant in its own language.
      // The row's own category also says why it drew credit, and which coding
      // plan it charged, so a client titles the row from its catalog.
      const { reason, planName } = deductionOf(tx.credit_category, codingPlanNamesBySubscription);
      return {
        id: tx.id,
        date: tx.created_at,
        description: tx.description ?? tx.credit_category ?? 'Credit deduction',
        credit_category: tx.credit_category,
        amount_mUsd: tx.amount_microdollars, // negative
        expiry,
        reason,
        planName,
        purchase:
          source && source.amount_microdollars > 0
            ? {
                id: source.id,
                date: source.created_at,
                description: source.description ?? source.credit_category ?? 'Credit grant',
                amount_mUsd: source.amount_microdollars,
                is_free: source.is_free,
                credit_source: source.credit_source ?? null,
                kind: creditGrantReasonOf(source.credit_category ?? null),
              }
            : null,
      };
    });

  return {
    creditBlocks,
    deductions,
    totalBalance_mUsd,
    isFirstPurchase,
  };
}

export const CreditGrantReasonSchema = z.enum([
  'referral',
  'welcome',
  'kilo_pass',
  'promotional',
  'influencer',
  'usage_issue',
  'pull_request',
  'vibe_day',
  'feedback',
  'admin_bulk_grant',
  'oss_sponsorship',
  'oss_monthly_reset',
  'contributor_champion',
  'adjustment',
]);
export type CreditGrantReason = z.infer<typeof CreditGrantReasonSchema>;

/**
 * Why a negative row drew credit. The client carries the wording for each
 * reason in its own catalog, so the row title reads in the reader's language
 * rather than echoing the stored English description. Null for a row whose
 * category carries no reason the app can name.
 */
export const CreditDeductionReasonSchema = z.enum([
  'usage',
  'coding_plan',
  'refund_app_store',
  'refund_google_play',
  'dispute',
  'admin_cancel',
  'admin_debit',
  'correction',
]);
export type CreditDeductionReason = z.infer<typeof CreditDeductionReasonSchema>;

/**
 * Ledger-cache reconciliation, the Orb migration, expirations and admin
 * corrections write their adjustments as credit rows that never funded the
 * balance, so they are never shown as credit the member received.
 */
const INTERNAL_CREDIT_CATEGORIES: Readonly<Record<string, true>> = {
  accounting_adjustment: true,
  orb_migration_accounting_adjustment: true,
  manual_decrement: true,
  orb_manual_decrement: true,
  orb_credit_expired: true,
  orb_credit_voided: true,
  credits_expired: true,
  'admin-cancel-refund-kilo-pass': true,
  'admin-cancel-kilo-pass-no-refund': true,
  organization_custom: true,
};

/**
 * Standing programs write their own category, and each names how the member
 * earned the grant, so it never reads as a plain promotion.
 */
const STANDING_PROGRAM_CREDIT_REASONS: Readonly<Record<string, CreditGrantReason>> = {
  influencer: 'influencer',
  usage_issue: 'usage_issue',
  pull_request: 'pull_request',
  vibeday: 'vibe_day',
  feedback: 'feedback',
  'admin-bulk-grant': 'admin_bulk_grant',
  'oss-sponsorship': 'oss_sponsorship',
  'oss-monthly-reset': 'oss_monthly_reset',
  'contributor-champion-credits': 'contributor_champion',
};

/** The welcome grants, including the validation grants they replaced. */
const WELCOME_CREDIT_CATEGORIES: Readonly<Record<string, true>> = {
  'automatic-welcome-credits': true,
  welcome20: true,
  welcome15: true,
  'stytch-validation': true,
  'card-validation-no-stytch': true,
  'card-validation-upgrade': true,
};

/**
 * Classifies the category of a positive free credit row for display.
 *
 * Fails closed: a category nobody has classified prints as an adjustment
 * rather than as credit the member received, so a new reconciliation or
 * migration writer cannot inflate the apparent free credit. A standing
 * program names how the grant was earned; a category the promo registry
 * defines, or an admin-created campaign, prints as a promotion.
 */
export function creditGrantReasonOf(creditCategory: string | null): CreditGrantReason {
  // `referral` is the admin Referral/Review grant; the two self-service bonuses
  // carry the `referral-` prefix.
  if (creditCategory === 'referral' || creditCategory?.startsWith('referral-')) {
    return 'referral';
  }
  if (creditCategory != null && Object.hasOwn(WELCOME_CREDIT_CATEGORIES, creditCategory)) {
    return 'welcome';
  }
  if (creditCategory === 'kilo-pass-bonus') {
    return 'kilo_pass';
  }
  if (creditCategory != null && Object.hasOwn(STANDING_PROGRAM_CREDIT_REASONS, creditCategory)) {
    return STANDING_PROGRAM_CREDIT_REASONS[creditCategory];
  }
  if (creditCategory != null && !Object.hasOwn(INTERNAL_CREDIT_CATEGORIES, creditCategory)) {
    // An admin-managed campaign writes its own category, which is built from
    // its slug at grant time and so is never in the registry.
    if (creditCategory.startsWith(CREDIT_CAMPAIGN_CATEGORY_PREFIX)) {
      return 'promotional';
    }
    // Self-service promo codes are stored encrypted and decrypted at runtime,
    // so the registry is the only place that knows them. `obsolete` still marks
    // member-visible grants that predate the current catalogue, so it does not
    // disqualify one; only a category written as a debit does.
    const promo = promoCreditCategoriesByKey.get(creditCategory);
    if (promo != null && !promo.expect_negative_amount) {
      return 'promotional';
    }
  }
  return 'adjustment';
}
