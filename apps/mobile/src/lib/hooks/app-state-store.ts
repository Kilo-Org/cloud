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
 * The value starts `true`, matching the per-hook state this replaces: a screen
 * that mounts while the app is backgrounded has never observed a
 * background -> active edge, and must not start observing one now. The source
 * listener is added with the first subscriber and removed with the last, and
 * the last unsubscribe resets the value to `true` so the next mount starts
 * from the same place today's `useState(true)` did.
 */
export function createAppStateStore(source: AppStateSource): AppStateStore {
  const listeners = new Set<() => void>();
  let subscription: { remove(): void } | undefined = undefined;
  let active = true;

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
        active = true;
      };
    },

    isActive: () => active,
  };
}
