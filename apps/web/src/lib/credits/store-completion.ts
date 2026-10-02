import { credit_transactions } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { reportCreditEvent } from '@/lib/bouncer/client';
import { runAfterResponse } from '@/lib/after-response';
import { processTopUp } from '@/lib/credits';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';

import {
  findEffectiveStoreCreditRefundEvent,
  lockStoreCreditPurchase,
  STORE_PURCHASE_REFUNDED_MESSAGE,
} from './store-refund';
import { StoreCreditPurchaseOwnedByAnotherAccountError } from './store-purchase-errors';
import { storeCreditPaymentId } from './store-products';
import {
  storeCreditRefundLookupProviderTransactionIds,
  type ValidatedStoreCreditPurchase,
} from './store-verifier';

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
 *
 * A purchase whose refund still stands is never granted. The refund
 * notification can arrive before the client finishes the purchase — a saved
 * receipt replays a transaction that Apple already reversed — and the refunded
 * credits would then have no clawback, because the store never redelivers a
 * processed refund event. The grant and the refund handlers therefore take the
 * same per-purchase lock, so the two are ordered rather than racing.
 *
 * A refund the store has since reversed is not effective, so it no longer
 * blocks the grant: the reversal restores whatever the refund clawed back, and
 * the purchase Kilo never granted is credited here instead.
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
  const storeTransaction = {
    paymentProvider: purchase.paymentProvider,
    providerTransactionIds: [purchase.providerTransactionId],
  };
  // The refund event table stores the raw Play purchase token by design, while a
  // grant is keyed by the token digest when Play reported no order id, so the
  // refund lookup also matches the raw token. It may reach this SELECT only: the
  // token never becomes a lock key or a ledger value.
  const refundLookupTransaction = {
    paymentProvider: purchase.paymentProvider,
    providerTransactionIds: storeCreditRefundLookupProviderTransactionIds(purchase),
  };

  const asAlreadyProcessed = (existing: { id: string; kiloUserId: string } | null) => {
    if (!existing) {
      throw new Error('Failed to find the existing store credit transaction');
    }
    if (existing.kiloUserId !== user.id) {
      throw new StoreCreditPurchaseOwnedByAnotherAccountError();
    }
    return {
      alreadyProcessed: true,
      amountUsd,
      amountMicrodollars,
      creditTransactionId: existing.id,
    };
  };

  const complete = async (tx: DrizzleTransaction) => {
    await lockStoreCreditPurchase(tx, storeTransaction);

    const findGrant = async () =>
      (
        await tx
          .select({
            id: credit_transactions.id,
            kiloUserId: credit_transactions.kilo_user_id,
          })
          .from(credit_transactions)
          .where(eq(credit_transactions.stripe_payment_id, paymentId))
          .limit(1)
      )[0] ?? null;

    const refundEvent = await findEffectiveStoreCreditRefundEvent(tx, refundLookupTransaction);
    if (refundEvent && !(await findGrant())) {
      throw new Error(STORE_PURCHASE_REFUNDED_MESSAGE);
    }

    const didGrant = await processTopUp(
      user,
      amountCents,
      {
        type: 'stripe',
        stripe_payment_id: paymentId,
      },
      {
        dbOrTx: tx,
        creditTransactionId: attemptedCreditTransactionId,
        creditDescription: creditDescriptionForProvider(purchase.paymentProvider),
        skipPostTopUpFreeStuff: true,
      }
    );

    if (didGrant) {
      // The store purchase audit trail shared with Kilo Pass. A credit pack has
      // no subscription, so only the user and the granted credit row are linked.
      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StorePurchaseCompleted,
        result: KiloPassAuditLogResult.Success,
        kiloUserId: user.id,
        relatedCreditTransactionId: attemptedCreditTransactionId,
        payload: {
          kind: 'store_credit_pack',
          paymentProvider: purchase.paymentProvider,
          productId: purchase.productId,
          providerTransactionId: purchase.providerTransactionId,
          environment: purchase.environment,
          amountUsd,
        },
      });
      return {
        alreadyProcessed: false,
        amountUsd,
        amountMicrodollars,
        creditTransactionId: attemptedCreditTransactionId,
      };
    }

    // processTopUp returned false: this store transaction was already credited.
    // Reaching it with a processed refund event is a replayed completion of a
    // purchase the refund already clawed back, so it stays idempotent too.
    return asAlreadyProcessed(await findGrant());
  };

  return dbOrTx ? complete(dbOrTx) : db.transaction(complete);
}

/**
 * Reports a newly granted production credit pack to bouncer, post-response.
 * A replayed completion reports nothing: the first grant already did. The
 * catalog amount is in US dollars, so it is sent as cents.
 */
export async function reportStoreCreditPurchaseToBouncer(params: {
  userId: string;
  purchase: ValidatedStoreCreditPurchase;
  result: { alreadyProcessed: boolean; amountUsd: number };
}): Promise<void> {
  const { userId, purchase, result } = params;
  if (result.alreadyProcessed || purchase.environment !== 'Production') return;
  const isAppStore = purchase.paymentProvider === KiloPassPaymentProvider.AppStore;
  await runAfterResponse(() =>
    reportCreditEvent({
      type: 'store.purchase',
      amountCents: roundUsdToCents(result.amountUsd),
      provider: isAppStore ? 'apple' : 'google',
      eventId: storeCreditPaymentId(purchase.paymentProvider, purchase.providerTransactionId),
      occurredAt: purchase.purchasedAtIso,
      userId,
      referenceId: purchase.providerTransactionId,
      environment: 'production',
    })
  );
}
