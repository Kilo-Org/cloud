import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { type SessionManager } from 'cloud-agent-sdk';
import { createMobileAgentSessionManager } from '@/components/agents/mobile-session-manager';

const ManagerContext = createContext<SessionManager | null>(null);

type AgentSessionProviderProps = {
  children: ReactNode;
  organizationId?: string;
};

export function AgentSessionProvider({
  children,
  organizationId,
}: Readonly<AgentSessionProviderProps>) {
  const storeRef = useRef(createStore());
  const managerRef = useRef<SessionManager | null>(null);
  managerRef.current ??= createMobileAgentSessionManager({
    store: storeRef.current,
    organizationId,
  });

  useEffect(() => {
    const manager = managerRef.current;
    return () => {
      manager?.destroy();
    };
  }, []);

  return (
    <JotaiProvider store={storeRef.current}>
      <ManagerContext.Provider value={managerRef.current}>{children}</ManagerContext.Provider>
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
