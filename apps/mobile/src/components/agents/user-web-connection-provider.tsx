import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { type UserWebConnection } from 'cloud-agent-sdk';
// kilocode_change - K1/C2: `createUserWebConnection` must come from its
// narrow subpath, not the `cloud-agent-sdk` barrel. The barrel's index.ts
// also re-exports web-only transport code that imports a web-app `@/...`
// alias unresolved under the mobile app's own `@` alias — this previously
// went unnoticed because nothing under `apps/mobile` had a test that
// actually imported this provider (and thus the barrel) at runtime until
// the `kilo remote` spawn hook test did. See the matching
// vitest.config.ts aliases for the full explanation.
import { createUserWebConnection } from 'cloud-agent-sdk/user-web-connection';

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
