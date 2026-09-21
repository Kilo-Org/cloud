export type AppStateSource = {
  addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
};

export type AppStateStore = {
  subscribe: (listener: () => void) => () => void;
  isActive: () => boolean;
};

/**
 * Shared store around React Native's `AppState`, so every consumer reads one
 * subscription and one snapshot instead of mirroring the emitter into its own
 * `useState`. Pairs with `useSyncExternalStore`.
 *
 * `readInitialActive` supplies the seed, read at construction, again when the
 * first listener subscribes, and again on the last unsubscribe.
 * `use-app-lifecycle` keeps the default `true`: a screen that mounts while the
 * app is backgrounded has never observed a background -> active edge, and
 * must not start observing one now. The kilo-chat store seeds from the live
 * `AppState.currentState` instead, so a mount reads the live value, like
 * today's `useState(AppState.currentState === 'active')` did.
 *
 * The source listener is added with the first subscriber and removed with the
 * last. The first subscribe re-reads the seed before registering the source
 * listener: this store is built at module evaluation, often during launch
 * before the app reaches `active`, and it registered no listener until now, so
 * an inactive -> active edge in between is observed by nobody. Without the
 * re-read the first consumer would read a stale `false` for the whole session.
 * The last unsubscribe re-reads the seed so the next mount starts from the
 * same live value today's per-hook state did.
 */
export function createAppStateStore(
  source: AppStateSource,
  readInitialActive: () => boolean = () => true
): AppStateStore {
  const listeners = new Set<() => void>();
  let subscription: { remove(): void } | undefined = undefined;
  let active = readInitialActive();

  return {
    subscribe: listener => {
      listeners.add(listener);
      if (listeners.size === 1) {
        // Re-read the live seed before listening. The store is constructed at
        // module evaluation, so `active` mirrors the value at launch; the app
        // may have reached `active` since, and nothing observed that edge
        // because no source listener was registered yet. Without this the
        // first consumer reads a stale `false` for the whole session.
        active = readInitialActive();
        subscription = source.addEventListener('change', nextState => {
          const next = nextState === 'active';
          if (next === active) {
            return;
          }
          active = next;
          for (const notify of listeners) {
            notify();
          }
        });
      }

      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) {
          return;
        }
        subscription?.remove();
        subscription = undefined;
        active = readInitialActive();
      };
    },

    isActive: () => active,
  };
}
