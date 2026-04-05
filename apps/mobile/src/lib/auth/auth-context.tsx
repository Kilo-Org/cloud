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
import { CONTEXT_KEY } from '@/lib/context/context-context';
import { queryClient } from '@/lib/query-client';

const TOKEN_KEY = 'auth-token';

// Pre-load token at module level so it's available before React mounts
const preloadedToken = SecureStore.getItemAsync(TOKEN_KEY);

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
    await SecureStore.setItemAsync(TOKEN_KEY, tokenValue);
    trackEvent('login');
    setToken(tokenValue);
  }, []);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(CONTEXT_KEY);
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
