import { getAvailablePurchases, getPendingTransactionsIOS, type Purchase } from 'expo-iap';

/** The store a device buys from. Both in-app purchase flows use the same two. */
export type StorePurchaseStorefront = 'app_store' | 'play';

/**
 * The transactions the store still holds for this device: the ones a charged
 * purchase the backend has not granted yet is recoverable from.
 *
 * On iOS an unfinished transaction waits in the StoreKit payment queue, and
 * `getAvailablePurchases` does not list it there. That call answers with the
 * entitlements the account owns, which for a one-off consumable is nothing once
 * the store granted it, so the recovery pass read an empty list and completed
 * nothing. Measured on 2026-09-29 on a physical iPhone with a charged,
 * unfinished `credits.usd10.v1` transaction: `getAvailablePurchases` returned
 * `[]` while the queue still held the transaction, and the user's balance stayed
 * one pack short with no message anywhere. `getPendingTransactionsIOS` is the
 * queue query. Android keeps an unfinished purchase in its own query, so the
 * Play storefront reads that.
 *
 * The storefront, not the platform, chooses the query: it is the value that
 * already names which store this device has.
 */
export async function fetchPendingStorePurchases(
  storefront: StorePurchaseStorefront
): Promise<Purchase[]> {
  if (storefront === 'app_store') {
    const queuedTransactions = await getPendingTransactionsIOS();
    return queuedTransactions;
  }
  const pendingPurchases = await getAvailablePurchases();
  return pendingPurchases;
}
