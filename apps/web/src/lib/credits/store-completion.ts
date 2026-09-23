import { credit_transactions } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { processTopUp } from '@/lib/credits';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

import { storeCreditPaymentId } from './store-products';
import type { ValidatedStoreCreditPurchase } from './store-verifier';

function roundUsdToCents(usd: number): number {
  return Math.round(usd * 100);
}

function creditDescriptionForProvider(provider: KiloPassPaymentProvider): string {
  return provider === KiloPassPaymentProvider.AppStore
    ? 'Credit purchase via App Store'
    : 'Credit purchase via Google Play';
}

/**
 * The only place a store credit purchase is granted.
 *
 * The amount always comes from the catalog via the verifier, never from a
 * caller argument. `processTopUp` is the canonical way to create paid credits;
 * `skipPostTopUpFreeStuff` keeps the first-top-up bonus and the top-up email
 * out of store packs.
 */
export async function completeStoreCreditPurchase(params: {
  user: User;
  purchase: ValidatedStoreCreditPurchase;
  dbOrTx?: DrizzleTransaction;
}): Promise<{
  alreadyProcessed: boolean;
  amountUsd: number;
  amountMicrodollars: number;
  creditTransactionId: string | null;
}> {
  const { user, purchase, dbOrTx } = params;

  const paymentId = storeCreditPaymentId(purchase.paymentProvider, purchase.providerTransactionId);
  const amountUsd = purchase.amountUsd * purchase.quantity;
  const amountCents = roundUsdToCents(amountUsd);
  const amountMicrodollars = purchase.amountMicrodollars;

  const attemptedCreditTransactionId = crypto.randomUUID();
  const didGrant = await processTopUp(
    user,
    amountCents,
    {
      type: 'stripe',
      stripe_payment_id: paymentId,
    },
    {
      dbOrTx,
      creditTransactionId: attemptedCreditTransactionId,
      creditDescription: creditDescriptionForProvider(purchase.paymentProvider),
      skipPostTopUpFreeStuff: true,
    }
  );

  if (didGrant) {
    return {
      alreadyProcessed: false,
      amountUsd,
      amountMicrodollars,
      creditTransactionId: attemptedCreditTransactionId,
    };
  }

  // processTopUp returned false: this store transaction was already credited.
  const executor = dbOrTx ?? db;
  const existing = (
    await executor
      .select({
        id: credit_transactions.id,
        kilo_user_id: credit_transactions.kilo_user_id,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.stripe_payment_id, paymentId))
      .limit(1)
  )[0];

  if (!existing) {
    throw new Error('Failed to find the existing store credit transaction');
  }
  if (existing.kilo_user_id !== user.id) {
    throw new Error('Store transaction already belongs to another user');
  }

  return {
    alreadyProcessed: true,
    amountUsd,
    amountMicrodollars,
    creditTransactionId: existing.id,
  };
}
