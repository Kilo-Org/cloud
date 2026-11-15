import { type Purchase } from 'expo-iap';

import { getPurchaseCompletionId } from './use-store-credit-purchase';

/**
 * The purchase request this process is waiting on.
 *
 * The barrier is deliberately in memory. The store SDK's purchase promises and
 * its deferred-transaction bookkeeping die with the app process, so a record
 * written to disk would outlive the state it describes: it would block a later
 * launch (and an unrelated account) for a native request that no longer exists.
 * After a restart the only surviving route for an old charge is the store
 * re-delivering it, which the transaction-deduplicated recovery credits once.
 */
export type CreditPurchaseIntent = {
  readonly id: string;
  readonly productId: string;
  readonly accountToken: string;
  /** The auth epoch that admitted it; a different epoch never inherits it. */
  readonly epoch: number;
  readonly transactionIds: string[];
  dispatched: boolean;
};

let intent: CreditPurchaseIntent | null = null;
let sequence = 0;

export function resetCreditPurchaseIntentForTests(): void {
  intent = null;
  sequence = 0;
}

export function currentCreditPurchaseIntent(): CreditPurchaseIntent | null {
  return intent;
}

/**
 * Admits one request for this product. A record from another account or auth
 * epoch is dropped first: the barrier belongs to the session that started it.
 */
export function admitCreditPurchaseIntent(productId: string, accountToken: string, epoch: number) {
  // A session that did not admit this request never inherits it — but a request
  // that already reached the store is never dropped silently: it is a charge.
  if (
    intent !== null &&
    !intent.dispatched &&
    (intent.epoch !== epoch || intent.accountToken !== accountToken)
  ) {
    intent = null;
  }
  if (intent !== null) {
    return { intent, created: false };
  }
  sequence += 1;
  const admitted: CreditPurchaseIntent = {
    id: `purchase-request-${String(sequence)}`,
    productId,
    accountToken,
    epoch,
    transactionIds: [],
    dispatched: false,
  };
  intent = admitted;
  return { intent: admitted, created: true };
}

export function ownsCreditPurchaseIntent(record: CreditPurchaseIntent): boolean {
  return intent === record;
}

export function matchesCreditPurchaseIntent(record: CreditPurchaseIntent, purchase: Purchase) {
  return record.transactionIds.includes(getPurchaseCompletionId(purchase));
}

export function markCreditPurchaseIntentDispatched(record: CreditPurchaseIntent): void {
  if (intent !== record) {
    throw new Error('The purchase admission no longer belongs to this request.');
  }
  record.dispatched = true;
}

export function identifyCreditPurchaseTransaction(
  record: CreditPurchaseIntent,
  purchase: Purchase
): void {
  if (intent !== record) {
    return;
  }
  const id = getPurchaseCompletionId(purchase);
  if (!record.transactionIds.includes(id)) {
    record.transactionIds.push(id);
  }
}

export function retireCreditPurchaseIntent(record: CreditPurchaseIntent): void {
  if (intent === record) {
    intent = null;
  }
}
