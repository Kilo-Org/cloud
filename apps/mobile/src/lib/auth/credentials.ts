import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { classifyAuthResponse, reportAuthTerminalFailure } from '@/lib/auth/auth-response-class';
import { parseTokenPair } from '@/lib/auth/native-auth-contract';
import {
  readStoredValueRetryingNull,
  readStoredValueWithRetry,
} from '@/lib/auth/secure-store-read';
import { getActiveToken, isSignOutTeardownActive, setActiveToken } from '@/lib/auth/token-owner';
import { chainSave } from '@/lib/hooks/save-chain';
import { AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from '@/lib/storage-keys';
import { CONTROL_PLANE_DEADLINE_MS, withDeadline } from '@kilocode/event-service';

// Apple `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is not in iCloud or
// iTunes backup and does not migrate to a new device. Pin every bearer-token
// write and delete to it so credentials never follow a device restore.
export const IOS_BEARER_SECURE_STORE_OPTIONS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Credential persistence and refresh rotation, with no React dependency.
 *
 * Split out of `auth-context.tsx` so the modules that need only the token
 * lifecycle — `trpc.ts` and `exchange-legacy-token.ts` — do not import the
 * provider. Those imports formed two require cycles
 * (auth-context -> exchange-legacy-token -> auth-context, and
 * auth-context -> logout-cleanup -> trpc -> auth-context) that survived only
 * because every use sat inside a function body.
 */

// Single-flight refresh lock. Only the first caller initiates the rotation;
// concurrent callers await the same promise.
let refreshPromise: Promise<RefreshOutcome> | null = null;

type RefreshSuccess = {
  ok: true;
  token: string;
  refreshToken: string;
  expiresIn: number;
  sessionVersion: number;
};
type RefreshRefused = {
  ok: false;
  refused: true;
  superseded?: false;
  unreadable?: false;
  /** The session that owned the refusal. A handler must drop the refusal when
   *  this is no longer the current epoch: the epoch can move while the clear
   *  awaits, and signing out then would tear down the newer session. */
  sessionVersion: number;
};
type RefreshTransient = {
  ok: false;
  refused: false;
  superseded?: false;
  unreadable?: false;
  /** The server's own back-off from a 429/503 `Retry-After`, when it sent one. */
  retryAfterMs?: number;
};
type RefreshSuperseded = { ok: false; refused: false; superseded: true; unreadable?: false };
/**
 * The refresh-token read spent its whole budget on `null` while the rest of
 * the credential set may still hold a session: an unreadable credential read,
 * not an absent session. Never a refusal — a null member is not a signed-out
 * session, so the caller must not sign out. `presentKeys` carries storage-key
 * names only, never a value.
 */
type RefreshUnreadable = {
  ok: false;
  refused: false;
  superseded?: false;
  unreadable: true;
  presentKeys: readonly string[];
};
export type RefreshOutcome =
  | RefreshSuccess
  | RefreshRefused
  | RefreshTransient
  | RefreshSuperseded
  | RefreshUnreadable;

// The one refresh route. Named so the classification fingerprints and the
// request path can never drift apart.
const REFRESH_PATH = '/api/auth/native/refresh';

// Proactive refresh window: refresh when the token expires within 5 minutes.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Serializes every credential write on one FIFO chain. */
export async function writeCredentials<T>(write: () => Promise<T>): Promise<T> {
  const result = await chainSave('credentials', write);
  return result;
}

/**
 * Delete the stored bearer pair.
 *
 * Called when a 401 proves the credential is gone: keeping the dead pair is
 * what makes every later request try again and fail again. The deletes run on
 * the serialized credential queue, so a sign-in or sign-out that moved the
 * epoch first wins and this clear is skipped rather than resurrecting a
 * teardown. `epoch` is the session that owned the refusal, captured before the
 * request that produced it.
 *
 * The in-memory owner is deliberately NOT dropped here. Sign-out's teardown
 * clears it, and until then it must keep serving: the refusal-triggered
 * sign-out's remote cleanup (device-session revoke, push-token unregister)
 * runs BEFORE the epoch bump and reads the owner for its Authorization header
 * (`getAuthTokenForRequest`). Emptying the owner here would send that cleanup
 * unauthenticated and fail it. Dropping the stored refresh token is what stops
 * the loop: the next refresh finds none and returns without a request
 * (unreadable, not a refusal — see `RefreshUnreadable`).
 */
async function clearStoredCredentialsAtEpoch(epoch: number): Promise<void> {
  const superseded = (): boolean => !isCurrentAuthEpoch(epoch) || isSignOutTeardownActive();
  if (superseded()) {
    return;
  }
  await writeCredentials(async () => {
    if (superseded()) {
      return;
    }
    // Best effort, like sign-out's credential batch: a keychain rejection must
    // not escape into doRefresh's catch, which would downgrade this terminal
    // 401 into a retryable outcome and restart the very loop it must stop. The
    // refusal is reported by the caller regardless.
    await Promise.allSettled([
      SecureStore.deleteItemAsync(AUTH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS),
      SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY, IOS_BEARER_SECURE_STORE_OPTIONS),
    ]);
  });
}

