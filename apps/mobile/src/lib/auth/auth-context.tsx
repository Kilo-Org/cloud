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
import { queryClient } from '@/lib/query-client';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';
import { clearAgentModelPreference } from '@/lib/hooks/use-persisted-agent-model';
import { clearReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { clearLastActiveInstance } from '@/lib/last-active-instance';
import { resetPurchaseErrorToastDedup } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { clearRecentPrs } from '@/lib/pr-review/recent-prs';
import { clearViewedFiles } from '@/lib/pr-review/viewed-files';
import {
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
  signIn: (token: string, refreshToken?: string, expiresIn?: number) => Promise<void>;
  signOut: (ended?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Single-flight refresh lock. Only the first caller initiates the rotation;
// concurrent callers await the same promise.
let refreshPromise: Promise<RefreshOutcome> | null = null;
let refreshSessionVersion = 0;
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
  refreshSessionVersion += 1;
}

function isRefreshSessionCurrent(sessionVersion: number): boolean {
  return sessionVersion === refreshSessionVersion;
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

export async function persistSignInCredentials(
  token: string,
  refreshToken?: string,
  expiresIn?: number
): Promise<void> {
  await writeCredentials(async () => {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
    if (refreshToken && expiresIn) {
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
      await SecureStore.setItemAsync(TOKEN_EXPIRES_AT_KEY, String(Date.now() + expiresIn * 1000));
      return;
    }
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY);
  });
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
  const sessionVersion = refreshSessionVersion;
  try {
    const storedRefreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    if (!isRefreshSessionCurrent(sessionVersion)) {
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

    if (!isRefreshSessionCurrent(sessionVersion)) {
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

    return await writeCredentials(async () => {
      if (!isRefreshSessionCurrent(sessionVersion)) {
        return { ok: false, refused: false, superseded: true };
      }

      await SecureStore.setItemAsync(AUTH_TOKEN_KEY, parsed.token);
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, parsed.refreshToken);
      await SecureStore.setItemAsync(
        TOKEN_EXPIRES_AT_KEY,
        String(Date.now() + parsed.expiresIn * 1000)
      );

      return {
        ok: true,
        token: parsed.token,
        refreshToken: parsed.refreshToken,
        expiresIn: parsed.expiresIn,
        sessionVersion,
      };
    });
  } catch {
    return { ok: false, refused: false };
  }
}

export { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [token, setToken] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const isSignedOutReference = useRef(false);

  useEffect(() => {
    const load = async () => {
      try {
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
      await persistSignInCredentials(tokenValue, refreshTokenValue, expiresIn);
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
    // Synchronous gate close — must happen before any await so capture
    // is denied for the entire async teardown window.
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
    await SecureStore.deleteItemAsync(ORGANIZATION_STORAGE_KEY);
    await SecureStore.deleteItemAsync(SESSION_FILTERS_KEY);
    await SecureStore.deleteItemAsync(NOTIFICATION_PROMPT_SEEN_KEY);
    await clearLastActiveInstance();
    await clearRecentPrs();
    await clearViewedFiles();
    clearAgentModelPreference();
    clearReasoningPreference();
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

      if (outcome.ok && isRefreshSessionCurrent(outcome.sessionVersion)) {
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

      void (async () => {
        const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);
        if (!expiresAtStr) {
          return;
        }

        const expiresAt = Number(expiresAtStr);
        if (Date.now() <= expiresAt - REFRESH_MARGIN) {
          return;
        }

        const outcome = await performRefresh();

        if (outcome.ok && isRefreshSessionCurrent(outcome.sessionVersion)) {
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
    () => ({ token, isLoading, sessionEnded, signIn, signOut }),
    [token, isLoading, sessionEnded, signIn, signOut]
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
