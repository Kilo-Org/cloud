import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { type SessionManager } from '@kilocode/cloud-agent-sdk';
import { useLocalSearchParams } from 'expo-router';
import { createMobileAgentSessionManager } from '@/components/agents/mobile-session-manager';
import {
  registerLiveSessionManager,
  unregisterLiveSessionManager,
} from '@/components/agents/live-session-manager-registry';
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
  // The route keys the provider on the owner, so a new account gets a new
  // manager. The owner snapshot also fences the retire effect below.
  const owner = useRef(getAuthenticatedOwner()).current;
  managerRef.current ??= createMobileAgentSessionManager({
    store: storeRef.current,
    userWebConnection,
    organizationId,
  });

  // The provider only mounts on the agent-chat route, so the route's session id
  // is the session this manager owns. Publishing it lets the front-approval
  // orchestrator answer through this live connection instead of attaching a
  // second one to a relay that allows a single owner per session.
  const params = useLocalSearchParams<{ 'session-id'?: string | string[] }>();
  const rawSessionId = params['session-id'];
  const sessionId =
    Array.isArray(rawSessionId) || rawSessionId === undefined || rawSessionId.length === 0
      ? null
      : rawSessionId;

  useEffect(() => {
    if (sessionId === null) {
      return undefined;
    }
    const manager = managerRef.current;
    if (manager === null) {
      return undefined;
    }
    const handle = { manager, store: storeRef.current };
    registerLiveSessionManager(sessionId, handle);
    return () => {
      unregisterLiveSessionManager(sessionId, handle);
    };
  }, [sessionId]);

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