/**
 * Persists a credential pair through the serialized credential write queue.
 * Returns whether the pair was published to the token owner. A newer sign-in
 * or sign-out that superseded the write while it waited or ran fences it:
 * any partial credential keys already committed are cleared and nothing is
 * published, so a stale sign-in can never surface.
 */
type PersistCredentialsOptions = {
  expiresIn?: number;
  expectedEpoch?: number;
};

export async function persistSignInCredentialsAtEpoch(
  token: string,
  refreshToken: string | undefined,
  options: PersistCredentialsOptions
): Promise<boolean> {
  const epoch = options.expectedEpoch ?? currentAuthEpoch();
  const expiresIn = options.expiresIn;
  const expiresAtMs = refreshToken && expiresIn ? Date.now() + expiresIn * 1000 : null;
  const hasPair = expiresAtMs !== null;

  // Wipe every credential key a fenced write may already have committed.
  // Runs inside the serialized write queue, so it cannot remove the keys of
  // a newer sign-in or sign-out: their own credential write is queued
  // strictly behind this one.
  const clearPartialCredentials = async (): Promise<void> => {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
    await SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
  };

  // Fence one credential operation: skip it when the epoch moved before the
  // op, and clear the partial pair when it moved during the op.
  const commitWrite = async (key: string, value?: string): Promise<boolean> => {
    if (!isCurrentAuthEpoch(epoch)) {
      return false;
    }
    await (value === undefined
      ? SecureStore.deleteItemAsync(key, IOS_BEARER_SECURE_STORE_OPTIONS)
      : SecureStore.setItemAsync(key, value, IOS_BEARER_SECURE_STORE_OPTIONS));
    if (!isCurrentAuthEpoch(epoch)) {
      await clearPartialCredentials();
      return false;
    }
    return true;
  };

  let published = false;
  await writeCredentials(async () => {
    if (!(await commitWrite(AUTH_TOKEN_KEY, token))) {
      return;
    }
    if (!(await commitWrite(REFRESH_TOKEN_KEY, hasPair ? refreshToken : undefined))) {
      return;
    }
    if (!(await commitWrite(TOKEN_EXPIRES_AT_KEY, hasPair ? String(expiresAtMs) : undefined))) {
      return;
    }
    // Every fenced operation passed its post-check and nothing awaited since
    // the last one, so the epoch is still current: publish to the owner.
    setActiveToken(token, expiresAtMs);
    published = true;
  });
  return published;
}

export async function performRefresh(): Promise<RefreshOutcome> {
  // Single-flight: if a refresh is already in progress, await that outcome.
  if (refreshPromise) {
    const outcome = await refreshPromise;
    return outcome;
  }

  refreshPromise = doRefresh();
  try {
    const outcome = await refreshPromise;
    return outcome;
  } finally {
    refreshPromise = null;
  }
}

/**
 * The credential key names present after the refresh-token read answered
 * `null`: a names-only diagnostic, never a value. The token and the expiry are
 * read as one unit so a session is never called absent because one member
 * could not be read. Both reads are best-effort: the null already settled the
 * outcome, so a rejection here cannot change it.
 */
