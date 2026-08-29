import { createStore, Provider as JotaiProvider } from 'jotai';
import { createContext, useContext, useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import type { createTRPCClient } from '@trpc/client';
import { createBrowserLifecycleHooks, createUserWebConnection } from '@kilocode/cloud-agent-sdk';
import type { SessionManager } from '@kilocode/cloud-agent-sdk';
import type { MobileRouter } from '@kilocode/trpc/mobile';
import type { StoredAuth } from '@/src/shared/auth';
import { getKiloApiBaseUrl } from '@/src/shared/auth';
import { getSessionIngestWsUrl } from '@/src/shared/cloud-agent-config';
import { createExtensionTrpcClient } from '@/src/shared/extension-trpc-client';
import { createExtensionAgentSessionManager } from '@/src/shared/extension-agent-session-manager';
import { BrowserTaskProvider } from './browser-task-provider';

type TrpcClient = ReturnType<typeof createTRPCClient<MobileRouter>>;

export interface ExtensionAgentsContextValue {
  readonly manager: SessionManager;
  readonly userWebConnection: ReturnType<typeof createUserWebConnection>;
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

  // Refresh scope-bound resources without remounting BrowserTaskProvider or losing its disposal barrier.
  const ref = useRef<{
    auth: StoredAuth;
    context: ExtensionAgentsContextValue;
  } | null>(null);
  if (
    ref.current === null ||
    ref.current.auth.token !== auth.token ||
    ref.current.auth.userEmail !== auth.userEmail ||
    ref.current.context.organizationId !== organizationId
  ) {
    const store = createStore();
    const getToken = (): string | undefined => auth.token;

    const trpcClient = createExtensionTrpcClient({ apiBaseUrl, getToken });

    const userWebConnection = createUserWebConnection({
      browserProvider: true,
      getAuthToken: async () => {
        const tokenResult = await trpcClient.activeSessions.createWebTicket.mutate();
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

    ref.current = {
      auth,
      context: { manager, organizationId, store, trpcClient, userWebConnection },
    };
  }

  const { context } = ref.current;
  useEffect(() => context.userWebConnection.retain(), [context]);

  return (
    <ExtensionAgentsContext.Provider value={context}>
      <BrowserTaskProvider
        auth={auth}
        connection={context.userWebConnection}
        organizationId={organizationId ?? undefined}
      >
        {children}
      </BrowserTaskProvider>
    </ExtensionAgentsContext.Provider>
  );
};

/** Only Agents descendants use the manager's store. Browser producers use getDefaultStore(). */
export const ExtensionAgentsStore = ({ children }: { children: ReactNode }): JSX.Element => {
  const { store } = useExtensionAgents();
  return <JotaiProvider store={store}>{children}</JotaiProvider>;
};
