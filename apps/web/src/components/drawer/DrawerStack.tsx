'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, X } from 'lucide-react';

// ── Public types ─────────────────────────────────────────────────────────

export type DrawerStackHelpers<T> = {
  push: (entry: T) => void;
  replace: (entry: T) => void;
  pop: () => void;
  /** On the top layer this is `pop`; on deeper layers this is `closeAll`. */
  close: () => void;
  closeAll: () => void;
};

/**
 * Render result for a drawer entry. Either a plain body (the primitive's
 * header row stays empty apart from the back/close buttons), or a
 * `{ header, body }` split so the panel can contribute its own title
 * inline with the close button.
 */
export type DrawerRenderResult = ReactNode | { header?: ReactNode; body: ReactNode };

export type DrawerStackRenderContent<T> = (
  entry: T,
  helpers: DrawerStackHelpers<T>
) => DrawerRenderResult;

function splitRenderResult(result: DrawerRenderResult): {
  header: ReactNode;
  body: ReactNode;
} {
  if (result !== null && typeof result === 'object' && 'body' in result) {
    return { header: result.header ?? null, body: result.body };
  }
  return { header: null, body: result };
}

export type DrawerStackApi<T> = {
  stack: readonly T[];
  push: (entry: T) => void;
  replace: (entry: T) => void;
  pop: () => void;
  /** Replace the entire stack with a single entry (used when opening from a page). */
  open: (entry: T) => void;
  closeAll: () => void;
};

// ── Default visual constants ─────────────────────────────────────────────

const DEFAULT_WIDTH = 620;
const DEFAULT_DEPTH_OFFSET = 40;
const HOVER_EXTRA = 24;

/**
 * Create a typed drawer-stack provider + hook pair for a specific entry type.
 * Keeping the factory generic lets each caller use their own discriminated
 * union for entries without leaking types into the shared primitive.
 */
export function createDrawerStack<T>() {
  type Entry = {
    key: string;
    value: T;
  };

  // Monotonic counter used so `AnimatePresence` retains exit animations even
  // when two consecutive entries have identical user-facing identity.
  // Scoped inside the factory so each `createDrawerStack<T>()` caller gets
  // its own counter — gastown and wasteland don't share a sequence.
  let keyCounter = 0;
  const makeKey = () => `drawer-${++keyCounter}`;

  const Ctx = createContext<DrawerStackApi<T> | null>(null);

  function useDrawerStack(): DrawerStackApi<T> {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error('useDrawerStack must be used within DrawerStackProvider');
    return ctx;
  }

  function DrawerStackProvider({
    children,
    renderContent,
    width = DEFAULT_WIDTH,
    depthOffset = DEFAULT_DEPTH_OFFSET,
    rightOffset = 0,
  }: {
    children: ReactNode;
    renderContent: DrawerStackRenderContent<T>;
    width?: number;
    depthOffset?: number;
    rightOffset?: number;
  }) {
    const [stack, setStack] = useState<Entry[]>([]);

    const push = useCallback((value: T) => {
      setStack(prev => [...prev, { key: makeKey(), value }]);
    }, []);

    const replace = useCallback((value: T) => {
      setStack(prev => {
        const next = { key: makeKey(), value };
        return prev.length > 0 ? [...prev.slice(0, -1), next] : [next];
      });
    }, []);

    const pop = useCallback(() => {
      setStack(prev => (prev.length > 0 ? prev.slice(0, -1) : prev));
    }, []);

    const closeAll = useCallback(() => {
      setStack([]);
    }, []);

    const open = useCallback((value: T) => {
      setStack([{ key: makeKey(), value }]);
    }, []);

    const stackValues = stack.map(e => e.value);
    const api: DrawerStackApi<T> = {
      stack: stackValues,
      push,
      replace,
      pop,
      open,
      closeAll,
    };

    return (
      <Ctx.Provider value={api}>
        {children}
        <DrawerStackRenderer
          stack={stack}
          pop={pop}
          closeAll={closeAll}
          push={push}
          replace={replace}
          renderContent={renderContent}
          width={width}
          depthOffset={depthOffset}
          rightOffset={rightOffset}
        />
      </Ctx.Provider>
    );
  }

  function DrawerStackRenderer({
    stack,
    pop,
    closeAll,
    push,
    replace,
    renderContent,
    width,
    depthOffset,
    rightOffset,
  }: {
    stack: Entry[];
    pop: () => void;
    closeAll: () => void;
    push: (value: T) => void;
    replace: (value: T) => void;
    renderContent: DrawerStackRenderContent<T>;
    width: number;
    depthOffset: number;
    rightOffset: number;
  }) {
    const isOpen = stack.length > 0;
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const wasOpenRef = useRef(false);

    useEffect(() => {
      if (isOpen && !wasOpenRef.current) {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      } else if (!isOpen && wasOpenRef.current) {
        previousFocusRef.current?.focus();
        previousFocusRef.current = null;
      }
      wasOpenRef.current = isOpen;
    }, [isOpen]);

    // ESC closes the top layer.
    useEffect(() => {
      if (!isOpen) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !e.defaultPrevented) pop();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, pop]);

    // Lock body scroll while any layer is open so the backdrop captures scroll.
    useEffect(() => {
      if (!isOpen) return;
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }, [isOpen]);

    return (
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop — click closes the whole stack. */}
            <motion.div
              key="drawer-stack-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={closeAll}
              className="fixed inset-0 z-[60] bg-black/50"
            />

            {stack.map((entry, index) => {
              const depth = stack.length - 1 - index; // 0 = top
              const isTop = depth === 0;
              const rendered = splitRenderResult(
                renderContent(entry.value, {
                  push,
                  replace,
                  pop,
                  close: isTop ? pop : closeAll,
                  closeAll,
                })
              );

              return (
                <DrawerLayer
                  key={entry.key}
                  depth={depth}
                  totalLayers={stack.length}
                  isTop={isTop}
                  onClose={isTop ? pop : undefined}
                  onBack={index > 0 && isTop ? pop : undefined}
                  rightOffset={rightOffset}
                  width={width}
                  depthOffset={depthOffset}
                  headerContent={rendered.header}
                >
                  {rendered.body}
                </DrawerLayer>
              );
            })}
          </>
        )}
      </AnimatePresence>
    );
  }

  return { DrawerStackProvider, useDrawerStack };
}

