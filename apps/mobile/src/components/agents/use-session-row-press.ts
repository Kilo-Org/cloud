import { useCallback } from 'react';

import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';

/**
 * Stable `onPress` for a memoised session row: it reads only the id, so the
 * returned callback keeps its identity while `navigateToSession` stays stable.
 */
export function useSessionRowPress(): (session: { id: string }) => void {
  const navigateToSession = useAgentSessionNavigator();
  return useCallback(
    (session: { id: string }) => {
      navigateToSession(session.id);
    },
    [navigateToSession]
  );
}
