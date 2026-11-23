import { type Href, type NativeStackNavigationProp, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * The `router.replace` call signature, so helpers that already take a router
 * (`replaceWithAgentSession` and friends) accept this hook's result unchanged.
 */
export type StackSafeReplaceRouter = {
  replace: (href: Href) => void;
};

/**
 * A source route waiting for the push that replaces it to settle.
 *
 * The phase is the whole state, not a flag beside one: before the commit is
 * observed an arrival event can still belong to the source's own navigation,
 * and after it a stack that falls back can only mean the pushed route was
 * popped. The pushed route is never tracked by key: a screen can supersede
 * itself in place before this transition ends (a redirect or a guard's own
 * `replace`), and its key changing must not make the source forgettable.
 */
type PendingSource = {
  /**
   * The route count the stack reaches once the push commits. Below it the push
   * has not committed (or its route was popped); at or above it the stack holds
   * the pushed route.
   */
  readonly routesAfterPush: number;
  /** When this source stops being retirable, so a lost event cannot act later. */
  readonly expiresAt: number;
} & (
  | {
      /** The push is dispatched; the stack has not shown the pushed route yet. */
      readonly phase: 'awaiting-push';
    }
  | {
      /** The navigator has shown the pushed route. */
      readonly phase: 'pushed';
    }
);

/**
 * How long a pending source stays retirable. The push transition ends within a
 * few hundred milliseconds; past this bound the ending event was lost, and
 * judging the stack at some later navigation could retire a screen that the
 * reader is using, so the source is dropped instead.
 */
const PENDING_SOURCE_TTL_MS = 2_000;

/**
 * What one end of a transition means for a source waiting to be retired:
 * `retire` removes it, `keep` waits for the end of the push it belongs to, and
 * `drop` forgets it because it can never be removed safely.
 */
function pendingSourceOutcome({
  key,
  source,
  routes,
  focusedKey,
  now,
}: Readonly<{
  key: string;
  source: PendingSource;
  routes: readonly { readonly key: string }[];
  focusedKey: string | undefined;
  now: number;
}>): 'retire' | 'keep' | 'drop' {
  // The push never settled: judging the stack at some later navigation could
  // retire a screen the reader is using, so the source is forgotten instead.
  if (now > source.expiresAt) {
    return 'drop';
  }
  // The source left the stack some other way: it is not ours to remove any
  // more.
  if (!routes.some(route => route.key === key)) {
    return 'drop';
  }
  if (routes.length < source.routesAfterPush) {
    // The stack has not gained the pushed route yet, so this end belongs to an
    // earlier navigation of the source screen, not to the push.
    if (source.phase === 'awaiting-push') {
      return 'keep';
    }
    // The commit was observed and the stack has fallen back since: the pushed
    // route was popped, so the swap this source belongs to is over.
    return 'drop';
  }
  // Another navigation made the source the focused screen again: removing it
  // would tear the screen the reader is on.
  if (key === focusedKey) {
    return 'drop';
  }
  return 'retire';
}

/**
 * A `router.replace` that the Android native stack survives.
 *
 * `router.replace` removes the current screen and inserts the next one in a
 * single native-stack commit. On Android, react-native-screens reparents a view
 * the outgoing screen still owns during that commit and Fabric throws
 * `addViewAt: failed to insert view [...] The specified child already has a
 * parent` (Sentry KILO-APP-25). A plain `push` and a plain `pop` each commit
 * cleanly; only the combined swap breaks.
 *
 * So push, then drop the route we came from once its transition has ended. That
 * route is no longer the visible screen by then, so removing it animates nothing
 * and commits on its own. The end state is the one `replace` produces: the source
 * screen is gone and back skips past it.
 *
 * Waiting for `transitionEnd` is what makes the second commit safe. The earlier
 * form of this pushed and then reset the stack one frame later, which landed the
 * second commit while the push was still animating and crashed the same way.
 *
 * The event has to be the end of *this* push. A screen's own arrival event can
 * still be in flight when the replace runs, and the navigator emits it after the
 * push was dispatched but before the pushed route committed. Judging the stack
 * on that event sees the source as the focused route, which used to drop it from
 * the pending set: the real end then found nothing to retire and the source
 * stayed in the stack for good, so one Back landed on the screen the replace had
 * already replaced. A source therefore waits until the stack holds the route the
 * push added.
 *
 * Depth alone cannot say which push an end closes. If the push's own end is
 * lost and the reader pops back to the source, the source stays pending at the
 * old depth, and a later push that reaches that depth again would retire the
 * screen the reader is on. So the navigator's `state` event moves the source to
 * its `pushed` phase once the stack reaches `routesAfterPush`; from then on a
 * stack that falls back means the pushed route was popped, and the source is
 * forgotten. The reset still waits for `transitionEnd`: running it from the
 * `state` event would land it inside the push animation and crash the same way.
 *
 * The removal is keyed on the routes focused when the navigations started, so a
 * duplicate route name elsewhere in the stack is never dropped by mistake.
 * A second `replace` before the first transition ends only adds its source to
 * the pending set: the first source stays tracked, and one cleanup then
 * retires every replaced screen at once, so back skips all of them.
 */
export function useStackSafeReplace(): StackSafeReplaceRouter {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  const pendingSourcesRef = useRef<Map<string, PendingSource>>(new Map());

  useEffect(() => {
    const unsubscribeTransitionEnd = navigation.addListener('transitionEnd', () => {
      const pendingSources = pendingSourcesRef.current;
      if (pendingSources.size === 0) {
        return;
      }
      const state = navigation.getState();
      const focusedKey = state.routes[state.index]?.key;
      const now = Date.now();
      // Keep a key pending only while it can still be retired; a source that
      // left the stack some other way, that some other navigation made the
      // focused screen, or whose push never settled is no longer ours to
      // remove.
      const outcomes = new Map(
        [...pendingSources].map(([key, source]) => [
          key,
          pendingSourceOutcome({ key, source, routes: state.routes, focusedKey, now }),
        ])
      );
      const retirable = new Set(
        [...outcomes].filter(([, outcome]) => outcome === 'retire').map(([key]) => key)
      );
      for (const [key, outcome] of outcomes) {
        if (outcome === 'drop') {
          pendingSources.delete(key);
        }
      }
      if (retirable.size === 0) {
        return;
      }
      const routes = state.routes.filter(route => !retirable.has(route.key));
      // The reset would empty the navigator: leave the stack alone rather
      // than commit a bad reset.
      if (routes.length === 0) {
        return;
      }
      for (const key of retirable) {
        pendingSources.delete(key);
      }
      navigation.reset({ ...state, routes, index: routes.length - 1 });
    });
    // Every committed navigation reports the stack here. The phase is decided
    // from that state alone, and retirement stays on `transitionEnd` so the
    // reset never lands inside the running push animation.
    const unsubscribeState = navigation.addListener('state', () => {
      const pendingSources = pendingSourcesRef.current;
      if (pendingSources.size === 0) {
        return;
      }
      const state = navigation.getState();
      const focusedKey = state.routes[state.index]?.key;
      const now = Date.now();
      for (const [key, source] of pendingSources) {
        if (now > source.expiresAt || !state.routes.some(route => route.key === key)) {
          // Expired, or the source left the stack some other way.
          pendingSources.delete(key);
        } else if (source.phase === 'awaiting-push') {
          // An arrival event of the source's own navigation can only be seen
          // before the commit, so a short stack leaves the entry alone; once
          // the stack reaches the pushed depth the commit is observed.
          if (state.routes.length >= source.routesAfterPush) {
            pendingSources.set(key, { ...source, phase: 'pushed' });
          }
        } else if (state.routes.length < source.routesAfterPush || focusedKey === key) {
          // The stack fell back below the pushed depth (the pushed route was
          // popped), or the reader reversed the replace by focusing the source
          // again. Forgetting it is safe where retiring it could remove the
          // screen the reader is on.
          pendingSources.delete(key);
        }
      }
    });
    return () => {
      unsubscribeTransitionEnd();
      unsubscribeState();
    };
  }, [navigation]);

  const replace = useCallback(
    (href: Href) => {
      const state = navigation.getState();
      const sourceKey = state.routes[state.index]?.key ?? null;
      if (sourceKey !== null) {
        pendingSourcesRef.current.set(sourceKey, {
          phase: 'awaiting-push',
          routesAfterPush: state.routes.length + 1,
          expiresAt: Date.now() + PENDING_SOURCE_TTL_MS,
        });
      }
      router.push(href);
    },
    [navigation, router]
  );

  // Call sites hold this object in effect dependency arrays, so it must stay
  // the same one between renders: a fresh `{ replace }` would rebuild every
  // callback and re-subscribe every effect that depends on it.
  return useMemo(() => ({ replace }), [replace]);
}
