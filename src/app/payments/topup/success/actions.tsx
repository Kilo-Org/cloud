'use server';
import 'server-only';

import { credit_transactions } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { client } from '@/lib/stripe-client';
import { captureMessage } from '@sentry/nextjs';
import { inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getAndClearPaymentReturnUrl } from '@/lib/payment-return-url';

export async function fetchCreditTransactionIdForStripeSession(sessionId: string) {
  console.info(
    `Fetching credit transaction ID for Stripe session: ${sessionId}`,
    new Date().toISOString()
  );
  if (!sessionId || typeof sessionId !== 'string') {
    console.info(`Invalid sessionId: ${sessionId}`);
    return undefined;
  }

  const session = await client.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
  const paymentIntent = session.payment_intent as Stripe.PaymentIntent;

  if (!session || session.payment_status !== 'paid') {
    captureMessage('Stripe session not found or not paid', {
      level: 'warning',
      tags: { source: 'payments/topup/success/actions' },
      extra: { sessionId, session },
    });
  }

  // Note: This is a bit ugly, because for some reason we sometimes store py_ ids (charges), and sometimes pi_ ids (payment intents)
  const creditTransaction = await db.query.credit_transactions.findFirst({
    where: inArray(credit_transactions.stripe_payment_id, [
      paymentIntent.id,
      paymentIntent.latest_charge as string,
    ]),
  });

  if (creditTransaction) {
    console.info(`Found credit transaction for session ${sessionId}:`, creditTransaction.id);
  } else {
    console.info(`No credit transaction found for session ${sessionId}`);
  }

  return creditTransaction;
}

export async function getPaymentReturnUrl(): Promise<string | null> {
  return await getAndClearPaymentReturnUrl();
}
