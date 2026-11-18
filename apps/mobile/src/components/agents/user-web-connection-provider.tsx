import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type UserWebConnection } from '@kilocode/cloud-agent-sdk';
// Use the narrow subpath: the barrel also loads web-only transport imports.
import { createUserWebConnection } from '@kilocode/cloud-agent-sdk/user-web-connection';

import { useAuth } from '@/lib/auth/auth-context';
import { getActiveToken } from '@/lib/auth/token-owner';
import { SESSION_INGEST_WS_URL } from '@/lib/config';
import {
  type AuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
  isCurrentOwner,
  subscribeAuthenticatedOwner,
} from '@/lib/context-scope';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { trpcClient } from '@/lib/trpc';

const UserWebConnectionContext = createContext<UserWebConnection | null>(null);

type IdentityConfirmation = {
  isPending: boolean;
  isError: boolean;
  retry: () => void;
};

const IdentityConfirmationContext = createContext<IdentityConfirmation | null>(null);

type UserWebConnectionProviderProps = {
  children: ReactNode;
};

export function UserWebConnectionProvider({ children }: Readonly<UserWebConnectionProviderProps>) {
  const { token, isLoading, isSigningOut, sessionEnded } = useAuth();
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  if (!token || isLoading || isSigningOut || sessionEnded || !isCurrentOwner(owner)) {
    return null;
  }
  return (
    <OwnedUserWebConnectionProvider key={`${owner.authEpoch}:${owner.generation}`} owner={owner}>
      {children}
    </OwnedUserWebConnectionProvider>
  );
}

type OwnedUserWebConnectionProviderProps = UserWebConnectionProviderProps & {
  owner: AuthenticatedOwner;
};

function OwnedUserWebConnectionProvider({
  children,
  owner,
}: Readonly<OwnedUserWebConnectionProviderProps>) {
  const captured = useRef(owner).current;
  const [confirmation, setConfirmation] = useState({
    isPending: captured.userId === null,
    isError: false,
  });
  const retryRef = useRef<(() => void) | null>(null);
  const nativeLifecycle = useMemo(() => createNativeUserWebConnectionLifecycleHooks(), []);
  const connectionRef = useRef<UserWebConnection | null>(null);
  connectionRef.current ??= createUserWebConnection({
    websocketUrl: `${SESSION_INGEST_WS_URL}/api/user/web`,
    getAuthToken: async () => {
      if (!isCurrentOwner(captured) || !getActiveToken()) {
        throw new Error('Authenticated owner changed');
      }
      if (getAuthenticatedOwner().userId === null) {
        setConfirmation(state => ({ ...state, isPending: true }));
        try {
          // Never confirm from a cached getMe result or a decoded bearer token.
          const user = await trpcClient.user.getMe.query();
          if (!confirmAuthenticatedOwner(captured, user.id)) {
            throw new Error('Authenticated owner changed');
          }
          setConfirmation({ isPending: false, isError: false });
        } catch (error) {
          if (isCurrentOwner(captured) && getAuthenticatedOwner().userId === null) {
            setConfirmation({ isPending: false, isError: true });
          }
          throw error;
        }
      }
      if (!isCurrentOwner(captured)) {
        throw new Error('Authenticated owner changed');
      }
      const result = await trpcClient.activeSessions.createWebTicket.mutate();
      if (!isCurrentOwner(captured)) {
        throw new Error('Authenticated owner changed');
      }
      return result.token;
    },
    lifecycleHooks: {
      ...nativeLifecycle,
      onOnline: retry => {
        // Reuse SDK recovery before a socket exists, including its backoff and single-flight guard.
        retryRef.current = retry;
        const unsubscribe = nativeLifecycle.onOnline?.(retry);
        return () => {
          retryRef.current = null;
          unsubscribe?.();
        };
      },
    },
  });
  const connection = connectionRef.current;
  const identityConfirmation = useMemo(
    () => ({
      ...confirmation,
      retry: () => {
        if (isCurrentOwner(captured) && getAuthenticatedOwner().userId === null) {
          retryRef.current?.();
        }
      },
    }),
    [captured, confirmation]
  );

  useEffect(() => {
    // Ownership revocation must win even while a session holds another retain.
    const retire = () => {
      if (!isCurrentOwner(captured)) {
        connection.destroy();
      }
    };
    const unsubscribe = subscribeAuthenticatedOwner(retire);
    retire();
    const release = connection.retain();
    return () => {
      unsubscribe();
      release();
      // Effect replay keeps a current connection reusable; account changes do not.
      retire();
    };
  }, [captured, connection]);

  return (
    <UserWebConnectionContext.Provider value={connection}>
      <IdentityConfirmationContext.Provider value={identityConfirmation}>
        {children}
      </IdentityConfirmationContext.Provider>
    </UserWebConnectionContext.Provider>
  );
}

export function useIdentityConfirmation(): IdentityConfirmation {
  const confirmation = useContext(IdentityConfirmationContext);
  if (!confirmation) {
    throw new Error('useIdentityConfirmation must be used within UserWebConnectionProvider');
  }
  return confirmation;
}

export function useUserWebConnection(): UserWebConnection {
  const connection = useContext(UserWebConnectionContext);
  if (!connection) {
    throw new Error('useUserWebConnection must be used within UserWebConnectionProvider');
  }
  return connection;
}
