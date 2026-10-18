import { sql } from 'drizzle-orm';
import { credit_transactions } from '@kilocode/db/schema';

export const isPaidCreditReportingSql = sql`(
  (not ${credit_transactions.is_free} or ${credit_transactions.paid_credit_policy} in ('legacy', 'one_year', 'apple_exempt'))
  and (
    ${credit_transactions.refund_principal_microdollars} is not null
    or (
      ${credit_transactions.source_transaction_id} is null
      and ${credit_transactions.credit_category} is distinct from 'credits_expired'
      and ${credit_transactions.paid_credit_policy} is distinct from 'settlement'
      and (not ${credit_transactions.is_free} or ${credit_transactions.amount_microdollars} > 0)
    )
  )
)`;

export const paidCreditPrincipalSql = sql`coalesce(
  ${credit_transactions.refund_principal_microdollars},
  ${credit_transactions.amount_microdollars}
)`;