async function readPresentCredentialKeys(): Promise<readonly string[]> {
  const [storedAuthToken, storedExpiresAt] = await Promise.allSettled([
    readStoredValueWithRetry(AUTH_TOKEN_KEY),
    readStoredValueWithRetry(TOKEN_EXPIRES_AT_KEY),
  ]);
  const presentKeys: string[] = [];
  const hasAuthToken =
    (storedAuthToken.status === 'fulfilled' && storedAuthToken.value !== null) ||
    getActiveToken() !== null;
  if (hasAuthToken) {
    presentKeys.push(AUTH_TOKEN_KEY);
  }
  if (storedExpiresAt.status === 'fulfilled' && storedExpiresAt.value !== null) {
    presentKeys.push(TOKEN_EXPIRES_AT_KEY);
  }
  return presentKeys;
}

async function doRefresh(): Promise<RefreshOutcome> {
  const sessionVersion = currentAuthEpoch();
  // A refresh is superseded when the session moved or sign-out teardown
  // began: it must then neither read the old refresh token nor publish a new
  // credential pair, so the auth-transition queue never waits on a stale
  // rotation during the teardown gap.
  const superseded = (): boolean =>
    !isCurrentAuthEpoch(sessionVersion) || isSignOutTeardownActive();
  if (superseded()) {
    return { ok: false, refused: false, superseded: true };
  }
  try {
    let storedRefreshToken = await readStoredValueWithRetry(REFRESH_TOKEN_KEY);
    if (superseded()) {
      return { ok: false, refused: false, superseded: true };
    }
    if (storedRefreshToken === null) {
      // A null is not proof of an absent session: a keychain item written
      // WHEN_UNLOCKED_THIS_DEVICE_ONLY answers null while the device is not
      // yet unlocked. Retry the null exactly like a rejection before
      // concluding the credential set cannot refresh.
      storedRefreshToken = await readStoredValueRetryingNull(REFRESH_TOKEN_KEY);
      if (superseded()) {
        return { ok: false, refused: false, superseded: true };
      }
    }
    if (storedRefreshToken === null) {
      // The credential set is one unit: a refresh-token null while another
      // member is present is an unreadable credential read, never a
      // signed-out session. Only the server 401 below refuses.
      return {
        ok: false,
        refused: false,
        unreadable: true,
        presentKeys: await readPresentCredentialKeys(),
      };
    }

    // Bound the refresh network I/O at the control-plane deadline so a hung
    // backend can never leave the refresh (or a sign-out queueing behind its
    // credential write) waiting forever.
    const response = await withDeadline(CONTROL_PLANE_DEADLINE_MS, async signal => {
      const res = await fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: storedRefreshToken }),
        signal,
      });
      return res;
    });

    if (superseded()) {
      return { ok: false, refused: false, superseded: true };
    }

    if (!response.ok) {
      // Classify before deciding: a 401 is terminal (the stored pair is gone),
      // a 429/5xx is retryable and carries the server's own back-off, and any
      // other 4xx is terminal without a retry guidance to honour.
      const classified = classifyAuthResponse({
        path: REFRESH_PATH,
        status: response.status,
        retryAfterHeader: response.headers.get('retry-after'),
      });
      if (classified.kind === 'terminal') {
        if (classified.clearCredential) {
          await clearStoredCredentialsAtEpoch(sessionVersion);
        }
        reportAuthTerminalFailure(REFRESH_PATH, classified.status);
        return { ok: false, refused: true, sessionVersion };
      }
      if (classified.kind === 'retry') {
        return { ok: false, refused: false, retryAfterMs: classified.retryAfterMs };
      }
      // A 2xx that failed `response.ok` is impossible; fall through to the
      // retryable answer rather than inventing a fourth outcome.
      return { ok: false, refused: false };
    }

    const body: unknown = await response.json();
    const parsed = parseTokenPair(body);

    // A refresh response must include a full token pair with expiry.
    if (!parsed?.refreshToken || !parsed.expiresIn) {
      return { ok: false, refused: false };
    }

    if (superseded()) {
      return { ok: false, refused: false, superseded: true };
    }

    const published = await persistSignInCredentialsAtEpoch(parsed.token, parsed.refreshToken, {
      expiresIn: parsed.expiresIn,
      expectedEpoch: sessionVersion,
    });
    if (!published) {
      return { ok: false, refused: false, superseded: true };
    }

    return {
      ok: true,
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      expiresIn: parsed.expiresIn,
      sessionVersion,
    };
  } catch {
    return { ok: false, refused: false };
  }
}
