import { z } from 'zod';

import { type CreditPurchaseIntent, ownsCreditPurchaseIntent } from './credit-purchase-intent';

/**
 * The native requests this process dispatched whose pooled promise has not
 * settled yet.
 *
 * expo-iap pools its purchase promises: one native result or error settles every
 * pending request in the pool, and its connection cleanup rejects them all with
 * `ServiceDisconnected`. So a captured JavaScript promise says nothing about
 * which request an outcome belongs to unless it is the pool's only member — and
 * a request whose promise already settled says nothing at all about a later one.
 */
let unsettledDispatches = new Set<CreditPurchaseIntent>();
let ambiguousDispatches = new Set<CreditPurchaseIntent>();

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
  unsettledDispatches.add(record);
}

/**
 * The pooled promise for this request settled.
 *
 * The SDK settles every pending promise of its pool in the same tick, so an
 * outcome that arrives while more than one request is waiting could belong to
 * any of them. Ambiguity is therefore decided for the whole pool here, before
 * any member leaves it: a member marked ambiguous never becomes attributable
 * again, however small the set gets afterwards.
 */
export function settleCreditPurchaseDispatch(record: CreditPurchaseIntent): void {
  if (unsettledDispatches.size > 1) {
    for (const member of unsettledDispatches) {
      ambiguousDispatches.add(member);
    }
  }
  unsettledDispatches.delete(record);
}

/**
 * An outcome belongs to the captured request only when that request is the one
 * dispatched request left waiting: the pool settles them together, so a larger
 * set means the outcome could be any member's.
 */
export function canAttributeNativePurchaseOutcome(record: CreditPurchaseIntent): boolean {
  return (
    record.dispatched &&
    ownsCreditPurchaseIntent(record) &&
    unsettledDispatches.size === 1 &&
    unsettledDispatches.has(record) &&
    !ambiguousDispatches.has(record)
  );
}

/** A store that answered `not-prepared` never reached the store: not a disconnection. */
export function isCreditPurchaseTransportDisconnection(error: unknown): boolean {
  return transportDisconnection.safeParse(error).success;
}

export function resetCreditPurchaseAuthorityForTests(): void {
  unsettledDispatches = new Set<CreditPurchaseIntent>();
  ambiguousDispatches = new Set<CreditPurchaseIntent>();
}
