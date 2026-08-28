import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { EventServiceClient } from '@kilocode/event-service';
import {
  KiloChatClient,
  type KiloChatClientConfig,
  type KiloChatOperation,
} from '@kilocode/kilo-chat';
import { KiloChatHooksProvider } from '@kilocode/kilo-chat-hooks';

import { EVENT_SERVICE_URL, KILO_CHAT_URL } from '@/lib/config';
import {
  type AuthenticatedOwner,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
  subscribeAuthenticatedOwner,
} from '@/lib/context-scope';
import { LocalAccessDeniedError } from '@/lib/local-access';
import {
  assertMobileActionAdmission,
  captureMobileActionAdmission,
} from '@/lib/local-access-transport';

import { useAppActiveAndFocused } from './hooks/use-app-active-and-focused';
import {
  clearKiloChatTokenCache,
  subscribeToKiloChatTokenResponses,
  useKiloChatTokenResponseGetter,
} from './hooks/use-kilo-chat-token';

type KiloChatProviderProps = { children: React.ReactNode };
export const KiloChatCurrentUserContext = createContext<string | null>(null);
type KiloChatTokenErrorState = { hasError: boolean; retry: () => void };
const KiloChatTokenErrorContext = createContext<KiloChatTokenErrorState | undefined>(undefined);

export function useKiloChatTokenError(): KiloChatTokenErrorState {
  const context = useContext(KiloChatTokenErrorContext);
  if (!context) {
    throw new Error('useKiloChatTokenError must be used within a KiloChatProvider');
  }
  return context;
}

type MobileKiloChatConfig = Pick<KiloChatClientConfig, 'getToken'> &
  Required<Pick<KiloChatClientConfig, 'captureOperationAdmission' | 'canPublish'>>;

/** Mobile requires both guards; the shared constructors retain their old optional form. */
export function createMobileKiloChatClients(config: MobileKiloChatConfig) {
  let disposed = false;
  let holding = false;
  const canPublish = () => !disposed && config.canPublish();
  const assertOwner = () => {
    if (!canPublish()) {
      throw new LocalAccessDeniedError('owner');
    }
  };
  const getToken = async () => {
    assertOwner();
    const token = await config.getToken();
    assertOwner();
    return token;
  };
  const onUnauthorized = () => {
    if (!canPublish()) {
      return 'stop' as const;
    }
    clearKiloChatTokenCache();
    return 'retry' as const;
  };
  const eventService = new EventServiceClient({ url: EVENT_SERVICE_URL, getToken, onUnauthorized });
  // Guard the existing instance, including callbacks already queued before release.
  // Do not change EventServiceClient behavior for web or other package consumers.
  function whenCurrent<T extends unknown[]>(handler: (...args: T) => void) {
    return (...args: T) => {
      if (canPublish()) {
        handler(...args);
      }
    };
  }
  const on = eventService.on.bind(eventService);
  const onConnected = eventService.onConnected.bind(eventService);
  const onReconnect = eventService.onReconnect.bind(eventService);
  const onResync = eventService.onResync.bind(eventService);
  const subscribe = eventService.subscribe.bind(eventService);
  const isConnected = eventService.isConnected.bind(eventService);
  eventService.on = (event, handler) => on(event, whenCurrent(handler));
  eventService.onConnected = handler => onConnected(whenCurrent(handler));
  eventService.onReconnect = handler => onReconnect(whenCurrent(handler));
  eventService.onResync = handler => onResync(whenCurrent(handler));
  eventService.subscribe = contexts => {
    if (canPublish()) {
      subscribe(contexts);
    }
  };
  eventService.isConnected = () => canPublish() && isConnected();
  const kiloChatClient = new KiloChatClient({
    eventService,
    baseUrl: KILO_CHAT_URL,
    getToken,
    onUnauthorized,
    canPublish,
    captureOperationAdmission: config.captureOperationAdmission,
  });
  function setActive(active: boolean) {
    if (active && canPublish() && !holding) {
      holding = true;
      void eventService.acquire();
    } else if (!active && holding) {
      holding = false;
      eventService.release();
    }
  }
  function dispose() {
    disposed = true;
    kiloChatClient.dispose();
    setActive(false);
  }
  return { eventService, kiloChatClient, setActive, dispose };
}

