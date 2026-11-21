import { type Href, type NativeStackNavigationProp, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

/**
 * The `router.replace` call signature, so helpers that already take a router
 * (`replaceWithAgentSession` and friends) accept this hook's result unchanged.
 */
export type StackSafeReplaceRouter = {
  replace: (href: Href) => void;
};

/** A source route waiting for the push that replaces it to settle. */
type PendingSource = {
  /**
   * The route count the stack must reach before this source can be retired. A
   * transition that ends while the stack is still shorter is the event of the
   * source screen's own arrival (or of the navigation that opened it), not the
   * end of the push this source belongs to.
   */
  readonly routesAfterPush: number;
  /** When this source stops being retirable, so a lost event cannot act later. */
  readonly expiresAt: number;
};

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
  // The stack has not gained the pushed route yet, so this end belongs to an
  // earlier navigation of the source screen, not to the push.
  if (routes.length < source.routesAfterPush) {
    return 'keep';
  }
  // The source left the stack some other way, or another navigation made it
  // the focused screen again: it is not ours to remove any more.
  if (key === focusedKey || !routes.some(route => route.key === key)) {
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

  useEffect(
    () =>
      navigation.addListener('transitionEnd', () => {
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
      }),
    [navigation]
  );

  const replace = useCallback(
    (href: Href) => {
      const state = navigation.getState();
      const sourceKey = state.routes[state.index]?.key ?? null;
      if (sourceKey !== null) {
        pendingSourcesRef.current.set(sourceKey, {
          routesAfterPush: state.routes.length + 1,
          expiresAt: Date.now() + PENDING_SOURCE_TTL_MS,
        });
      }
      router.push(href);
    },
    [navigation, router]
  );

  return { replace };
}
