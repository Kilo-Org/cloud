import { createContext, type ReactNode, useContext, useRef } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { type SessionManager } from '@kilocode/cloud-agent-sdk';
import { createMobileAgentSessionManager } from '@/components/agents/mobile-session-manager';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { useOwnedResource } from '@/lib/hooks/use-owned-resource';

const ManagerContext = createContext<SessionManager | null>(null);

type AgentSessionProviderProps = {
  children: ReactNode;
  organizationId?: string;
};

export function AgentSessionProvider({
  children,
  organizationId,
}: Readonly<AgentSessionProviderProps>) {
  const userWebConnection = useUserWebConnection();
  const storeRef = useRef(createStore());
  const manager = useOwnedResource(
    () =>
      createMobileAgentSessionManager({
        store: storeRef.current,
        userWebConnection,
        organizationId,
      }),
    instance => {
      instance.destroy();
    }
  );

  return (
    <JotaiProvider store={storeRef.current}>
      <ManagerContext.Provider value={manager}>{children}</ManagerContext.Provider>
    </JotaiProvider>
  );
}

export function useSessionManager(): SessionManager {
  const manager = useContext(ManagerContext);
  if (!manager) {
    throw new Error('useSessionManager must be used within AgentSessionProvider');
  }
  return manager;
}