export function KiloChatProvider({ children }: KiloChatProviderProps) {
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  return (
    <OwnedKiloChatProvider
      key={`${owner.authEpoch}:${owner.generation}:${owner.userId ?? ''}`}
      owner={owner}
    >
      {children}
    </OwnedKiloChatProvider>
  );
}

function OwnedKiloChatProvider({
  children,
  owner,
}: KiloChatProviderProps & { owner: AuthenticatedOwner }) {
  const getTokenResponse = useKiloChatTokenResponseGetter(owner);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState(false);
  const activeAndFocused = useAppActiveAndFocused();
  const createClients = useCallback(
    () =>
      createMobileKiloChatClients({
        getToken: async () => {
          const response = await getTokenResponse();
          return response.token;
        },
        canPublish: () => isAuthenticatedOwner(owner),
        captureOperationAdmission: () => {
          const admission = captureMobileActionAdmission(owner, null);
          return () => {
            assertMobileActionAdmission(admission);
          };
        },
      }),
    [getTokenResponse, owner]
  );
  const [value, setValue] = useState(createClients);

  useEffect(() => {
    // Effect replay must create a fresh pair, never revive a disposed queue.
    if (isAuthenticatedOwner(owner) && !value.kiloChatClient.canPublish()) {
      setValue(createClients());
      return undefined;
    }
    const unsubscribe = subscribeAuthenticatedOwner(() => {
      if (!isAuthenticatedOwner(owner)) {
        value.dispose();
      }
    });
    return () => {
      unsubscribe();
      value.dispose();
    };
  }, [createClients, owner, value]);

  useEffect(() => {
    value.setActive(activeAndFocused);
    return () => {
      value.setActive(false);
    };
  }, [value, activeAndFocused]);

  const resolveCurrentUserId = useCallback(
    async (operation?: KiloChatOperation) => {
      try {
        const response = await getTokenResponse(operation?.assertDispatch);
        if (value.kiloChatClient.canPublish()) {
          setCurrentUserId(response.userId);
          setTokenError(false);
        }
      } catch {
        if (value.kiloChatClient.canPublish()) {
          setTokenError(true);
        }
      }
    },
    [getTokenResponse, value]
  );

  useEffect(() => {
    const unsubscribe = subscribeToKiloChatTokenResponses((response, responseOwner) => {
      if (
        value.kiloChatClient.canPublish() &&
        responseOwner.authEpoch === owner.authEpoch &&
        responseOwner.generation === owner.generation &&
        response.userId === owner.userId
      ) {
        setCurrentUserId(response.userId);
        setTokenError(false);
      }
    });
    if (owner.userId !== null) {
      void resolveCurrentUserId();
    }
    return unsubscribe;
  }, [owner, resolveCurrentUserId, value]);

  const retryTokenFetch = useCallback(() => {
    try {
      const operation = value.kiloChatClient.captureOperation();
      setTokenError(false);
      void resolveCurrentUserId(operation);
    } catch {
      // The existing token error stays available; unlock does not retry this action.
    }
  }, [resolveCurrentUserId, value]);
  const tokenErrorValue = useMemo(
    () => ({ hasError: tokenError, retry: retryTokenFetch }),
    [tokenError, retryTokenFetch]
  );
  return (
    <KiloChatCurrentUserContext.Provider value={currentUserId}>
      <KiloChatTokenErrorContext.Provider value={tokenErrorValue}>
        <KiloChatHooksProvider value={value}>{children}</KiloChatHooksProvider>
      </KiloChatTokenErrorContext.Provider>
    </KiloChatCurrentUserContext.Provider>
  );
}
