import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';
import { isProtectedDataAvailable } from '@/lib/protected-data';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';

export type ActiveToken = {
  token: string;
  expiresAtMs: number | null;
};

export type ActiveTokenSnapshot = ActiveToken & { epoch: number };

let activeToken: ActiveTokenSnapshot | null = null;

// Sign-out teardown guard: set synchronously when sign-out starts and cleared
// only when a sign-in publishes credentials. While it is set the stored
// credentials are scheduled for deletion, so a refresh must not read or
// publish them and a request-token cold read must not warm the owner from
// them. The in-memory owner keeps serving while the guard is set: sign-out's
// remote cleanup still needs its auth headers until the epoch bump.
let signOutTeardownActive = false;

/** Marks the sign-out teardown window (set at sign-out start, cleared at a sign-in's publish). */
export function setSignOutTeardownActive(active: boolean): void {
  signOutTeardownActive = active;
}

export function isSignOutTeardownActive(): boolean {
  return signOutTeardownActive;
}

/** Holds the token in memory, tagged with the auth epoch that was current when it was stored. */
export function setActiveToken(token: string, expiresAtMs: number | null): void {
  activeToken = { token, expiresAtMs, epoch: currentAuthEpoch() };
}

/** Returns the held token and expiry, or null when unset or when the epoch moved. */
export function getActiveToken(): ActiveToken | null {
  const snapshot = getActiveTokenSnapshot();
  if (!snapshot) {
    return null;
  }
  return { token: snapshot.token, expiresAtMs: snapshot.expiresAtMs };
}

export function getActiveTokenSnapshot(): ActiveTokenSnapshot | null {
  if (!activeToken || !isCurrentAuthEpoch(activeToken.epoch)) {
    return null;
  }
  return { ...activeToken };
}

/**
 * Publishes a resolved expiry into the held owner after the cold path read
 * `TOKEN_EXPIRES_AT_KEY`. Applies only when the owner still holds the same
 * token for the current epoch, so a newer owner published while the expiry
 * was read is never overwritten.
 */
export function publishActiveTokenExpiry(
  snapshot: ActiveTokenSnapshot,
  expiresAtMs: number | null
): void {
  if (
    !activeToken ||
    activeToken.token !== snapshot.token ||
    activeToken.epoch !== snapshot.epoch ||
    !isCurrentAuthEpoch(activeToken.epoch)
  ) {
    return;
  }
  activeToken = { ...activeToken, expiresAtMs };
}

export function clearActiveToken(): void {
  activeToken = null;
}

/**
 * The single shared token read for outgoing requests. Returns the in-memory
 * token when one is held for the current auth epoch; otherwise reads
 * SecureStore once and — only if the epoch is unchanged, no newer owner was
 * published while reading, and sign-out teardown is not active — warms the
 * owner so the next read is an in-memory hit. A read that races an epoch bump
 * still returns what it read (one-shot request), but never warms the owner,
 * and an owner published during the read wins over the stored value. During
 * sign-out teardown the cold path returns no token and never warms: the
 * stored credentials are scheduled for deletion. While iOS protected data is
 * unavailable the cold path returns no token too: a locked keychain refuses
 * every read, that refusal is the documented unreported state (see
 * `lib/protected-data`), and it must not become a rejected request — whether
 * the lock is known before the read or lands while it runs. A held token
 * keeps serving, and the next unlocked read resolves the stored one.
 */
export async function getAuthTokenForRequest(): Promise<string | null> {
  const active = getActiveToken();
  if (active) {
    return active.token;
  }
  // The lock cannot supply a token and must not fail the caller: skip the
  // keychain read (it would throw `ProtectedDataUnavailableError`) and warm
  // nothing. The request goes out without a token and the next unlocked read
  // resolves the stored one.
  if (!isProtectedDataAvailable()) {
    return null;
  }
  const epoch = currentAuthEpoch();
  if (isSignOutTeardownActive()) {
    return null;
  }
  let token: string | null = null;
  try {
    token = await readStoredValueWithRetry(AUTH_TOKEN_KEY);
  } catch (error) {
    // The device can lock while the read is in flight, between its retries:
    // the read then refuses to call the keychain and rejects. That refusal is
    // the same expected, unreported state as the check above, so answer it
    // with no token instead of failing the caller. A newer owner published
    // while the read ran still wins, exactly as on the successful path.
    const refusedOwner = getActiveToken();
    if (refusedOwner) {
      return refusedOwner.token;
    }
    if (isProtectedDataAvailable()) {
      throw error;
    }
    return null;
  }
  // A sign-in or refresh may have published a newer owner while the cold read
  // was in flight: prefer it and never overwrite it with the stale read.
  const published = getActiveToken();
  if (published) {
    return published.token;
  }
  // One read for both decisions: the flag cannot change between them.
  const tearingDown = isSignOutTeardownActive();
  if (token && isCurrentAuthEpoch(epoch) && !tearingDown) {
    setActiveToken(token, null);
  }
  return tearingDown ? null : token;
}
