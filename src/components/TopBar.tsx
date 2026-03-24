'use client';

import {
  createContext,
  useContext,
  useState,
  useLayoutEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { SidebarTrigger } from '@/components/ui/sidebar';

// ── Context ──────────────────────────────────────────────────────────────────

type TopBarContextValue = {
  title: string | null;
  setTitle: (title: string | null) => void;
  /** Slot for extra elements rendered on the right side of the topbar (e.g. notification bell). */
  rightSlot: ReactNode;
  setRightSlot: (node: ReactNode) => void;
};

const TopBarContext = createContext<TopBarContextValue | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [rightSlot, setRightSlot] = useState<ReactNode>(null);

  return (
    <TopBarContext.Provider value={{ title, setTitle, rightSlot, setRightSlot }}>
      {children}
    </TopBarContext.Provider>
  );
}

function useTopBarContext() {
  const ctx = useContext(TopBarContext);
  if (!ctx) throw new Error('useTopBarContext must be used within <TopBarProvider>');
  return ctx;
}

/**
 * Sets the topbar title for the lifetime of the calling component.
 * Cleans up on unmount so navigating away resets the title.
 */
export function useSetTopBarTitle(title: string | null) {
  const { setTitle } = useTopBarContext();
  useLayoutEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
}

/**
 * Returns a stable setter to place arbitrary content in the topbar's right slot.
 * Intended for the notification bell (wired in a later PR).
 */
export function useSetTopBarRightSlot() {
  const { setRightSlot } = useTopBarContext();
  return useCallback(
    (node: ReactNode) => {
      setRightSlot(node);
    },
    [setRightSlot]
  );
}

// ── TopBar UI ────────────────────────────────────────────────────────────────

export function TopBar() {
  const { title, rightSlot } = useTopBarContext();

  return (
    <header className="bg-background sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
      {/* Left: logo + sidebar trigger on mobile, page title on desktop */}
      <div className="flex items-center gap-3">
        <div className="md:hidden">
          <AnimatedLogo />
        </div>
        {title && (
          <h1 className="text-foreground hidden truncate text-lg font-semibold md:block">
            {title}
          </h1>
        )}
      </div>

      {/* Right: notification slot + sidebar trigger (mobile only) */}
      <div className="flex items-center gap-2">
        {rightSlot}
        <SidebarTrigger className="md:hidden" />
      </div>
    </header>
  );
}
