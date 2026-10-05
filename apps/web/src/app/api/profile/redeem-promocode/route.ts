import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { redeemSelfServicePromoCode } from '@kilocode/web-shared/lib/promotionalCredits';
import { promoCreditCategoriesByKey } from '@kilocode/web-shared/lib/promoCreditCategories';

export type RedemptionResult = {
  message: string;
  creditAmount: number;
  expiryDate?: string;
};

export async function POST(
  request: NextRequest
): Promise<NextResponse<{ error: string } | RedemptionResult>> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) return authFailedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const { credit_category } = body as { credit_category?: unknown };

  if (!credit_category || typeof credit_category !== 'string') {
    return NextResponse.json({ error: 'Promotional code is required' }, { status: 400 });
  }

  const result = await redeemSelfServicePromoCode(user, credit_category);

  if (result.success) {
    const promotion = promoCreditCategoriesByKey.get(credit_category);
    const creditAmount = promotion?.amount_usd || 0;
    const expiryDate = promotion?.credit_expiry_date?.toISOString();

    return NextResponse.json({
      message: result.message,
      creditAmount: creditAmount,
      expiryDate: expiryDate,
    });
  } else {
    console.log('Self-service promo redemption failed', {
      credit_category,
      kilo_user_id: user.id,
      error: result.message,
    });
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
}
