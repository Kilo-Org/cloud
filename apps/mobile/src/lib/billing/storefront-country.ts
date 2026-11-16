import { withStoreDeadline } from '@/lib/iap/store-call-deadline';

/**
 * The one storefront whose review guideline permits an in-app link to a web
 * purchase: the United States. StoreKit reports it as ISO 3166-1 alpha-3.
 */
export const US_STOREFRONT_COUNTRY = 'USA';

/**
 * The last country the store answered with, for the life of the process. Only
 * a successful read is kept: a storefront that failed or hung must be asked
 * again on the next surface that needs it, so one transient failure cannot pin
 * every later screen to plain text.
 */
let answeredCountry: string | null = null;

/** One read in flight, so several surfaces mounting together ask the store once. */
let pendingRead: Promise<string | null> | null = null;

/** The country a successful read already answered with, or `null` while unknown. */
export function cachedStorefrontCountry(): string | null {
  return answeredCountry;
}

/**
 * The App Store storefront's country code, or `null` when the store cannot
 * answer.
 *
 * The read is bounded by the shared store deadline: StoreKit can leave a cold
 * call unsettled, and a screen that waits forever for a link decision would
 * never settle its own layout. A deadline or a rejection is reported as an
 * unknown country, which every caller treats as "no link".
 */
export function readStorefrontCountry(): Promise<string | null> {
  if (answeredCountry != null) {
    return Promise.resolve(answeredCountry);
  }
  pendingRead ??= readOnce();
  return pendingRead;
}

async function readOnce(): Promise<string | null> {
  try {
    // `expo-iap` builds its native module at import time, so the module is
    // reached only on this path: the app's pure test project has no Expo
    // runtime, and any surface that never asks the store loads none of it.
    const { getStorefront } = await import('expo-iap');
    const country = await withStoreDeadline(getStorefront(), 'the App Store storefront');
    answeredCountry = country;
    return country;
  } catch {
    return null;
  } finally {
    pendingRead = null;
  }
}
