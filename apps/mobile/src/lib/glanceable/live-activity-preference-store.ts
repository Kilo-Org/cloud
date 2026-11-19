import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';
import { LIVE_ACTIVITY_KEY } from '@/lib/storage-keys';

/**
 * The stored Live Activity switch: the one parse rule and one retry budget for
 * every reader of the key.
 *
 * The settings hook (`use-live-activity-preference`) owns the store and mirrors
 * its answers into the switch holder; a headless run reads the key directly
 * (`lib/notifications`), so a stored-format change can never flip one reader to
 * the shipped default while the other keeps the real value. Default-on: only
 * the exact stored string 'false' turns it off, so a missing value keeps the
 * behavior the app ships with.
 *
 * This module must stay free of the store (and of React): `notifications.ts`
 * loads in headless contexts, and the pure suites must not pull the store's
 * toast/i18n graph in with it.
 */

export function parseLiveActivityEnabled(raw: string | null): boolean {
  return raw !== 'false';
}

/**
 * The stored switch, read straight from SecureStore through the store's own
 * retry budget. `null` is this read's "no answer" marker and means the read
 * threw (a locked or failing keychain); an absent key is an answer, not this
 * null.
 */
export async function readStoredLiveActivityEnabled(): Promise<boolean | null> {
  try {
    return parseLiveActivityEnabled(await readStoredValueWithRetry(LIVE_ACTIVITY_KEY));
  } catch {
    return null;
  }
}