// ── Layer ────────────────────────────────────────────────────────────────

function DrawerLayer({
  depth,
  totalLayers,
  isTop,
  onClose,
  onBack,
  rightOffset,
  width,
  depthOffset,
  headerContent,
  children,
}: {
  depth: number;
  totalLayers: number;
  isTop: boolean;
  onClose?: () => void;
  onBack?: () => void;
  rightOffset: number;
  width: number;
  depthOffset: number;
  headerContent?: ReactNode;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Focus the top layer on mount so the ESC handler and keyboard users find it.
  useEffect(() => {
    if (isTop && ref.current) {
      ref.current.focus();
    }
  }, [isTop]);

  const layerShift = isTop ? 0 : -(depth * depthOffset + (hovered ? HOVER_EXTRA : 0));
  const scale = isTop ? 1 : 1 - depth * 0.015;
  const opacity = isTop ? 1 : 0.6 + (hovered ? 0.25 : 0);

  return (
    <motion.div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal={isTop}
      aria-label="Drawer panel"
      aria-hidden={!isTop}
      inert={!isTop ? true : undefined}
      initial={{ x: width + 20 }}
      animate={{
        x: layerShift,
        scale,
        opacity,
      }}
      exit={{ x: width + 20, opacity: 0 }}
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
      onKeyDown={event => {
        if (!isTop || event.key !== 'Tab' || !ref.current) return;
        const focusable = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      className="fixed top-0 bottom-0 flex flex-col outline-none"
      style={{
        right: rightOffset,
        width,
        maxWidth: '94vw',
        zIndex: 61 + (totalLayers - depth),
        pointerEvents: isTop ? 'auto' : hovered ? 'auto' : 'none',
      }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-l-xl border-l border-border bg-surface-raised shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground pointer-coarse:size-control-touch"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          {/* Panel-contributed title / badges / etc. Flex grow so it fills
              the space between the back and close buttons. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">{headerContent}</div>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close drawer"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground pointer-coarse:size-control-touch"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </motion.div>
  );
}
