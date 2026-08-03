import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { discardPostHog } from '@/lib/analytics/posthog';
import { resetAppsFlyerState, trackEvent } from '@/lib/appsflyer';
import { queryClient } from '@/lib/query-client';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { clearAgentModelPreference } from '@/lib/hooks/use-persisted-agent-model';
import { clearReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { clearLastActiveInstance } from '@/lib/last-active-instance';
import { resetPurchaseErrorToastDedup } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { clearRecentPrs } from '@/lib/pr-review/recent-prs';
import { clearViewedFiles } from '@/lib/pr-review/viewed-files';
import {
  AUTH_TOKEN_KEY,
  NOTIFICATION_PROMPT_SEEN_KEY,
  ORGANIZATION_STORAGE_KEY,
  SESSION_FILTERS_KEY,
} from '@/lib/storage-keys';
import { clearTelemetryDecision } from '@/lib/telemetry/controller';
import { purgePostHogPersistence } from '@/lib/telemetry/posthog-storage';

// Pre-load token at module level so it's available before React mounts
const preloadedToken = SecureStore.getItemAsync(AUTH_TOKEN_KEY);

type AuthContextValue = {
  token: string | undefined;
  isLoading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [token, setToken] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await preloadedToken;
        setToken(stored ?? undefined);
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const signIn = useCallback(async (tokenValue: string) => {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, tokenValue);
    trackEvent('login');
    resetPurchaseErrorToastDedup();
    setToken(tokenValue);
  }, []);

  const signOut = useCallback(async () => {
    // Synchronous gate close — must happen before any await so capture
    // is denied for the entire async teardown window.
    clearTelemetryDecision();
    Sentry.setUser(null);

    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    // Clear per-user preferences so they don't leak to the next signed-in account
    await SecureStore.deleteItemAsync(ORGANIZATION_STORAGE_KEY);
    await SecureStore.deleteItemAsync(SESSION_FILTERS_KEY);
    await SecureStore.deleteItemAsync(NOTIFICATION_PROMPT_SEEN_KEY);
    await clearLastActiveInstance();
    await clearRecentPrs();
    await clearViewedFiles();
    clearAgentModelPreference();
    clearReasoningPreference();
    // SDK teardown — drop queues, do not flush them.
    resetAppsFlyerState();
    await discardPostHog();
    purgePostHogPersistence();
    queryClient.clear();
    setToken(undefined);
  }, []);

  useEffect(() => setTrpcUnauthorizedHandler(signOut), [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, isLoading, signIn, signOut }),
    [token, isLoading, signIn, signOut]
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
