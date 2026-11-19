import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { classifyAuthResponse, reportAuthTerminalFailure } from '@/lib/auth/auth-response-class';
import { parseTokenPair } from '@/lib/auth/native-auth-contract';
import {
  readStoredValueRetryingNull,
  readStoredValueWithRetry,
} from '@/lib/auth/secure-store-read';
import { deleteStoredValue, writeStoredValue } from '@/lib/auth/secure-store-value';
import { isSignOutTeardownActive, setActiveToken } from '@/lib/auth/token-owner';
import { chainSave } from '@/lib/hooks/save-chain';
import { isProtectedDataAvailable } from '@/lib/protected-data';
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

/**
 * The answer to one refresh attempt, tagged by the one state it is in. A caller
 * switches on `kind`; no state is spelled as optional flags on another, so a
 * combination such as "refused and unreadable" cannot be constructed.
 */
type RefreshSuccess = {
  kind: 'ok';
  token: string;
  refreshToken: string;
  expiresIn: number;
  /** The session that asked. A handler publishes the pair only while this is
   *  still the current epoch: the epoch can move while the rotation awaits. */
  sessionVersion: number;
};
/** The server refused the stored pair: the session that owned it is over. */
type RefreshRefused = {
  kind: 'refused';
  /** The session that owned the refusal. A handler must drop the refusal when
   *  this is no longer the current epoch: the epoch can move while the clear
   *  awaits, and signing out then would tear down the newer session. */
  sessionVersion: number;
};
/** Anything that leaves the stored pair untouched and worth retrying later. */
type RefreshTransient = {
  kind: 'transient';
  /** The server's own back-off from a 429/503 `Retry-After`, when it sent one. */
  retryAfterMs?: number;
};
/** The session moved or sign-out began while the rotation awaited. */
type RefreshSuperseded = { kind: 'superseded' };
/**
 * The refresh-token read spent its whole budget on `null` and no member of the
 * credential set is present: there is no session to renew. Never a refusal —
 * a null member is not a signed-out session, so the caller must not sign out.
 */
type RefreshUnreadable = { kind: 'unreadable' };
/**
 * The credential set holds a member but no refresh token, and the read that
 * found this was reliable (the device was unlocked, so the null is an absence,
 * not a refused read): the set can never rotate. Once the server refuses the
 * token nothing can renew it, so the caller ends the session — once — instead
 * of retrying a rotation that has no credential to present.
 */
