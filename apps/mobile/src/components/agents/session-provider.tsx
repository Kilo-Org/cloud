import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { type SessionManager } from '@kilocode/cloud-agent-sdk';
import { createMobileAgentSessionManager } from '@/components/agents/mobile-session-manager';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import {
  getAuthenticatedOwner,
  isAuthenticatedOwner,
  subscribeAuthenticatedOwner,
} from '@/lib/context-scope';

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
  const managerRef = useRef<SessionManager | null>(null);
  // Capture the owner before the manager is created so its transcript cache is
  // scoped to this account. The route keys the provider on the owner, so a new
  // account gets a new manager; the provider only renders for a confirmed
  // owner, and `?? ''` makes the manager skip the cache if it ever is not.
  const owner = useRef(getAuthenticatedOwner()).current;
  managerRef.current ??= createMobileAgentSessionManager({
    store: storeRef.current,
    userWebConnection,
    organizationId,
    userId: owner.userId ?? '',
  });

  useEffect(() => {
    const manager = managerRef.current;
    const retire = () => {
      if (!isAuthenticatedOwner(owner)) {
        manager?.destroy();
      }
    };
    const unsubscribe = subscribeAuthenticatedOwner(retire);
    retire();
    return () => {
      unsubscribe();
      manager?.destroy();
    };
  }, [owner]);

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
