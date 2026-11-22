import { type Href, type NativeStackNavigationProp, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/** The `router.replace` call signature, so a guard keeps its `replace(href)` call shape. */
export type SettledReplaceRouter = {
  replace: (href: Href) => void;
};

/**
 * A `router.replace` dispatched only once the navigator has settled.
 *
 * A guard that bounces a screen it has just been focused on — a settings
 * sub-screen behind a disabled agent, a reviewer sub-route for a non-editor —
 * runs while the navigation that opened it is often still animating. A
 * `router.replace` committed during that transition lands a route swap inside
 * the running animation's commit: react-native-screens reparents a view the
 * outgoing screen still owns and Fabric throws `addViewAt: failed to insert
 * view [...] The specified child already has a parent`.
 * The same collision happens when the swap shares a commit with a
 * `preventRemove` option change (`use-metadata-leave-guard.ts`).
 *
 * So queue the destination and dispatch it from the navigator's own next
 * `transitionEnd`; with no transition running, dispatch it from the next
 * macrotask instead — the same one-task deferral `use-metadata-leave-guard.ts`
 * documents, which is enough for the render that disarms a guard to reach the
 * native side first. `navigation.isFocused()` says nothing about an animation
 * in progress, so the in-flight state comes from the navigator's events.
 *
 * The destination stays at the same stack position, unlike
 * `useStackSafeReplace()`: its push-then-retire leaves the bounced screen
 * beneath the target whenever the retire does not run, and a later Back would
 * bounce again.
 *
 * One destination is queued per mount: a later bounce replaces the earlier
 * queued one, and nothing is dispatched after unmount. A transition that was
 * already running before this screen mounted is not observable here, so the
 * one-task deferral is what covers that case — the swap still lands later than
 * a literal `router.replace` in every path, never earlier.
 */
export function useSettledReplace(): SettledReplaceRouter {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  // The one destination waiting for the navigator to settle.
  const queuedRef = useRef<Href | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Whether the navigator is animating right now, from its own events.
  const inFlightRef = useRef(false);

  const dispatchQueued = useCallback(() => {
    timerRef.current = undefined;
    // A transition started after this dispatch was scheduled: its own end
    // dispatches the queued destination, so this task must not commit a swap.
    if (inFlightRef.current) {
      return;
    }
    const href = queuedRef.current;
    if (href === null) {
      return;
    }
    queuedRef.current = null;
    router.replace(href);
  }, [router]);

  useEffect(() => {
    const unsubscribeStart = navigation.addListener('transitionStart', () => {
      inFlightRef.current = true;
    });
    const unsubscribeEnd = navigation.addListener('transitionEnd', () => {
      inFlightRef.current = false;
      if (queuedRef.current !== null) {
        dispatchQueued();
      }
    });
    return () => {
      unsubscribeStart();
      unsubscribeEnd();
      // The mount is gone: neither the task nor a lost event may dispatch.
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      queuedRef.current = null;
    };
  }, [navigation, dispatchQueued]);

  const replace = useCallback(
    (href: Href) => {
      queuedRef.current = href;
      // An animation owns the next commit: its end dispatches the destination.
      if (inFlightRef.current) {
        return;
      }
      // An already scheduled task reads the destination set above.
      if (timerRef.current !== undefined) {
        return;
      }
      timerRef.current = setTimeout(dispatchQueued, 0);
    },
    [dispatchQueued]
  );

  return useMemo(() => ({ replace }), [replace]);
}