type RefreshUnrenewable = {
  kind: 'unrenewable';
  /** The session that owned the read. A handler drops this outcome once the
   *  epoch has moved: the set it describes no longer belongs to the person. */
  sessionVersion: number;
};
export type RefreshOutcome =
  | RefreshSuccess
  | RefreshRefused
  | RefreshTransient
  | RefreshSuperseded
  | RefreshUnreadable
  | RefreshUnrenewable;

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
    await deleteStoredValue(AUTH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
    await deleteStoredValue(REFRESH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
    await deleteStoredValue(TOKEN_EXPIRES_AT_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
  };

  // Whether any credential key of this attempt reached the keychain. A later
  // rejection then knows the store may hold a partial set and wipes it; a
  // failure on the very first operation leaves the previous session untouched,
  // so a transient keychain failure stays retryable instead of signing out.
  let committedAny = false;

  // Fence one credential operation: skip it when the epoch moved before the
  // op, and clear the partial pair when it moved during the op.
  const commitWrite = async (key: string, value?: string): Promise<boolean> => {
    if (!isCurrentAuthEpoch(epoch)) {
      return false;
    }
    // A keychain write/delete that rejects is reported at warning level with
    // the stable operation fingerprint and then propagates, so sign-in lands
    // on its persist-error state instead of publishing a half-written pair.
    await (value === undefined
      ? deleteStoredValue(key, IOS_BEARER_SECURE_STORE_OPTIONS)
      : writeStoredValue(key, value, IOS_BEARER_SECURE_STORE_OPTIONS));
    committedAny = true;
    if (!isCurrentAuthEpoch(epoch)) {
      await clearPartialCredentials();
      return false;
    }
    return true;
  };

  let published = false;
  await writeCredentials(async () => {
    try {
      if (!(await commitWrite(AUTH_TOKEN_KEY, token))) {
        return;
      }
      if (!(await commitWrite(REFRESH_TOKEN_KEY, hasPair ? refreshToken : undefined))) {
        return;
      }
      if (!(await commitWrite(TOKEN_EXPIRES_AT_KEY, hasPair ? String(expiresAtMs) : undefined))) {
        return;
      }
    } catch (error) {
      // A later keychain operation rejected after an earlier one committed:
      // the store now holds a partial credential set. Wipe it best-effort in
      // the same serialized slot — so it cannot touch a newer sign-in's keys —
      // then rethrow the original failure. A cleanup failure is swallowed so
      // it cannot mask the write failure the caller owns.
      if (committedAny) {
        try {
          await clearPartialCredentials();
        } catch {
          // Best effort: the caller must still see the original failure.
        }
      }
      throw error;
    }
    // Every fenced operation passed its post-check and nothing awaited since
    // the last one, so the epoch is still current: publish to the owner.
    setActiveToken(token, expiresAtMs);
    published = true;
  });
  return published;
}

export async function performRefresh(): Promise<RefreshOutcome> {
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
 * Whether the stored credential set still holds a member after the refresh-token
 * read answered `null`. The token and the expiry are read as one unit so a
 * session is never called absent because one member could not be read. Both
 * reads are best-effort: the null already settled the outcome, so a rejection
 * here cannot change it.
 *
 * Only the store counts. The in-memory owner outlives a 401's credential clear
 * on purpose — sign-out's remote cleanup still reads it — so counting it would
 * make a set the clear already emptied look unrenewable.
 */
async function hasStoredCredentialMember(): Promise<boolean> {
  const [storedAuthToken, storedExpiresAt] = await Promise.allSettled([
    readStoredValueWithRetry(AUTH_TOKEN_KEY),
    readStoredValueWithRetry(TOKEN_EXPIRES_AT_KEY),
  ]);
  return (
    (storedAuthToken.status === 'fulfilled' && storedAuthToken.value !== null) ||
    (storedExpiresAt.status === 'fulfilled' && storedExpiresAt.value !== null)
  );
}

/**
 * The most of a 403 body the refresh route's own refusal can occupy. The route
 * writes one short JSON object; a longer body is an intermediary's page, and no
 * prefix of it can name the route's refusal.
 */
const REFUSAL_BODY_MAX_CHARS = 1_024;

/**
 * The first {@link REFUSAL_BODY_MAX_CHARS} of a 403 body, read inside the
 * deadline that bounds the refresh. A body that stalls after its headers cannot
 * hold the single-flight refresh open, and nothing past the cap can be the
 * route's own short refusal. An unreadable body answers `null`.
 */
async function readRefusalText(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.slice(0, REFUSAL_BODY_MAX_CHARS);
  } catch {
    return null;
  }
}

/** The refresh response bodies, read under the deadline that bounds the call. */
type RefreshResponseBodies = {
  response: Response;
  /** The capped 403 body text; null for every other status and an unreadable body. */
  refusalText: string | null;
  /** The parsed 2xx body; undefined while the status is a failure. */
  successBody: unknown;
};

async function doRefresh(): Promise<RefreshOutcome> {
  const sessionVersion = currentAuthEpoch();
  // A refresh is superseded when the session moved or sign-out teardown
  // began: it must then neither read the old refresh token nor publish a new
  // credential pair, so the auth-transition queue never waits on a stale
  // rotation during the teardown gap.
  const superseded = (): boolean =>
    !isCurrentAuthEpoch(sessionVersion) || isSignOutTeardownActive();
  if (superseded()) {
    return { kind: 'superseded' };
  }
  try {
    let storedRefreshToken = await readStoredValueWithRetry(REFRESH_TOKEN_KEY);
    if (superseded()) {
      return { kind: 'superseded' };
    }
    if (storedRefreshToken === null) {
      // A null is not proof of an absent session: a keychain item written
      // WHEN_UNLOCKED_THIS_DEVICE_ONLY answers null while the device is not
      // yet unlocked. Retry the null exactly like a rejection before
      // concluding the credential set cannot refresh.
      storedRefreshToken = await readStoredValueRetryingNull(REFRESH_TOKEN_KEY);
      if (superseded()) {
        return { kind: 'superseded' };
      }
    }
    if (storedRefreshToken === null && !isProtectedDataAvailable()) {
      // The device locked during the reads: the null is a refused read, not an
      // unreadable credential set. Retry later; never raise the restore error.
      return { kind: 'transient' };
    }
    if (storedRefreshToken === null) {
      // The credential set is one unit: a refresh-token absence is never a
      // signed-out session on its own. Which of the two it is depends on what
      // the rest of the set holds, and only a present member owes the person
      // an end to the session instead of a retry.
      if (await hasStoredCredentialMember()) {
        // A token-only set (the legacy long-lived sign-in, or an interrupted
        // legacy exchange) can never rotate. The device was unlocked, so this
        // null is a real absence: the rotation is unrenewable, and the caller
        // ends the session once rather than retrying forever.
        return { kind: 'unrenewable', sessionVersion };
      }
      return { kind: 'unreadable' };
    }

    // Bound the refresh network I/O at the control-plane deadline so a hung
    // backend can never leave the refresh (or a sign-out queueing behind its
    // credential write) waiting forever. Both bodies are read inside that
    // deadline: a body that stalls after its headers would otherwise leave the
    // single-flight refresh pending and block every later refresh.
    const { response, refusalText, successBody } = await withDeadline(
      CONTROL_PLANE_DEADLINE_MS,
      async (signal): Promise<RefreshResponseBodies> => {
        const res = await fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: storedRefreshToken }),
          signal,
        });
        // A 403 needs its body read: the refresh route has no 403 branch, so
        // the body is what tells its own refusal apart from an intermediary's
        // (an edge firewall, a WAF, a proxy) refusal, which proves nothing
        // about the stored pair. Every other failure status is classified on
        // the status alone, and a 2xx body must be read whole to parse.
        if (!res.ok) {
          return {
            response: res,
            refusalText: res.status === 403 ? await readRefusalText(res) : null,
            successBody: undefined,
          };
        }
        const body: unknown = await res.json();
        return { response: res, refusalText: null, successBody: body };
      }
    );

    if (superseded()) {
      return { kind: 'superseded' };
    }

    if (!response.ok) {
      // Only a 403 body can name the route's own refusal, so only that one is
      // parsed: a body that is not JSON — empty, an intermediary's page — offers
      // the classifier no refusal, which keeps the 403 retryable.
      let refusalBody: unknown = undefined;
      try {
        refusalBody = JSON.parse(refusalText ?? '');
      } catch {
        refusalBody = undefined;
      }
      // Classify before deciding: a 401 is terminal (the stored pair is gone),
      // a 429/5xx is retryable and carries the server's own back-off, and any
      // other 4xx is terminal without a retry guidance to honour.
      const classified = classifyAuthResponse({
        path: REFRESH_PATH,
        status: response.status,
        retryAfterHeader: response.headers.get('retry-after'),
        body: refusalBody,
      });
      if (classified.kind === 'terminal') {
        if (classified.clearCredential) {
          await clearStoredCredentialsAtEpoch(sessionVersion);
        }
        reportAuthTerminalFailure(REFRESH_PATH, classified.status);
        return { kind: 'refused', sessionVersion };
      }
      if (classified.kind === 'retry') {
        return { kind: 'transient', retryAfterMs: classified.retryAfterMs };
      }
      // A 2xx that failed `response.ok` is impossible; fall through to the
      // retryable state rather than inventing a seventh one.
      return { kind: 'transient' };
    }

    const parsed = parseTokenPair(successBody);

    if (!parsed?.refreshToken || !parsed.expiresIn) {
      return { kind: 'transient' };
    }

    if (superseded()) {
      return { kind: 'superseded' };
    }

    const published = await persistSignInCredentialsAtEpoch(parsed.token, parsed.refreshToken, {
      expiresIn: parsed.expiresIn,
      expectedEpoch: sessionVersion,
    });
    if (!published) {
      return { kind: 'superseded' };
    }

    return {
      kind: 'ok',
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      expiresIn: parsed.expiresIn,
      sessionVersion,
    };
  } catch {
    return { kind: 'transient' };
  }
}
