import { useNavigation, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { AGENTS_SESSIONS_INDEX_HREF, agentsSessionsExit } from '@/lib/agents-sessions-route';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';

/**
 * The press that leaves a failed session for the Agents sessions list.
 *
 * With a route beneath the screen, the press pops back to it
 * (`router.dismissTo` dispatches POP_TO over the `(tabs)` route the list lives
 * in, truncating any `agent-chat` route above it). A screen that is its stack's
 * only route has nothing to dismiss to, so the press takes its place instead:
 * POP_TO would rewrite the stack in one commit there, and Android drops that
 * shape. The replacement pushes the list and retires this route once its push
 * settles, because `replace`'s own single commit is the remove-and-insert shape
 * that crashes Android Fabric. Both branches land on the same list.
 */
export function useBackToAgentsSessions(): () => void {
  const router = useRouter();
  const navigation = useNavigation();
  const { replace } = useStackSafeReplace();

  return useCallback(() => {
    const state = navigation.getState();
    if (agentsSessionsExit({ currentIndex: state?.index ?? 0 }) === 'replace') {
      replace(AGENTS_SESSIONS_INDEX_HREF);
      return;
    }
    router.dismissTo(AGENTS_SESSIONS_INDEX_HREF);
  }, [navigation, replace, router]);
}
