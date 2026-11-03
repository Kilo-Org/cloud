import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  GRANT_MSG_ALREADY_APPLIED,
  grantCreditForCategory,
} from '@kilocode/web-shared/lib/promotionalCredits';
import { promoCreditCategoriesByKey } from '@kilocode/web-shared/lib/promoCreditCategories';
import type { AddCreditRequest } from '@/types/admin';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, isNull } from 'drizzle-orm';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { userCanManageCredits } from '@/lib/admin/credit-management';
import { lockCreditOwners, retireCreditBalance } from '@kilocode/web-shared/lib/creditAdjustments';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';

export async function POST(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { message: string }>> {
  const { user: operator, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;
  if (!operator || !userCanManageCredits(operator)) {
    return NextResponse.json({ error: 'Credit management access required' }, { status: 403 });
  }

  const requestData = (await request.json()) as AddCreditRequest;
  const force200 = request.nextUrl.searchParams.get('force_200_response') === 'true';
  function warnAndCreateErrorResponse(message: string) {
    console.warn(message);
    return NextResponse.json({ error: message }, { status: force200 ? 200 : 400 });
  }
  const { email } = requestData;

  if (typeof email !== 'string') {
    return warnAndCreateErrorResponse('Invalid email parameter');
  }

  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.google_user_email, email),
  });

  if (!user) return warnAndCreateErrorResponse(`User with email ${email} not found in database`);
  if (user.blocked_reason) return warnAndCreateErrorResponse(`User with email ${email} is blocked`);
  const credit_category = requestData.credit_category ?? requestData.idempotencyKey;
  if (!credit_category) {
    return warnAndCreateErrorResponse('Credit category is required');
  }
  const creditKind = requestData.creditKind ?? 'promotional';
  if (creditKind !== 'paid' && creditKind !== 'promotional') {
    return warnAndCreateErrorResponse('Invalid credit kind');
  }
  const credit_expiry_date = requestData.credit_expiry_date ?? requestData.creditExpiryDate;
  const options = {
    amount_usd: requestData.amount_usd ?? requestData.creditAmount ?? undefined,
    creditKind,
    description: requestData.description ?? requestData.creditDescription ?? undefined,
    credit_expiry_date:
      creditKind === 'promotional' && credit_expiry_date ? new Date(credit_expiry_date) : undefined,
    expiry_hours:
      creditKind === 'promotional'
        ? (requestData.expiry_hours ?? requestData.creditExpiryHours ?? undefined)
        : undefined,
    credit_category: credit_category,
    counts_as_selfservice: false,
    created_by_kilo_user_id: operator.id,
  };
  if (options.amount_usd !== undefined && options.amount_usd < 0) {
    const category = promoCreditCategoriesByKey.get(credit_category);
    if (!category) return warnAndCreateErrorResponse(`Category ${credit_category} not found`);
    // Only operator-facing debit categories; system ledger categories such as credits_expired are written by their own flows.
    if (!category.expect_negative_amount || !category.adminUI_label) {
      return warnAndCreateErrorResponse(`Category ${credit_category} does not allow admin debits`);
    }
    const owner = { type: 'user' as const, id: user.id };
    const applied = await db.transaction(async tx => {
      // The owner lock serializes replays, so the idempotency check below cannot race a concurrent debit.
      await lockCreditOwners(tx, [owner]);
      if (category.is_idempotent) {
        const [existing] = await tx
          .select({ id: credit_transactions.id })
          .from(credit_transactions)
          .where(
            and(
              eq(credit_transactions.kilo_user_id, user.id),
              isNull(credit_transactions.organization_id),
              eq(credit_transactions.credit_category, credit_category)
            )
          )
          .limit(1);
        if (existing) return false;
      }
      await retireCreditBalance(tx, {
        owner,
        actorId: operator.id,
        creditCategory: credit_category,
        description: options.description ?? 'Admin credit debit',
        amountMicrodollars: -toMicrodollars(options.amount_usd ?? 0),
      });
      return true;
    });
    if (!applied) {
      return warnAndCreateErrorResponse(
        `Code ${credit_category} ${GRANT_MSG_ALREADY_APPLIED} to ${email}.`
      );
    }
    return NextResponse.json({
      message: 'Credit debit applied',
      creditsAmount: options.amount_usd,
    });
  }
  const result = await grantCreditForCategory(user, options);

  console.log(
    [
      result.success ? '[SUCCESS]' : '[FAILURE]',
      `Processing single email: ${email}`,
      `Credit amount: $${options.amount_usd}`,
      `Credit description: "${options.description}"`,
      `Credit expiry date: ${options.credit_expiry_date?.toISOString() ?? '<no expiry>'}`,
      `Expiry hours: ${options.expiry_hours ?? '<no expiry hours>'}`,
      `Credit Category: ${options.credit_category ?? '<no credit category>'}`,
      `Message: ${result.message}`,
    ].join(' | ')
  );

  if (!result.success) return warnAndCreateErrorResponse(result.message);

  return NextResponse.json({
    message: result.message,
    creditsAmount: result.amount_usd,
  });
}
