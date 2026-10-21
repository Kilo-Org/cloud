'use server';
import 'server-only';

import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { credit_transactions } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { client } from '@kilocode/web-shared/lib/stripe-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureMessage } from '@sentry/nextjs';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { getAndClearPaymentReturnUrl } from '@/lib/payment-return-url';

const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,255}$/;

/** The redirect-relevant fields of the ledger row, and nothing else. */
export type TopUpTransactionSummary = {
  id: string;
  organizationId: string | null;
  amountMicrodollars: number;
};

/**
 * `pending` means the checkout belongs to the caller but the ledger row is not
 * visible yet, which happens while the payment webhook is still settling.
 * `unavailable` covers every case where the caller may not resolve this checkout:
 * a malformed or unknown session id, no web session, or a session that belongs to
 * another account.
 */
export type TopUpTransactionLookup =
  | { status: 'found'; transaction: TopUpTransactionSummary }
  | { status: 'pending' }
  | { status: 'unavailable' };

function paymentIdsForSession(session: Stripe.Checkout.Session): string[] {
  const paymentIntent =
    typeof session.payment_intent === 'string' || !session.payment_intent
      ? null
      : session.payment_intent;
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (paymentIntent?.id ?? null);

  // Historical rows key on the charge id rather than the payment intent id.
  const latestCharge = paymentIntent?.latest_charge ?? null;
  const latestChargeId =
    typeof latestCharge === 'string' ? latestCharge : (latestCharge?.id ?? null);

  return [paymentIntentId, latestChargeId].filter((id): id is string => Boolean(id));
}

export async function fetchTopUpTransactionForStripeSession(
  sessionId: string
): Promise<TopUpTransactionLookup> {
  if (typeof sessionId !== 'string' || !STRIPE_CHECKOUT_SESSION_ID_PATTERN.test(sessionId)) {
    return { status: 'unavailable' };
  }

  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    return { status: 'unavailable' };
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await client.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
  } catch (error) {
    logExceptInTest('Top-up checkout session could not be retrieved');
    captureMessage('Stripe checkout session lookup failed', {
      level: 'warning',
      tags: { source: 'payments/topup/success/actions' },
      extra: { errorName: error instanceof Error ? error.name : 'UnknownError' },
    });
    return { status: 'unavailable' };
  }

  if (session.payment_status !== 'paid') {
    captureMessage('Stripe session not found or not paid', {
      level: 'warning',
      tags: { source: 'payments/topup/success/actions' },
      extra: { paymentStatus: session.payment_status },
    });
  }

  // The checkout creator records the paying account in the session metadata:
  // `organizationId` for organization top-ups, otherwise `kiloUserId`.
  const sessionOrganizationId = session.metadata?.organizationId || null;
  const sessionKiloUserId = session.metadata?.kiloUserId || null;

  let ownerFilter;
  if (sessionOrganizationId) {
    const organizationContext = await getAuthorizedOrgContext(
      sessionOrganizationId,
      ORGANIZATION_BILLING_ROLES
    );
    if (!organizationContext.success) {
      return { status: 'unavailable' };
    }
    ownerFilter = eq(credit_transactions.organization_id, sessionOrganizationId);
  } else if (sessionKiloUserId === user.id) {
    ownerFilter = and(
      eq(credit_transactions.kilo_user_id, user.id),
      isNull(credit_transactions.organization_id)
    );
  } else {
    return { status: 'unavailable' };
  }

  const paymentIds = paymentIdsForSession(session);
  if (paymentIds.length === 0) {
    return { status: 'pending' };
  }

  const transaction = await db.query.credit_transactions.findFirst({
    columns: { id: true, organization_id: true, amount_microdollars: true },
    where: and(inArray(credit_transactions.stripe_payment_id, paymentIds), ownerFilter),
  });

  if (!transaction) {
    logExceptInTest('Top-up checkout is settled but its ledger row is not visible yet');
    return { status: 'pending' };
  }

  return {
    status: 'found',
    transaction: {
      id: transaction.id,
      organizationId: transaction.organization_id,
      amountMicrodollars: transaction.amount_microdollars,
    },
  };
}

export async function getPaymentReturnUrl(): Promise<string | null> {
  return await getAndClearPaymentReturnUrl();
}
