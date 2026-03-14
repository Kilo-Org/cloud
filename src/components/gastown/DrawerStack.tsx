'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ChevronLeft } from 'lucide-react';
import type { TownEvent } from './ActivityFeed';

// ── Resource types ───────────────────────────────────────────────────────

export type ResourceRef =
  | { type: 'bead'; beadId: string; rigId: string }
  | { type: 'agent'; agentId: string; rigId: string; townId?: string }
  | { type: 'event'; event: TownEvent }
  | { type: 'convoy'; convoyId: string; townId: string };

type DrawerStackEntry = {
  key: string;
  resource: ResourceRef;
};

// ── Context ──────────────────────────────────────────────────────────────

type DrawerStackContextValue = {
  stack: DrawerStackEntry[];
  push: (resource: ResourceRef) => void;
  pop: () => void;
  closeAll: () => void;
  /** Replace the entire stack with a single entry (for opening from a page) */
  open: (resource: ResourceRef) => void;
};

const DrawerStackContext = createContext<DrawerStackContextValue | null>(null);

export function useDrawerStack() {
  const ctx = useContext(DrawerStackContext);
  if (!ctx) throw new Error('useDrawerStack must be used within DrawerStackProvider');
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────

let globalKeyCounter = 0;

function makeKey() {
  return `drawer-${++globalKeyCounter}`;
}

export function DrawerStackProvider({
  children,
  renderContent,
}: {
  children: ReactNode;
  /** Render the drawer body for a given resource. Receives onNavigate to push sub-resources. */
  renderContent: (
    resource: ResourceRef,
    helpers: {
      push: (resource: ResourceRef) => void;
      close: () => void;
    }
  ) => ReactNode;
}) {
  const [stack, setStack] = useState<DrawerStackEntry[]>([]);

  const push = useCallback((resource: ResourceRef) => {
    setStack(prev => [...prev, { key: makeKey(), resource }]);
  }, []);

  const pop = useCallback(() => {
    setStack(prev => (prev.length > 0 ? prev.slice(0, -1) : prev));
  }, []);

  const closeAll = useCallback(() => {
    setStack([]);
  }, []);

  const open = useCallback((resource: ResourceRef) => {
    setStack([{ key: makeKey(), resource }]);
  }, []);

  return (
    <DrawerStackContext.Provider value={{ stack, push, pop, closeAll, open }}>
      {children}
      <DrawerStackRenderer
        stack={stack}
        pop={pop}
        closeAll={closeAll}
        push={push}
        renderContent={renderContent}
      />
    </DrawerStackContext.Provider>
  );
}

// ── Renderer ─────────────────────────────────────────────────────────────

const DRAWER_WIDTH = 500;
/** How many px each background layer shifts left per depth level */
const DEPTH_OFFSET = 40;
/** Extra shift on hover */
const HOVER_EXTRA = 24;

function DrawerStackRenderer({
  stack,
  pop,
  closeAll,
  push,
  renderContent,
}: {
  stack: DrawerStackEntry[];
  pop: () => void;
  closeAll: () => void;
  push: (resource: ResourceRef) => void;
  renderContent: (
    resource: ResourceRef,
    helpers: { push: (resource: ResourceRef) => void; close: () => void }
  ) => ReactNode;
}) {
  const isOpen = stack.length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop — click to close all */}
          <motion.div
            key="drawer-stack-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={closeAll}
            className="fixed inset-0 z-[60] bg-black/50"
          />

          {/* Drawer layers */}
          {stack.map((entry, index) => {
            const depth = stack.length - 1 - index; // 0 = top
            const isTop = depth === 0;

            return (
              <DrawerLayer
                key={entry.key}
                depth={depth}
                totalLayers={stack.length}
                isTop={isTop}
                onClose={isTop ? pop : undefined}
                onBack={index > 0 && isTop ? pop : undefined}
              >
                {renderContent(entry.resource, {
                  push,
                  close: isTop ? pop : closeAll,
                })}
              </DrawerLayer>
            );
          })}
        </>
      )}
    </AnimatePresence>
  );
}

// ── Individual drawer layer ──────────────────────────────────────────────

function DrawerLayer({
  depth,
  totalLayers,
  isTop,
  onClose,
  onBack,
  children,
}: {
  depth: number;
  totalLayers: number;
  isTop: boolean;
  onClose?: () => void;
  onBack?: (() => void) | false;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  // Top layer: right: 0. Background layers: shift left by depth * offset.
  // On hover, background layers shift further left.
  const rightOffset = isTop ? 0 : -(depth * DEPTH_OFFSET + (hovered ? HOVER_EXTRA : 0));
  const scale = isTop ? 1 : 1 - depth * 0.015;
  const opacity = isTop ? 1 : 0.6 + (hovered ? 0.25 : 0);

  return (
    <motion.div
      initial={{ x: DRAWER_WIDTH + 20 }}
      animate={{
        x: rightOffset,
        scale,
        opacity,
      }}
      exit={{ x: DRAWER_WIDTH + 20, opacity: 0 }}
      transition={{
        type: 'spring',
        stiffness: 400,
        damping: 35,
        opacity: { duration: 0.2 },
      }}
      onMouseEnter={() => {
        if (!isTop) setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      className="fixed top-0 right-0 bottom-0 z-[61] flex flex-col outline-none"
      style={{
        width: DRAWER_WIDTH,
        maxWidth: '94vw',
        zIndex: 61 + (totalLayers - depth),
        pointerEvents: isTop ? 'auto' : hovered ? 'auto' : 'none',
      }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-l-2xl border-l border-white/[0.08] bg-[oklch(0.12_0_0)] shadow-2xl">
        {/* Header bar with back / close */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
          <div className="flex items-center gap-1">
            {onBack && (
              <button
                onClick={onBack}
                className="rounded-md p-1 text-white/30 transition-colors hover:bg-white/5 hover:text-white/60"
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md p-1 text-white/30 transition-colors hover:bg-white/5 hover:text-white/60"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </motion.div>
  );
}
