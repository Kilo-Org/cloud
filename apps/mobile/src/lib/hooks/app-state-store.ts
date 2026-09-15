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
 * `readInitialActive` supplies the seed, read once at construction and again
 * on the last unsubscribe. `use-app-lifecycle` keeps the default `true`: a
 * screen that mounts while the app is backgrounded has never observed a
 * background -> active edge, and must not start observing one now. The
 * kilo-chat store seeds from the live `AppState.currentState` instead, so a
 * remount while backgrounded reads the live value, like today's
 * `useState(AppState.currentState === 'active')` did.
 *
 * The source listener is added with the first subscriber and removed with the
 * last, and the last unsubscribe re-reads the seed so the next mount starts
 * from the same live value today's per-hook state did.
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
