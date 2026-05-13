'use client';

/**
 * Per-wasteland-page header composition.
 *
 * The wasteland layout renders one top navbar (`WastelandDashboardHeader`).
 * Each page contributes its own "section" (title + count + action buttons)
 * into that navbar via `useSetWastelandPageHeader(section)` — mirroring
 * the `SetPageTitle` / `PageTitleContext` pattern already used elsewhere
 * in the app, but scoped to this subtree and shaped for the target DOM.
 *
 * Usage:
 *   useSetWastelandPageHeader({
 *     title: 'Wanted Board',
 *     icon: <ScrollText className="size-4 ..." />,
 *     count: items.length,
 *     actions: <>
 *       <button onClick={...}>Post</button>
 *       <button onClick={...}>Refresh</button>
 *     </>,
 *   });
 *
 * Implementation note: under the hood we use a mutable "latest section"
 * ref + `useSyncExternalStore` rather than React state, so pages can
 * pass inline JSX for `icon` and `actions` (fresh ReactNode identity
 * every render) without triggering an infinite render loop. Pages
 * publish the whole section every render; the navbar re-renders only
 * when `title` or `count` change, or when the subscriber explicitly
 * notifies (e.g. on mount/unmount).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

export type WastelandPageHeader = {
  /** Plain-text page title shown beside the wasteland identity. */
  title: string;
  /** Optional leading icon (already styled by the caller). */
  icon?: ReactNode;
  /** Optional count rendered after the title (items, members, rigs…). */
  count?: number | null;
  /** Optional right-aligned action cluster (buttons, dialog triggers, badges). */
  actions?: ReactNode;
};

type Store = {
  get: () => WastelandPageHeader | null;
  /** Replace the whole section (or clear it). Triggers subscribers. */
  publish: (next: WastelandPageHeader | null) => void;
  /** Subscribe to header changes. Called by `useSyncExternalStore`. */
  subscribe: (listener: () => void) => () => void;
};

function createStore(): Store {
  let current: WastelandPageHeader | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    publish(next) {
      current = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const StoreContext = createContext<Store | undefined>(undefined);

export function WastelandPageHeaderProvider({ children }: { children: ReactNode }) {
  // One store per provider instance. Stable across re-renders.
  const store = useMemo(() => createStore(), []);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error(
      'useWastelandPageHeader / useSetWastelandPageHeader must be used within a WastelandPageHeaderProvider'
    );
  }
  return store;
}

/**
 * Read the current page header section. Returns `null` when no page has
 * written one yet (loading, or off-route). Consumed by
 * `WastelandDashboardHeader` to render the third slot in the navbar.
 *
 * Uses `useSyncExternalStore` so the navbar re-renders only when the
 * store publishes — not on every page render.
 */
export function useWastelandPageHeader(): WastelandPageHeader | null {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Declaratively write the current page's header section. Clears on unmount
 * so stale sections don't leak across page transitions.
 *
 * Safe to call with inline JSX for `icon` and `actions`: each render
 * publishes the fresh section, the store forwards it to the navbar's
 * `useSyncExternalStore` subscription, and the navbar re-renders once.
 * This hook never subscribes to the store, so publishing from here does
 * NOT re-render the caller — no infinite loop.
 */
export function useSetWastelandPageHeader(section: WastelandPageHeader): void {
  const store = useStore();

  // Keep a ref to the latest section so the unmount cleanup knows what
  // we last wrote and can avoid clobbering a newer page's header.
  const latest = useRef(section);
  latest.current = section;

  // Publish on every render. Because `publish` only notifies subscribers
  // (the navbar) and doesn't touch React state owned by *this* component,
  // writing here doesn't re-trigger a render on the caller.
  useEffect(() => {
    store.publish(latest.current);
  });

  // Cleanup on unmount only.
  const cleanup = useCallback(() => {
    // If a newer writer has already replaced our section, leave it.
    if (store.get() === latest.current) {
      store.publish(null);
    }
  }, [store]);
  useEffect(() => cleanup, [cleanup]);
}
