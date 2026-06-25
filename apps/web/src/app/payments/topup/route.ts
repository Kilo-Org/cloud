import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { getStripeTopUpCheckoutUrl } from '@/lib/stripe';
import { MAXIMUM_TOP_UP_AMOUNT, MINIMUM_TOP_UP_AMOUNT } from '@/lib/constants';
import { isValidReturnUrl } from '@/lib/payment-return-url';
import { captureException } from '@sentry/nextjs';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { getOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils';
import { TOPUP_CANCELED_QUERY_STRING_KEY } from '@/lib/organizations/constants';

/**
 * NOTE: Crypto payment support (Coinbase Commerce) was removed in January 2026.
 * This route now only supports Stripe payments.
 */
type AmountValidationResult =
  | { success: true; amount: number | undefined }
  | { success: false; error: string };

function validateAmount(amountParam: string | null): AmountValidationResult {
  if (!amountParam) {
    return { success: true, amount: undefined }; // No amount provided, allow default price
  }

  const amountInDollars = parseInt(amountParam);
  if (isNaN(amountInDollars) || amountInDollars <= 0) {
    return { success: false, error: 'Invalid amount. Must be a positive number.' };
  }

  if (amountInDollars < MINIMUM_TOP_UP_AMOUNT || amountInDollars > MAXIMUM_TOP_UP_AMOUNT) {
    return {
      success: false,
      error: `Amount must be between $${MINIMUM_TOP_UP_AMOUNT} and $${MAXIMUM_TOP_UP_AMOUNT}`,
    };
  }

  return { success: true, amount: amountInDollars };
}

export async function POST(request: NextRequest): Promise<NextResponse<unknown>> {
  const { user: currentUser } = await getUserFromAuth({ adminOnly: false });
  const kiloUserId = currentUser?.id;
  if (!kiloUserId) return NextResponse.redirect(new URL('/users/sign_in', request.url));

  const { searchParams } = new URL(request.url);
  const origin = searchParams.get('origin') === 'extension' ? 'extension' : 'web';

  // Reject crypto payments (discontinued January 2026)
  if (searchParams.get('crypto') === 'true') {
    return NextResponse.json(
      { error: 'Cryptocurrency payments are no longer supported. Please use a credit card.' },
      { status: 410 }
    );
  }

  const amountParam = searchParams.get('amount');
  const validationResult = validateAmount(amountParam);
  if (!validationResult.success) {
    return NextResponse.json({ error: validationResult.error }, { status: 400 });
  }

  // Accept a route identifier at the URL boundary, then immediately normalize to
  // the database UUID before calling billing or writing Stripe metadata.
  const organizationRouteIdentifier = searchParams.get('organization-id');
  if (organizationRouteIdentifier && typeof organizationRouteIdentifier !== 'string') {
    return NextResponse.json({ error: 'Invalid org id' }, { status: 400 });
  }

  let stripeCustomerId: string | null | undefined;
  let organizationId: string | null = null;
  let organizationCancelPath: string | null = null;
  if (organizationRouteIdentifier) {
    const orgContext = await getAuthorizedOrgContext(organizationRouteIdentifier, [
      'owner',
      'billing_manager',
    ]);
    if (!orgContext.success) {
      return orgContext.nextResponse;
    }
    organizationId = orgContext.data.organization.id;
    const canonicalRouteIdentifier = getOrganizationRouteIdentifier(orgContext.data.organization);
    organizationCancelPath = `/organizations/${canonicalRouteIdentifier}?${TOPUP_CANCELED_QUERY_STRING_KEY}=true`;
    stripeCustomerId = await getOrCreateStripeCustomerIdForOrganization(organizationId);
  } else {
    stripeCustomerId = currentUser.stripe_customer_id;
  }

  const cancelPathRaw = searchParams.get('cancel-path');
  const cancelPath =
    (cancelPathRaw && isValidReturnUrl(cancelPathRaw) ? cancelPathRaw : null) ??
    organizationCancelPath;

  const url = await getStripeTopUpCheckoutUrl(
    currentUser.id,
    stripeCustomerId,
    validationResult.amount as number,
    origin,
    organizationId,
    cancelPath
  );

  if (!url) {
    captureException(new Error('Failed to create checkout session'), {
      extra: {
        userId: currentUser.id,
        organizationId,
        amount: validationResult.amount,
      },
    });
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }

  return NextResponse.redirect(url, { status: 303 });
}
