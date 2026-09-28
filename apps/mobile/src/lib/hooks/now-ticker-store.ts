/**
 * Shared clock store for `useNowTicker`.
 *
 * A ticking clock is external mutable state, so it belongs in a store read via
 * `useSyncExternalStore` rather than one `useState` + `setInterval` per hook
 * consumer. Each interval value gets one lazily created, ref-counted ticker:
 * the first subscriber starts the single timer, later subscribers share the
 * same snapshot, and the last unsubscribe clears the timer and drops the
 * ticker so a later mount starts a fresh timer and a fresh `now`.
 */
// Property signatures (not methods) keep the two references stable and
// `this`-free when handed straight to `useSyncExternalStore`.
export type NowTicker = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
};

type TickerRegistration = {
  ticker: NowTicker;
  stop: () => void;
};

const tickers = new Map<number, TickerRegistration>();

function createRegistration(intervalMs: number): TickerRegistration {
  const listeners = new Set<() => void>();
  // Cached snapshot: `getSnapshot` must never call `Date.now()` inline, or
  // `useSyncExternalStore` would see a new value on every render and loop.
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined = undefined;

  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const registration: TickerRegistration = {
    stop,
    // Arrow properties keep both method references stable and `this`-free,
    // which is what `useSyncExternalStore` requires.
    ticker: {
      subscribe: listener => {
        listeners.add(listener);
        if (listeners.size === 1) {
          now = Date.now();
          timer = setInterval(() => {
            now = Date.now();
            for (const current of listeners) {
              current();
            }
          }, intervalMs);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            stop();
            // Only drop the registry entry if it still points at this
            // registration; a reset may already have replaced it.
            if (tickers.get(intervalMs) === registration) {
              tickers.delete(intervalMs);
            }
          }
        };
      },
      getSnapshot: () => now,
    },
  };
  return registration;
}

/**
 * Return the ticker for `intervalMs`, creating it on first use. The returned
 * object and its two methods are stable for as long as the ticker lives, which
 * is what `useSyncExternalStore` requires.
 */
export function getNowTicker(intervalMs: number): NowTicker {
  const existing = tickers.get(intervalMs);
  if (existing) {
    return existing.ticker;
  }
  const registration = createRegistration(intervalMs);
  tickers.set(intervalMs, registration);
  return registration.ticker;
}

/** Drop every cached ticker and stop every running timer. Test-only. */
export function resetNowTickersForTests(): void {
  for (const registration of tickers.values()) {
    registration.stop();
  }
  tickers.clear();
}
