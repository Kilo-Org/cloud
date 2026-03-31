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

import { queryClient } from '@/lib/query-client';

export const CONTEXT_KEY = 'app-context';

// Pre-load context at module level so it's available before React mounts
const preloadedContext = SecureStore.getItemAsync(CONTEXT_KEY);

type AppContext =
  | {
      type: 'personal';
    }
  | {
      type: 'organization';
      organizationId: string;
    };

type ContextValue = {
  context: AppContext | undefined;
  isLoading: boolean;
  setContext: (ctx: AppContext) => Promise<void>;
  clearContext: () => Promise<void>;
};

const AppContextContext = createContext<ContextValue | undefined>(undefined);

export function ContextProvider({ children }: { readonly children: ReactNode }) {
  const [context, setContextState] = useState<AppContext | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await preloadedContext;
        if (stored) {
          setContextState(JSON.parse(stored) as AppContext);
        }
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const setContext = useCallback(async (ctx: AppContext) => {
    await SecureStore.setItemAsync(CONTEXT_KEY, JSON.stringify(ctx));
    setContextState(ctx);
  }, []);

  const clearContext = useCallback(async () => {
    await SecureStore.deleteItemAsync(CONTEXT_KEY);
    queryClient.clear();
    setContextState(undefined);
  }, []);

  const value = useMemo<ContextValue>(
    () => ({ context, isLoading, setContext, clearContext }),
    [context, isLoading, setContext, clearContext]
  );

  return <AppContextContext value={value}>{children}</AppContextContext>;
}

export function useAppContext(): ContextValue {
  const ctx = useContext(AppContextContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within a ContextProvider');
  }
  return ctx;
}
