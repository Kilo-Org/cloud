import { keychainAnswersNow } from '@/lib/auth/secure-store-gated';
import { readStoredValueRetryingNull } from '@/lib/auth/secure-store-read';
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
 * A `null` read counts as an answer only when `keychainAnswersNow()` proves the
 * keychain answers; otherwise the preference stays unknown. A locked keychain
 * answers `null` for an item it will not hand over, so taking that `null` for
 * the shipped default would turn an absent read into consent.
 *
 * This module must stay free of the preference store (and of React): the switch
 * holder is its only sink, and `notifications.ts` loads in headless contexts.
 * The gated keychain prover it reads is itself free of the native module at
 * load.
 */

export function parseLiveActivityEnabled(raw: string | null): boolean {
  return raw !== 'false';
}

/**
 * The stored switch, read straight from SecureStore with the retry budget that
 * retries a `null` resolution. A `null` is a real answer only when the keychain
 * answers right now (a default-class write lands), so the shipped default on
 * applies only to a proven absence. Otherwise the read returns `null`, its
 * "no answer" marker, which the holder must not read as consent. A rejection
 * still returns `null`.
 */
export async function readStoredLiveActivityEnabled(): Promise<boolean | null> {
  try {
    const raw = await readStoredValueRetryingNull(LIVE_ACTIVITY_KEY);
    if (raw !== null) {
      return parseLiveActivityEnabled(raw);
    }
    return (await keychainAnswersNow()) ? parseLiveActivityEnabled(null) : null;
  } catch {
    return null;
  }
}
