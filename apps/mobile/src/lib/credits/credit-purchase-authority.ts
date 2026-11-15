import { z } from 'zod';

import { getItem, setItem } from '@/lib/persist/encrypted-kv';
import {
  type CreditPurchaseIntent,
  ownsCreditPurchaseIntent,
} from './credit-purchase-intent';

const SCOPE = 'credit-purchase';
const HISTORY_KEY = 'uncertain-native-history';
let earlierUnresolved: boolean | null = null;
let loading: Promise<void> | null = null;
let dispatchedHere = new WeakSet<CreditPurchaseIntent>();
const transportDisconnection = z.object({
  code: z.enum([
    'service-disconnected',
    'connection-closed',
    'not-prepared',
    'network-error',
    'service-unavailable',
    'init-connection',
  ]),
});

export async function restoreCreditPurchaseAuthority(): Promise<void> {
  loading ??= (async () => {
    const saved = await getItem(SCOPE, HISTORY_KEY);
    if (earlierUnresolved !== true) {
      earlierUnresolved = saved !== null;
    }
  })();
  const pending = loading;
  try {
    await pending;
  } catch (error) {
    if (loading === pending) {
      loading = null;
    }
    throw error;
  }
}

export async function retainEarlierUnresolvedPurchase(): Promise<void> {
  earlierUnresolved = true;
  await setItem(SCOPE, HISTORY_KEY, '1');
}

export function registerCreditPurchaseDispatch(record: CreditPurchaseIntent): void {
  if (!ownsCreditPurchaseIntent(record) || !record.dispatched) {
    throw new Error('The native purchase has no current dispatched admission.');
  }
  dispatchedHere.add(record);
}

// expo-iap pools native purchase promises. Replacing an unresolved request makes
// subsequent outcomes ambiguous, even when one JavaScript caller captured them.
export function canAttributeNativePurchaseOutcome(record: CreditPurchaseIntent): boolean {
  return (
    earlierUnresolved === false &&
    record.dispatched &&
    dispatchedHere.has(record) &&
    ownsCreditPurchaseIntent(record)
  );
}

export function isCreditPurchaseTransportDisconnection(error: unknown): boolean {
  return transportDisconnection.safeParse(error).success;
}

export function resetCreditPurchaseAuthorityForTests(): void {
  earlierUnresolved = null;
  loading = null;
  dispatchedHere = new WeakSet<CreditPurchaseIntent>();
}
