import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { KiloChatHooksProvider } from '@kilocode/kilo-chat-hooks';

import { EVENT_SERVICE_URL, KILO_CHAT_URL } from '@/lib/config';

import {
  clearKiloChatTokenCache,
  subscribeToKiloChatTokenResponses,
  useKiloChatTokenGetter,
  useKiloChatTokenResponseGetter,
} from './hooks/use-kilo-chat-token';

type KiloChatProviderProps = {
  children: React.ReactNode;
};

export const KiloChatCurrentUserContext = createContext<string | null>(null);

type KiloChatTokenErrorState = {
  hasError: boolean;
  retry: () => void;
};

const KiloChatTokenErrorContext = createContext<KiloChatTokenErrorState | undefined>(undefined);

/** Whether the initial kilo-chat token fetch failed, plus a way to retry it. */
export function useKiloChatTokenError(): KiloChatTokenErrorState {
  const context = useContext(KiloChatTokenErrorContext);
  if (!context) {
    throw new Error('useKiloChatTokenError must be used within a KiloChatProvider');
  }
  return context;
}

export function KiloChatProvider({ children }: KiloChatProviderProps) {
  const getToken = useKiloChatTokenGetter();
  const getTokenResponse = useKiloChatTokenResponseGetter();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const [value] = useState(() => {
    const eventService = new EventServiceClient({
      url: EVENT_SERVICE_URL,
      getToken,
      onUnauthorized: () => {
        clearKiloChatTokenCache();
        return 'retry';
      },
    });
    const kiloChatClient = new KiloChatClient({
      eventService,
      baseUrl: KILO_CHAT_URL,
      getToken,
      onUnauthorized: () => {
        clearKiloChatTokenCache();
        return 'retry';
      },
    });
    return { eventService, kiloChatClient };
  });

  useEffect(() => {
    void value.eventService.connect();
    return () => {
      value.eventService.disconnect();
    };
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeToKiloChatTokenResponses(response => {
      if (!cancelled) {
        setCurrentUserId(response.userId);
        setTokenError(false);
      }
    });

    async function resolveCurrentUserId() {
      try {
        const response = await getTokenResponse();
        if (!cancelled) {
          setCurrentUserId(response.userId);
          setTokenError(false);
        }
      } catch {
        // Surface the failure instead of swallowing it — the composer would
        // otherwise stay stuck behind "Loading user..." with no way out.
        if (!cancelled) {
          setTokenError(true);
        }
      }
    }

    void resolveCurrentUserId();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [getTokenResponse, retryCount]);

  const retryTokenFetch = useCallback(() => {
    setTokenError(false);
    setRetryCount(count => count + 1);
  }, []);
  const tokenErrorValue = useMemo(
    () => ({ hasError: tokenError, retry: retryTokenFetch }),
    [tokenError, retryTokenFetch]
  );

  return (
    <KiloChatCurrentUserContext.Provider value={currentUserId}>
      <KiloChatTokenErrorContext.Provider value={tokenErrorValue}>
        <KiloChatHooksProvider
          value={{ kiloChatClient: value.kiloChatClient, eventService: value.eventService }}
        >
          {children}
        </KiloChatHooksProvider>
      </KiloChatTokenErrorContext.Provider>
    </KiloChatCurrentUserContext.Provider>
  );
}
