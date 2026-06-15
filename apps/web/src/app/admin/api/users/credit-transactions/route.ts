import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq, desc, and, isNull } from 'drizzle-orm';
import type { AdminCreditTransaction } from '@/types/admin';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { credit_transactions: AdminCreditTransaction[] }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const kilo_user_id = searchParams.get('kilo_user_id');

  if (!kilo_user_id) throw new Error('kilo_user_id is required');

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
    .where(
      and(
        eq(credit_transactions.kilo_user_id, kilo_user_id),
        isNull(credit_transactions.organization_id)
      )
    )
    .orderBy(desc(credit_transactions.created_at));

  return NextResponse.json({
    credit_transactions: transactions.map(transaction => ({
      ...transaction,
      created_at: new Date(transaction.created_at).toISOString(),
      expiry_date: transaction.expiry_date ? new Date(transaction.expiry_date).toISOString() : null,
    })),
  });
}
