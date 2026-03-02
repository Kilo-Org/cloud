import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { credit_transactions } from '@kilocode/db/schema';
import { eq, desc, and, isNull } from 'drizzle-orm';

export async function GET(
  request: NextRequest
): Promise<
  NextResponse<
    { error: string } | { credit_transactions: (typeof credit_transactions.$inferSelect)[] }
  >
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const kilo_user_id = searchParams.get('kilo_user_id');

  if (!kilo_user_id) throw new Error('kilo_user_id is required');

  const transactions = await db.query.credit_transactions.findMany({
    where: and(
      eq(credit_transactions.kilo_user_id, kilo_user_id),
      isNull(credit_transactions.organization_id)
    ),
    orderBy: desc(credit_transactions.created_at),
  });

  return NextResponse.json({ credit_transactions: transactions });
}
