import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import type { AddCreditRequest } from '@/types/admin';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';

export async function POST(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { message: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;
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
  const credit_expiry_date = requestData.credit_expiry_date ?? requestData.creditExpiryDate;
  const options = {
    amount_usd: requestData.amount_usd ?? requestData.creditAmount ?? undefined,
    description: requestData.description ?? requestData.creditDescription ?? undefined,
    credit_expiry_date: credit_expiry_date ? new Date(credit_expiry_date) : undefined,
    expiry_hours: requestData.expiry_hours ?? requestData.creditExpiryHours ?? undefined,
    credit_category: credit_category,
    counts_as_selfservice: false,
  };
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
