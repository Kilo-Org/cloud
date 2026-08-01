import { createStore, Provider as JotaiProvider } from 'jotai';
import { createContext, useContext, useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import type { createTRPCClient } from '@trpc/client';
import { createBrowserLifecycleHooks, createUserWebConnection } from '@kilocode/cloud-agent-sdk';
import type { SessionManager, UserWebConnection } from '@kilocode/cloud-agent-sdk';
import type { MobileRouter } from '@kilocode/trpc/mobile';
import type { StoredAuth } from '@/src/shared/auth';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import { getSessionIngestWsUrl } from '@/src/shared/cloud-agent-config';
import { createExtensionTrpcClient } from '@/src/shared/extension-trpc-client';
import { createExtensionAgentSessionManager } from '@/src/shared/extension-agent-session-manager';

type TrpcClient = ReturnType<typeof createTRPCClient<MobileRouter>>;

export interface ExtensionAgentsContextValue {
  readonly manager: SessionManager;
  readonly userWebConnection: UserWebConnection;
  readonly store: ReturnType<typeof createStore>;
  readonly trpcClient: TrpcClient;
  readonly organizationId: string | null;
}

const ExtensionAgentsContext = createContext<ExtensionAgentsContextValue | null>(null);

export const useExtensionAgents = (): ExtensionAgentsContextValue => {
  const value = useContext(ExtensionAgentsContext);
  if (value === null) {
    throw new Error('useExtensionAgents must be used within an ExtensionAgentsProvider');
  }
  return value;
};

export const ExtensionAgentsProvider = ({
  auth,
  children,
  organizationId,
}: {
  auth: StoredAuth;
  children: ReactNode;
  organizationId: string | null;
}): JSX.Element => {
  const apiBaseUrl = getKiloApiBaseUrl();
  const sessionIngestWsUrl = getSessionIngestWsUrl();

  // Create-once via lazy useRef — matching web's CloudAgentProvider pattern.
  const ref = useRef<ExtensionAgentsContextValue | null>(null);
  if (ref.current === null) {
    const store = createStore();
    const getToken = (): string | undefined => auth.token;

    const trpcClient = createExtensionTrpcClient({ apiBaseUrl, getToken });

    const userWebConnection = createUserWebConnection({
      getAuthToken: async () => {
        const tokenResult = await trpcClient.activeSessions.getToken.query();
        return tokenResult.token;
      },
      lifecycleHooks: createBrowserLifecycleHooks(),
      websocketUrl: `${sessionIngestWsUrl}/api/user/web`,
    });

    const manager = createExtensionAgentSessionManager({
      apiBaseUrl,
      getToken,
      organizationId,
      store,
      trpcClient,
      userWebConnection,
    });

    ref.current = { manager, organizationId, store, trpcClient, userWebConnection };
  }

  useEffect(() => {
    const { userWebConnection: uwc } = ref.current!;
    const release = uwc.retain();
    return release;
  }, []);

  return (
    <JotaiProvider store={ref.current.store}>
      <ExtensionAgentsContext.Provider value={ref.current}>
        {children}
      </ExtensionAgentsContext.Provider>
    </JotaiProvider>
  );
};
