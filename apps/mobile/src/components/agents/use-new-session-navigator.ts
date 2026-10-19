import { useCallback, useRef } from 'react';
import { type Href, useFocusEffect, useRouter } from 'expo-router';

import {
  type AgentSessionNavGuardState,
  claimAgentPush,
} from '@/components/agents/agent-session-nav-guard';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';

/**
 * Single-push navigation to the new-session composer. Every composer entry
 * point uses this hook, so two taps in quick succession open the composer
 * once: a second push while the first was still in flight left a second
 * `agent-chat/new` screen on the native stack, and on iOS the mid-transition
 * press could surface the session route with no usable id instead of the
 * composer.
 *
 * The guard state clears when the calling screen regains focus, so a tap right
 * after the user returns from the composer always navigates. `useFocusEffect`
 * works in a non-screen component too (the Agents list body already relies on
 * that for session rows).
 */
export function useNewSessionNavigator() {
  const router = useRouter();
  const guardRef = useRef<AgentSessionNavGuardState>({ lastPushAt: 0 });

  useFocusEffect(
    useCallback(() => {
      guardRef.current.lastPushAt = 0;
    }, [])
  );

  const beginNewSessionNavigation = useCallback(
    () => claimAgentPush(guardRef.current, Date.now()),
    []
  );

  const openNewSessionHref = useCallback(
    (href: Href) => {
      if (beginNewSessionNavigation()) {
        router.push(href);
      }
    },
    [beginNewSessionNavigation, router]
  );

  const openNewSession = useCallback(
    (organizationId: string | null) => {
      openNewSessionHref(getNewAgentSessionPath(organizationId) as Href);
    },
    [openNewSessionHref]
  );

  return { openNewSession, openNewSessionHref, beginNewSessionNavigation };
}
