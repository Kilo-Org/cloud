import type { User } from '@kilocode/db/schema';
import { apple_iap_purchases, credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { eq, sql } from 'drizzle-orm';
import { getAppleCreditProduct } from './products';
import type { AppleDecodedTransaction } from './types';
import { verifyAppleTransactionJws } from './verifier';

const EXPECTED_BUNDLE_ID = 'com.kilocode.kiloapp';

type ProcessAppleCreditPurchaseParams = {
  user: User;
  transactionJws: string;
  verifyTransaction?: (transactionJws: string) => Promise<AppleDecodedTransaction>;
};

export type ProcessAppleCreditPurchaseResult = {
  creditedCents: number;
  creditedMicrodollars: number;
  alreadyProcessed: boolean;
};

function assertValidTransaction(transaction: AppleDecodedTransaction) {
  if (transaction.bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error('Apple transaction bundle mismatch');
  }
  if (transaction.revocationDate) {
    throw new Error('Apple transaction has been revoked');
  }
  const product = getAppleCreditProduct(transaction.productId);
  if (!product || !product.enabled) {
    throw new Error('Apple product is not enabled');
  }
  return product;
}

export async function processAppleCreditPurchase({
  user,
  transactionJws,
  verifyTransaction = verifyAppleTransactionJws,
}: ProcessAppleCreditPurchaseParams): Promise<ProcessAppleCreditPurchaseResult> {
  const transaction = await verifyTransaction(transactionJws);
  const product = assertValidTransaction(transaction);

  return db.transaction(async tx => {
    const existing = await tx.query.apple_iap_purchases.findFirst({
      where: eq(apple_iap_purchases.apple_transaction_id, transaction.transactionId),
    });

    if (existing) {
      if (existing.kilo_user_id !== user.id) {
        throw new Error('Apple transaction already belongs to another user');
      }
      return {
        creditedCents: existing.credited_cents,
        creditedMicrodollars: existing.credited_microdollars,
        alreadyProcessed: true,
      };
    }

    const creditTransactionId = crypto.randomUUID();
    await tx.insert(credit_transactions).values({
      id: creditTransactionId,
      kilo_user_id: user.id,
      is_free: false,
      amount_microdollars: product.creditedMicrodollars,
      description: 'Top-up via Apple',
      original_baseline_microdollars_used: user.microdollars_used,
    });

    await tx.insert(apple_iap_purchases).values({
      kilo_user_id: user.id,
      apple_transaction_id: transaction.transactionId,
      apple_original_transaction_id: transaction.originalTransactionId,
      apple_web_order_line_item_id: transaction.webOrderLineItemId ?? null,
      product_id: transaction.productId,
      environment: transaction.environment,
      bundle_id: transaction.bundleId,
      purchase_date: new Date(transaction.purchaseDate).toISOString(),
      gross_price_cents: product.grossPriceCents,
      credited_cents: product.creditedCents,
      credited_microdollars: product.creditedMicrodollars,
      signed_transaction_jws: transactionJws,
      status: 'granted',
      credit_transaction_id: creditTransactionId,
    });

    await incrementUserAcquiredCredits(tx, user.id, product.creditedMicrodollars);

    return {
      creditedCents: product.creditedCents,
      creditedMicrodollars: product.creditedMicrodollars,
      alreadyProcessed: false,
    };
  });
}

async function incrementUserAcquiredCredits(
  tx: DrizzleTransaction,
  userId: string,
  amountMicrodollars: number
) {
  const result = await tx
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, userId));
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Failed to update Apple IAP credit balance for user ${userId}`);
  }
}

export async function reverseAppleCreditPurchase(params: {
  appleTransactionId: string;
  reversalReason: 'refunded' | 'revoked';
}): Promise<{ reversed: boolean }> {
  return db.transaction(async tx => {
    const purchase = await tx.query.apple_iap_purchases.findFirst({
      where: eq(apple_iap_purchases.apple_transaction_id, params.appleTransactionId),
    });
    if (!purchase) return { reversed: false };
    if (purchase.refund_credit_transaction_id) return { reversed: false };

    const refundCreditTransactionId = crypto.randomUUID();
    await tx.insert(credit_transactions).values({
      id: refundCreditTransactionId,
      kilo_user_id: purchase.kilo_user_id,
      is_free: false,
      amount_microdollars: -purchase.credited_microdollars,
      description: `Apple top-up ${params.reversalReason}`,
      original_transaction_id: purchase.credit_transaction_id,
    });

    await tx
      .update(apple_iap_purchases)
      .set({
        status: params.reversalReason === 'refunded' ? 'refunded' : 'revoked',
        refunded_at: new Date().toISOString(),
        refund_credit_transaction_id: refundCreditTransactionId,
      })
      .where(eq(apple_iap_purchases.id, purchase.id));

    await incrementUserAcquiredCredits(tx, purchase.kilo_user_id, -purchase.credited_microdollars);
    return { reversed: true };
  });
}
