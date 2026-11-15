import { z } from 'zod';

import { type CreditPurchaseIntent, ownsCreditPurchaseIntent } from './credit-purchase-intent';

let dispatchedHere = new WeakSet<CreditPurchaseIntent>();

const transportDisconnection = z.object({
  code: z.enum([
    'service-disconnected',
    'connection-closed',
    'network-error',
    'service-unavailable',
    'init-connection',
  ]),
});

export function registerCreditPurchaseDispatch(record: CreditPurchaseIntent): void {
  if (!ownsCreditPurchaseIntent(record) || !record.dispatched) {
    throw new Error('The native purchase has no current dispatched admission.');
  }
  dispatchedHere.add(record);
}

// expo-iap pools native purchase promises. Replacing an unresolved request makes
// subsequent outcomes ambiguous, even when one JavaScript caller captured them.
export function canAttributeNativePurchaseOutcome(record: CreditPurchaseIntent): boolean {
  return record.dispatched && dispatchedHere.has(record) && ownsCreditPurchaseIntent(record);
}

/** A store that answered `not-prepared` never reached the store: not a disconnection. */
export function isCreditPurchaseTransportDisconnection(error: unknown): boolean {
  return transportDisconnection.safeParse(error).success;
}

export function resetCreditPurchaseAuthorityForTests(): void {
  dispatchedHere = new WeakSet<CreditPurchaseIntent>();
}
