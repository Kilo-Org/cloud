import { eq, desc, and, isNull, gt, notExists } from 'drizzle-orm';
import { db, readDb, sql } from './drizzle';
import type { Organization } from '@kilocode/db/schema';
import { credit_transactions, kilo_pass_issuance_items, kilocode_users } from '@kilocode/db/schema';

type CreditSummary = {
  total_promotional_musd: number;
  total_purchased_musd: number;
  credit_transaction_count: number;
};

export async function getCreditTransactionsSummaryByUserId(
  kiloUserId: string
): Promise<CreditSummary> {
  const { rows } = await db.execute(
    sql`
    select
      coalesce(sum(amount_microdollars) filter (where is_free),0) :: bigint  total_promotional_musd,
      coalesce(sum(amount_microdollars) filter (where not is_free),0) :: bigint  total_purchased_musd,
      count(*) as credit_transaction_count
    from public.credit_transactions
    where kilo_user_id = ${kiloUserId}
  `
  );
  const result = rows[0] as {
    total_promotional_musd: bigint;
    total_purchased_musd: bigint;
    credit_transaction_count: bigint;
  };

  return {
    total_promotional_musd: Number(result.total_promotional_musd),
    total_purchased_musd: Number(result.total_purchased_musd),
    credit_transaction_count: Number(result.credit_transaction_count),
  };
}

export type CreditInfo = {
  balance: number;
  isDepleted: boolean;
  hasPendingPayments: boolean;
};

export type UserPaymentsSummary = Awaited<ReturnType<typeof summarizeUserPayments>>;
export async function summarizeUserPayments(kiloUserId: string, fromDb: typeof db = readDb) {
  return (
    await fromDb
      .select({
        payments_count: sql<number>`count(*)::int`,
        payments_total_microdollars: sql<number>`coalesce(sum(${credit_transactions.amount_microdollars}), 0)::float`,
      })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, kiloUserId),
          eq(credit_transactions.is_free, false),
          gt(credit_transactions.amount_microdollars, 0),
          notExists(
            fromDb
              .select({ id: kilo_pass_issuance_items.id })
              .from(kilo_pass_issuance_items)
              .where(eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id))
          )
        )
      )
  )[0];
}

export async function getCreditTransactionsForOrganization(organizationId: Organization['id']) {
  return db
    .select({
      id: credit_transactions.id,
      kilo_user_id: credit_transactions.kilo_user_id,
      amount_microdollars: credit_transactions.amount_microdollars,
      expiration_baseline_microdollars_used:
        credit_transactions.expiration_baseline_microdollars_used,
      original_baseline_microdollars_used: credit_transactions.original_baseline_microdollars_used,
      is_free: credit_transactions.is_free,
      description: credit_transactions.description,
      original_transaction_id: credit_transactions.original_transaction_id,
      stripe_payment_id: credit_transactions.stripe_payment_id,
      coinbase_credit_block_id: credit_transactions.coinbase_credit_block_id,
      credit_category: credit_transactions.credit_category,
      expiry_date: credit_transactions.expiry_date,
      created_at: credit_transactions.created_at,
      organization_id: credit_transactions.organization_id,
      check_category_uniqueness: credit_transactions.check_category_uniqueness,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.organization_id, organizationId))
    .orderBy(desc(credit_transactions.created_at))
    .limit(100);
}

export async function getAdminCreditTransactionsForOrganization(
  organizationId: Organization['id']
) {
  const transactions = await db
    .select({
      id: credit_transactions.id,
      amount_microdollars: credit_transactions.amount_microdollars,
      expiration_baseline_microdollars_used:
        credit_transactions.expiration_baseline_microdollars_used,
      is_free: credit_transactions.is_free,
      description: credit_transactions.description,
      stripe_payment_id: credit_transactions.stripe_payment_id,
      credit_category: credit_transactions.credit_category,
      expiry_date: credit_transactions.expiry_date,
      created_at: credit_transactions.created_at,
      created_by_kilo_user_id: credit_transactions.created_by_kilo_user_id,
      created_by_user_name: kilocode_users.google_user_name,
      created_by_user_email: kilocode_users.google_user_email,
    })
    .from(credit_transactions)
    .leftJoin(kilocode_users, eq(credit_transactions.created_by_kilo_user_id, kilocode_users.id))
    .where(eq(credit_transactions.organization_id, organizationId))
    .orderBy(desc(credit_transactions.created_at))
    .limit(100);

  return transactions.map(transaction => ({
    ...transaction,
    created_at: new Date(transaction.created_at).toISOString(),
    expiry_date: transaction.expiry_date ? new Date(transaction.expiry_date).toISOString() : null,
  }));
}

export async function hasUserEverPaid(kiloUserId: string): Promise<boolean> {
  const result = await db.query.credit_transactions.findFirst({
    where: and(
      eq(credit_transactions.kilo_user_id, kiloUserId),
      eq(credit_transactions.is_free, false),
      isNull(credit_transactions.organization_id)
    ),
    columns: { id: true },
  });
  return result !== undefined;
}

export async function hasOrganizationEverPaid(
  organizationId: Organization['id']
): Promise<boolean> {
  const result = await db.query.credit_transactions.findFirst({
    where: and(
      eq(credit_transactions.organization_id, organizationId),
      eq(credit_transactions.is_free, false)
    ),
    columns: { id: true },
  });
  return result !== undefined;
}
