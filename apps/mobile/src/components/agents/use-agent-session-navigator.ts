import { useCallback, useRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';

import {
  type AgentSessionNavGuardState,
  pushAgentSessionOnce,
} from '@/components/agents/agent-session-nav-guard';

/**
 * Single-push navigation to a session's agent-chat route. Every session row
 * uses this hook, so two taps in quick succession push the route once.
 *
 * The guard state also clears when the calling screen regains focus, so a tap
 * right after the user returns from the session screen always navigates. The
 * `useFocusEffect` call works in a non-screen component too; the Agents list
 * body (`session-list-content.tsx`) already relies on that.
 */
export function useAgentSessionNavigator(): (
  sessionId: string,
  organizationId?: string | null
) => void {
  const router = useRouter();
  const guardRef = useRef<AgentSessionNavGuardState>({ lastPushAt: 0 });

  useFocusEffect(
    useCallback(() => {
      guardRef.current.lastPushAt = 0;
    }, [])
  );

  return useCallback(
    (sessionId: string, organizationId?: string | null) => {
      pushAgentSessionOnce({
        state: guardRef.current,
        router,
        now: Date.now(),
        sessionId,
        organizationId,
      });
    },
    [router]
  );
}
