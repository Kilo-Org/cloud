import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { getUserFromAuth } from '@/lib/user/server';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development mode' },
      { status: 403 }
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  try {
    const body = await request.json();
    const { dollarAmount } = body;

    if (typeof dollarAmount !== 'number' || dollarAmount <= 0) {
      return NextResponse.json({ error: 'Invalid dollar amount' }, { status: 400 });
    }

    const kiloUserId = user.id;
    const amountMicrodollars = Math.ceil(dollarAmount * 1_000_000);

    const newTransactionId = crypto.randomUUID();

    await db.insert(credit_transactions).values({
      id: newTransactionId,
      kilo_user_id: kiloUserId,
      is_free: true,
      amount_microdollars: amountMicrodollars,
      description: 'Dev tool: added credits',
      credit_category: 'dev-tools',
      original_baseline_microdollars_used: user.microdollars_used,
      created_by_kilo_user_id: kiloUserId,
    });

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${amountMicrodollars}`,
      })
      .where(eq(kilocode_users.id, kiloUserId));

    await forceImmediateExpirationRecomputation(kiloUserId);

    console.log(
      `Added ${dollarAmount} dollars (${amountMicrodollars} microdollars) for user ${kiloUserId}, transaction ${newTransactionId}`
    );

    return NextResponse.json({ success: true, credit_transaction_id: newTransactionId });
  } catch (error) {
    console.error('Error adding credits:', error);
    captureException(error, {
      tags: { source: 'dev_add_credits_api' },
      extra: { userId: user.id },
      level: 'error',
    });
    return NextResponse.json({ error: 'Failed to add credits' }, { status: 500 });
  }
}
