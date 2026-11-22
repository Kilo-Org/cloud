import { type Href, type NativeStackNavigationProp, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/** The `router.replace` call signature, so a guard keeps its `replace(href)` call shape. */
export type SettledReplaceRouter = {
  replace: (href: Href) => void;
};

/**
 * How long a queued destination waits for `transitionEnd` before it is
 * dispatched anyway. A native-stack push or pop animates for a few hundred
 * milliseconds, so a real end arrives well inside this bound and the fallback
 * only fires when that event was lost. It must stay comfortably longer than an
 * animation: firing while a transition is still running would commit a route
 * swap inside the running animation, which is the Fabric crash this hook
 * exists to prevent.
 */
const SETTLE_FALLBACK_MS = 1_000;

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
 *
 * Waiting for `transitionEnd` waits on an event that can be lost: an
 * interrupted animation, or a navigator that emits no transition events at
 * all, leaves every later commit looking in flight, and the guard's redirect
 * would never land — the reader stays on the screen the guard meant to leave.
 * So that wait is bounded by `SETTLE_FALLBACK_MS`: past it the transition
 * never ended, the navigator is treated as settled, and the queued destination
 * is dispatched. The bound is a whole second, several times a native-stack
 * animation, so a real end always wins; a real end that still arrives later
 * finds nothing queued and does nothing.
 */
export function useSettledReplace(): SettledReplaceRouter {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  // The one destination waiting for the navigator to settle.
  const queuedRef = useRef<Href | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The bound on a lost `transitionEnd`; armed only while a destination waits
  // on a transition.
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Whether the navigator is animating right now, from its own events.
  const inFlightRef = useRef(false);

  /** Dispatch the queued destination now: no transition owns the next commit. */
  const settleNow = useCallback(() => {
    timerRef.current = undefined;
    clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = undefined;
    const href = queuedRef.current;
    if (href === null) {
      return;
    }
    queuedRef.current = null;
    router.replace(href);
  }, [router]);

  /** The transition this destination waited on never reported its end. */
  const expireTransition = useCallback(() => {
    fallbackTimerRef.current = undefined;
    inFlightRef.current = false;
    settleNow();
  }, [settleNow]);

  /** Bound the wait for the running transition's end, restarting an armed one. */
  const armFallback = useCallback(() => {
    clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(expireTransition, SETTLE_FALLBACK_MS);
  }, [expireTransition]);

  const dispatchQueued = useCallback(() => {
    timerRef.current = undefined;
    const href = queuedRef.current;
    if (href === null) {
      return;
    }
    // A transition started after this dispatch was scheduled: its own end
    // dispatches the queued destination, so this task must not commit a swap.
    if (inFlightRef.current) {
      armFallback();
      return;
    }
    settleNow();
  }, [armFallback, settleNow]);

  useEffect(() => {
    const unsubscribeStart = navigation.addListener('transitionStart', () => {
      inFlightRef.current = true;
      // A destination queued now waits on this transition's end, so its bound
      // starts (or restarts) with this animation rather than an earlier one.
      if (queuedRef.current !== null) {
        armFallback();
      }
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
      // The mount is gone: neither task nor a lost event may dispatch.
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = undefined;
      queuedRef.current = null;
    };
  }, [navigation, armFallback, dispatchQueued]);

  const replace = useCallback(
    (href: Href) => {
      queuedRef.current = href;
      // This destination replaces whatever was queued, so a bound armed for
      // the earlier one is dropped; it is armed again below when a transition
      // still owns the commit.
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = undefined;
      // An animation owns the next commit: its end dispatches the destination.
      if (inFlightRef.current) {
        armFallback();
        return;
      }
      // An already scheduled task reads the destination set above.
      if (timerRef.current !== undefined) {
        return;
      }
      timerRef.current = setTimeout(dispatchQueued, 0);
    },
    [armFallback, dispatchQueued]
  );

  return useMemo(() => ({ replace }), [replace]);
}
