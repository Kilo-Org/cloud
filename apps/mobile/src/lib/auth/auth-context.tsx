import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { trackEvent } from '@/lib/appsflyer';
import { queryClient } from '@/lib/query-client';
import {
  AUTH_TOKEN_KEY,
  NOTIFICATION_PROMPT_SEEN_KEY,
  ORGANIZATION_STORAGE_KEY,
  SESSION_FILTERS_KEY,
} from '@/lib/storage-keys';

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
    setToken(tokenValue);
  }, []);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    // Clear per-user preferences so they don't leak to the next signed-in account
    await SecureStore.deleteItemAsync(ORGANIZATION_STORAGE_KEY);
    await SecureStore.deleteItemAsync(SESSION_FILTERS_KEY);
    await SecureStore.deleteItemAsync(NOTIFICATION_PROMPT_SEEN_KEY);
    queryClient.clear();
    setToken(undefined);
  }, []);

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
