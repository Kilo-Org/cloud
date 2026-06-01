import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { createUserWebConnection, type UserWebConnection } from 'cloud-agent-sdk';

import { SESSION_INGEST_WS_URL } from '@/lib/config';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { trpcClient } from '@/lib/trpc';

const UserWebConnectionContext = createContext<UserWebConnection | null>(null);

type UserWebConnectionProviderProps = {
  children: ReactNode;
};

export function UserWebConnectionProvider({ children }: Readonly<UserWebConnectionProviderProps>) {
  const connectionRef = useRef<UserWebConnection | null>(null);
  connectionRef.current ??= createUserWebConnection({
    websocketUrl: `${SESSION_INGEST_WS_URL}/api/user/web`,
    getAuthToken: async () => {
      const result = await trpcClient.activeSessions.getToken.query();
      return result.token;
    },
    lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
  });

  useEffect(() => {
    const connection = connectionRef.current;
    return () => {
      connection?.destroy();
    };
  }, []);

  return (
    <UserWebConnectionContext.Provider value={connectionRef.current}>
      {children}
    </UserWebConnectionContext.Provider>
  );
}

export function useUserWebConnection(): UserWebConnection {
  const connection = useContext(UserWebConnectionContext);
  if (!connection) {
    throw new Error('useUserWebConnection must be used within UserWebConnectionProvider');
  }
  return connection;
}
