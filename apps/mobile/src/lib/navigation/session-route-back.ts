import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { BackHandler } from 'react-native';

import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';

/**
 * System Back on the agent-chat session route.
 *
 * With a route beneath the session, the press belongs to the navigator: it pops
 * one screen and the history list it reveals keeps its scope and search. This
 * listener stays out of that path and returns `false`.
 *
 * With nothing beneath — an open that restored or replaced the route as the
 * stack's only screen — the navigator has nothing to pop, and Android's default
 * Back leaves the app. The header's own back control already falls back to the
 * sessions list for that case (`backFallback`), and system Back must answer the
 * same way, so it navigates there and consumes the press.
 */
export function useSessionRouteBack(): void {
  const router = useRouter();
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (router.canGoBack()) {
          return false;
        }
        router.dismissTo(AGENTS_SESSIONS_HREF as Href);
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [router])
  );
}
