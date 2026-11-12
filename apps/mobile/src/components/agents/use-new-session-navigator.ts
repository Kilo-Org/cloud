import { useCallback, useRef } from 'react';
import { type Href, useFocusEffect, useNavigation, useRouter } from 'expo-router';

import {
  type AgentSessionNavGuardState,
  claimAgentPush,
} from '@/components/agents/agent-session-nav-guard';
import {
  type AgentStackState,
  awaitComposerTop,
} from '@/components/agents/new-session-navigation-outcome';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';

/**
 * What one press of a composer entry point produced.
 *
 * `opened` — the navigator accepted the push and the composer is the route the
 * person now sees. `ignored` — the single-push guard answered this press, so
 * the press that owns the window is still the one landing. `failed` — the push
 * was dispatched and the composer never appeared: the navigator dropped it
 * (a push issued while the calling route is still settling is dropped) or the
 * call itself raised. Only the caller knows what to show for that.
 */
export type NewSessionOpenOutcome = 'opened' | 'ignored' | 'failed';

/** Resolve after `ms`, for the composer re-checks `awaitComposerTop` runs. */
function afterDelay(ms: number): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, ms);
  return promise;
}

/**
 * Single-push navigation to the new-session composer. Every composer entry
 * point uses this hook, so two taps in quick succession open the composer
 * once: a second push while the first was still in flight left a second
 * `agent-chat/new` screen on the native stack.
 *
 * The guard state clears when the calling screen regains focus, so a tap right
 * after the user returns from the composer always navigates. `useFocusEffect`
 * works in a non-screen component too (the Agents list body already relies on
 * that for session rows).
 *
 * The outcome is read back from the navigator, because a push is not a promise:
 * without that read a dropped push is indistinguishable from an accepted one,
 * and the press would leave the screen unchanged with nothing to show for it.
 */
export function useNewSessionNavigator() {
  const router = useRouter();
  const navigation = useNavigation();
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
    async (href: Href): Promise<NewSessionOpenOutcome> => {
      if (!beginNewSessionNavigation()) {
        return 'ignored';
      }
      // A push that does not land leaves nothing for the window to protect: a
      // retry must be able to go straight out, so the guard is released here.
      const failed = (): NewSessionOpenOutcome => {
        guardRef.current.lastPushAt = 0;
        return 'failed';
      };
      try {
        router.push(href);
      } catch {
        return failed();
      }
      const opened = await awaitComposerTop({
        readState: () => navigation.getState() as AgentStackState | undefined,
        sleep: afterDelay,
      });
      return opened ? 'opened' : failed();
    },
    [beginNewSessionNavigation, navigation, router]
  );

  // The plain "open the composer" entry points show nothing of their own: the
  // composer is the feedback. They keep the fire-and-forget shape; the read-only
  // Continue control is the one caller that reports a failed open.
  const openNewSession = useCallback(
    (organizationId: string | null) => {
      void openNewSessionHref(getNewAgentSessionPath(organizationId) as Href);
    },
    [openNewSessionHref]
  );

  return { openNewSession, openNewSessionHref, beginNewSessionNavigation };
}
