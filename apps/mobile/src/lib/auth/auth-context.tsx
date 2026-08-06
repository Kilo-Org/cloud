/* eslint-disable max-lines -- cohesive auth-context module: refresh rotation, epoch fencing, the serialized credential write queue, and provider teardown stay together */
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { discardPostHog } from '@/lib/analytics/posthog';
import { resetAppsFlyerState, trackEvent } from '@/lib/appsflyer';
import { API_BASE_URL } from '@/lib/config';
import { parseTokenPair } from '@/lib/auth/native-auth-contract';
import { deleteAccountMetadata } from '@/lib/auth/account-metadata-write';
import { queryClient } from '@/lib/query-client';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';
import { bumpAuthEpoch, currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { clearActiveToken, setActiveToken } from '@/lib/auth/token-owner';
import { clearAgentModelPreference } from '@/lib/hooks/use-persisted-agent-model';
import { clearKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { clearReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { clearKiloClawOwned, gateKiloClawOwned } from '@/lib/kiloclaw-tab-ownership';
import { clearLastActiveInstance } from '@/lib/last-active-instance';
import { resetPurchaseErrorToastDedup } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { clearCacheScopeForSignOut, readCachedUserId } from '@/lib/persist/read-cache';
import { clearRecentPrs } from '@/lib/pr-review/recent-prs';
import { clearViewedFiles } from '@/lib/pr-review/viewed-files';
import {
  ACTIVE_USER_ID_KEY,
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  NOTIFICATION_PROMPT_SEEN_KEY,
  ORGANIZATION_STORAGE_KEY,
  REFRESH_TOKEN_KEY,
  SESSION_FILTERS_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';
import { clearTelemetryDecision } from '@/lib/telemetry/controller';
import { purgePostHogPersistence } from '@/lib/telemetry/posthog-storage';
import { AppState } from 'react-native';

// Pre-load tokens at module level so they're available before React mounts
const preloadedToken = SecureStore.getItemAsync(AUTH_TOKEN_KEY);
const preloadedRefreshToken = SecureStore.getItemAsync(REFRESH_TOKEN_KEY);

type AuthContextValue = {
  token: string | undefined;
  isLoading: boolean;
  sessionEnded: boolean;
  /** Reactive snapshot of the auth epoch; bumps when sign-in or sign-out
   *  advances it, so subscribers (e.g. the read-cache mount) can resubscribe. */
  authEpoch: number;
  signIn: (token: string, refreshToken?: string, expiresIn?: number) => Promise<void>;
  signOut: (ended?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Single-flight refresh lock. Only the first caller initiates the rotation;
// concurrent callers await the same promise.
let refreshPromise: Promise<RefreshOutcome> | null = null;
let credentialWrite: Promise<void> = new Promise<void>(resolve => {
  resolve();
});

type RefreshSuccess = {
  ok: true;
  token: string;
  refreshToken: string;
  expiresIn: number;
  sessionVersion: number;
};
type RefreshRefused = { ok: false; refused: true; superseded?: false };
type RefreshTransient = { ok: false; refused: false; superseded?: false };
type RefreshSuperseded = { ok: false; refused: false; superseded: true };
export type RefreshOutcome = RefreshSuccess | RefreshRefused | RefreshTransient | RefreshSuperseded;

// Proactive refresh window: refresh when the token expires within 5 minutes.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function invalidateRefreshSession(): void {
  bumpAuthEpoch();
}

async function writeCredentials<T>(write: () => Promise<T>): Promise<T> {
  const previous = credentialWrite;
  let release = undefined as (() => void) | undefined;
  credentialWrite = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await write();
  } finally {
    release?.();
  }
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

export async function persistSignInCredentials(
  token: string,
  refreshToken?: string,
  expiresIn?: number
): Promise<boolean> {
  const published = await persistSignInCredentialsAtEpoch(token, refreshToken, { expiresIn });
  return published;
}

export async function persistSignInCredentialsAtEpoch(
  token: string,
  refreshToken: string | undefined,
  options: PersistCredentialsOptions
): Promise<boolean> {
  const epoch = options.expectedEpoch ?? currentAuthEpoch();
  const expiresIn = options.expiresIn;
  const expiresAtMs = refreshToken && expiresIn ? Date.now() + expiresIn * 1000 : null;
  const hasPair = Boolean(refreshToken && expiresIn);

  // Wipe every credential key a fenced write may already have committed.
  // Runs inside the serialized write queue, so it cannot remove the keys of
  // a newer sign-in or sign-out: their own credential write is queued
  // strictly behind this one.
  const clearPartialCredentials = async (): Promise<void> => {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY);
  };

  // Fence one credential operation: skip it when the epoch moved before the
  // op, and clear the partial pair when it moved during the op.
  const commitWrite = async (key: string, value?: string): Promise<boolean> => {
    if (!isCurrentAuthEpoch(epoch)) {
      return false;
    }
    await (value === undefined
      ? SecureStore.deleteItemAsync(key)
      : SecureStore.setItemAsync(key, value));
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

async function doRefresh(): Promise<RefreshOutcome> {
  const sessionVersion = currentAuthEpoch();
  try {
    const storedRefreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    if (!isCurrentAuthEpoch(sessionVersion)) {
      return { ok: false, refused: false, superseded: true };
    }
    if (!storedRefreshToken) {
      // No refresh token: cannot recover from this 401 — sign out.
      return { ok: false, refused: true };
    }

    const response = await fetch(`${API_BASE_URL}/api/auth/native/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: storedRefreshToken }),
    });

    if (!isCurrentAuthEpoch(sessionVersion)) {
      return { ok: false, refused: false, superseded: true };
    }

    // 401 means the refresh token is expired or revoked — permanent failure.
    if (response.status === 401) {
      return { ok: false, refused: true };
    }

    if (!response.ok) {
      return { ok: false, refused: false };
    }

    const body: unknown = await response.json();
    const parsed = parseTokenPair(body);

    // A refresh response must include a full token pair with expiry.
    if (!parsed?.refreshToken || !parsed.expiresIn) {
      return { ok: false, refused: false };
    }

    if (!isCurrentAuthEpoch(sessionVersion)) {
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

export { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [token, setToken] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  // Reactive snapshot of the module auth epoch, advanced synchronously at the
  // start of sign-in and sign-out so a subscriber can resubscribe on the bump.
  const [authEpoch, setAuthEpoch] = useState(() => currentAuthEpoch());
  const isSignedOutReference = useRef(false);

  useEffect(() => {
    const load = async () => {
      try {
        // Capture the epoch before any asynchronous read: every later check
        // fences against this moment, so a sign-out or newer sign-in during
        // bootstrap can never be followed by the preloaded token being
        // restored into React state or the token owner.
        const epoch = currentAuthEpoch();
        const stored = await preloadedToken;
        const storedRefresh = await preloadedRefreshToken;

        if (stored) {
          // Legacy exchange: if we have a token but no refresh token, upgrade once.
          if (!storedRefresh) {
            const pair = await exchangeLegacyToken();
            if (pair) {
              setToken(pair.token);
              setIsLoading(false);
              return;
            }
          }

          // The session moved while the preload or legacy exchange was in
          // flight: never resurrect the preloaded token.
          if (!isCurrentAuthEpoch(epoch)) {
            return;
          }

          const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);

          // Fence the asynchronous expiry read: publish only when the epoch
          // is still current and the stored credentials still match the
          // preloaded session. A refresh or sign-in that completed during the
          // reads already owns the session; the stale snapshot must not win.
          const currentStored = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
          if (!isCurrentAuthEpoch(epoch) || currentStored !== stored) {
            return;
          }
          setActiveToken(stored, expiresAtStr ? Number(expiresAtStr) : null);
          setToken(stored);
        }
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const signIn = useCallback(
    async (tokenValue: string, refreshTokenValue?: string, expiresIn?: number) => {
      invalidateRefreshSession();
      setAuthEpoch(currentAuthEpoch());
      const epoch = currentAuthEpoch();
      const published = await persistSignInCredentials(tokenValue, refreshTokenValue, expiresIn);
      // A sign-in superseded by a newer sign-in or sign-out while its
      // credential write was fenced must not clear the signed-out guard,
      // update React auth state, or run login side effects.
      if (!published || !isCurrentAuthEpoch(epoch)) {
        return;
      }
      // Clear the guard so a later refused refresh can sign out again.
      isSignedOutReference.current = false;
      setSessionEnded(false);
      trackEvent('login');
      resetPurchaseErrorToastDedup();
      setToken(tokenValue);
    },
    []
  );

  const signOut = useCallback(async (ended = false) => {
    isSignedOutReference.current = true;
    invalidateRefreshSession();
    setAuthEpoch(currentAuthEpoch());
    clearActiveToken();
    // Close ownership persistence before any await so a late list response
    // cannot write the previous account's answer during teardown.
    gateKiloClawOwned();
    clearTelemetryDecision();
    Sentry.setUser(null);
    // SDK teardown — drop queues, do not flush them. Must happen before
    // any SecureStore or cache awaits so optional analytics cannot transmit
    // during the teardown window.
    resetAppsFlyerState();
    await discardPostHog();
    purgePostHogPersistence();

    await writeCredentials(async () => {
      await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
      await SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY);
      await SecureStore.deleteItemAsync(LEGACY_EXCHANGE_DONE_KEY);
    });
    // Clear per-user preferences so they don't leak to the next signed-in account
    await deleteAccountMetadata(ORGANIZATION_STORAGE_KEY);
    await deleteAccountMetadata(SESSION_FILTERS_KEY);
    await deleteAccountMetadata(NOTIFICATION_PROMPT_SEEN_KEY);
    await deleteAccountMetadata(ACTIVE_USER_ID_KEY);
    await clearLastActiveInstance();
    await clearKiloClawOwned();
    await clearRecentPrs();
    await clearViewedFiles();
    clearAgentModelPreference();
    clearReasoningPreference();
    clearKeepScreenOnPreference();
    // Phase 4b read-cache cleanup: capture the authoritative user id from the
    // getMe cache before it is cleared, then remove that user's cache scope
    // (or every `cache:` scope when the id is unknown — privacy wins). Best
    // effort: a failed cleanup must never abort sign-out, so the query client
    // and auth state reset below always run.
    const knownUserId = readCachedUserId(queryClient);
    try {
      await clearCacheScopeForSignOut(knownUserId);
    } catch {
      // A stale blob only costs a future warm start.
    }
    queryClient.clear();
    setSessionEnded(ended);
    setToken(undefined);
  }, []);

  // Unauthorized handler: try refresh first, sign out only on a refused 401.
  // A transient failure (network error, 5xx) keeps the active token.
  // performRefresh handles concurrent callers via its own single-flight lock.
  useEffect(() => {
    const handler = async () => {
      const outcome = await performRefresh();

      if (outcome.ok && isCurrentAuthEpoch(outcome.sessionVersion)) {
        setToken(outcome.token);
        // Invalidate all queries so failed authenticated work recovers
        // with the new token. UNAUTHORIZED errors have retry=0, so a
        // concurrent 401 will not auto-refetch without explicit invalidation.
        void queryClient.invalidateQueries();
        return;
      }

      if (!outcome.ok && outcome.refused && !isSignedOutReference.current) {
        await signOut(true);
      }
    };

    return setTrpcUnauthorizedHandler(handler);
  }, [signOut]);

  const REFRESH_MARGIN = REFRESH_MARGIN_MS;

  // Proactive refresh: when the app returns to foreground and the token is
  // expiring within the margin, rotate before the next request hits a 401.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' || !token) {
        return;
      }

      // Capture the epoch that owns this foreground event. A sign-out or
      // newer sign-in that lands while the expiry read is in flight makes
      // the event stale: it must not refresh on the old session or publish
      // a token after sign-out.
      const epoch = currentAuthEpoch();

      void (async () => {
        const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);
        if (!expiresAtStr) {
          return;
        }

        const expiresAt = Number(expiresAtStr);
        if (Date.now() <= expiresAt - REFRESH_MARGIN) {
          return;
        }

        // The epoch moved while the expiry read was in flight: the event is
        // stale, so do not initiate a refresh for the old session.
        if (!isCurrentAuthEpoch(epoch)) {
          return;
        }

        const outcome = await performRefresh();

        if (outcome.ok && isCurrentAuthEpoch(outcome.sessionVersion)) {
          setToken(outcome.token);
        }
        // Transient or refused: do not sign out — the user did not trigger
        // an authenticated request. Let the next real 401 handle it.
      })();
    });
    return () => {
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- REFRESH_MARGIN_MS is module-level constant
  }, [token]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, isLoading, sessionEnded, authEpoch, signIn, signOut }),
    [token, isLoading, sessionEnded, authEpoch, signIn, signOut]
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
