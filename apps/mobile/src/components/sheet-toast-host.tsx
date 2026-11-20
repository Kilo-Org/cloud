import { PortalHost } from '@rn-primitives/portal';
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { Platform, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { claimToastHost } from '@/lib/toast-host';

/** How many native sheets the tree below sits in. */
const SheetDepthContext = createContext(0);

/** The sheet's header, as its toast host needs it: the view, and a count of its layouts. */
type HeaderAnchor = Readonly<{ ref: RefObject<ViewInstance | null>; layouts: number }>;

type HeaderSlot = Readonly<{
  register: (ref: RefObject<ViewInstance | null>) => () => void;
  laidOut: () => void;
}>;

const HeaderSlotContext = createContext<HeaderSlot | null>(null);
const HeaderAnchorContext = createContext<HeaderAnchor | null>(null);

/**
 * Wraps a native sheet's content and, while `hosting`, gives the sheet a toast
 * host as its last child: the app's one Toaster (`AppToaster`) renders into the
 * top host (`@/lib/toast-host`), inside the sheet's own views, so a failure the
 * sheet raises is visible over it. The app's default `PortalHost` sits in the
 * main tree the sheet covers; this one is a named host inside the sheet.
 *
 * Android only. There an imperative `Sheet` is its own window, which covers
 * the root Toaster; route sheets host too, so the in-sheet placement is one
 * rule. On iOS sonner-native's window-level overlay already draws the root
 * Toaster above every presented sheet, so a sheet hosts nothing there and the
 * toast keeps its root placement.
 *
 * A sheet hosts only while it is presented: a dismissing or covered sheet hands
 * the toasts back, so a toast raised as it closes stays on screen. A sheet
 * opened from this sheet's content claims one level deeper, so it wins. The
 * sheet's `SheetHeader` registers here, so the toast can sit below it.
 */
export function SheetToastScope({
  hosting,
  children,
}: Readonly<{ hosting: boolean; children: ReactNode }>) {
  const depth = use(SheetDepthContext) + 1;
  const [header, setHeader] = useState<HeaderAnchor | null>(null);
  const slot = useMemo<HeaderSlot>(
    () => ({
      register: ref => {
        setHeader({ ref, layouts: 0 });
        return () => {
          setHeader(current => (current?.ref === ref ? null : current));
        };
      },
      laidOut: () => {
        setHeader(current => current && { ref: current.ref, layouts: current.layouts + 1 });
      },
    }),
    []
  );
  return (
    <SheetDepthContext value={depth}>
      <HeaderSlotContext value={slot}>
        {children}
        {hosting && Platform.OS === 'android' ? (
          <HeaderAnchorContext value={header}>
            <SheetToastHost depth={depth} />
          </HeaderAnchorContext>
        ) : null}
      </HeaderSlotContext>
    </SheetDepthContext>
  );
}

function SheetToastHost({ depth }: Readonly<{ depth: number }>) {
  const host = useId();
  useEffect(() => claimToastHost(host, depth), [host, depth]);
  return <PortalHost name={host} />;
}

/**
 * Registers a sheet header's view with the sheet's toast host. Returns the
 * header's layout report: the toast re-measures where the header ends each
 * time the header lays out. Outside a sheet there is nothing to report to.
 */
export function useSheetToastHeader(ref: RefObject<ViewInstance | null>): (() => void) | undefined {
  const slot = use(HeaderSlotContext);
  useEffect(() => slot?.register(ref), [slot, ref]);
  return slot?.laidOut;
}

/** The transform-aware rect read `useSettledSheetHeaderTopClearance` also uses. */
type RectReadableView = {
  getBoundingClientRect: () => { top: number; bottom: number };
};

/** The view's rect in window coordinates, or `null` where it cannot be read yet. */
function readRect(node: ViewInstance | null): { top: number; bottom: number } | null {
  const view = node as RectReadableView | null;
  const read = view?.getBoundingClientRect;
  if (read === undefined) {
    return null;
  }
  try {
    const { top, bottom } = read.call(view);
    return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
  } catch {
    return null;
  }
}

/**
 * How far below the top of `anchor` (a view that fills the sheet's content
 * frame) the sheet's toast must start: below the sheet's `SheetHeader`, and
 * never inside the status bar, which a full-window sheet reaches. Re-measures
 * when the header lays out and when the returned handler runs from the
 * anchor's own layout.
 *
 * Both rects come from the same window read, so the presentation offset the
 * platform gives the sheet cancels out. `measureLayout` cannot do this: it only
 * measures against an ancestor, and the anchor is the header's sibling, so on
 * device it failed every time and the toast fell back to the sheet's top edge.
 */
export function useSheetToastClearance(anchor: RefObject<ViewInstance | null>) {
  const header = use(HeaderAnchorContext);
  const statusBar = useSafeAreaInsets().top;
  const [clearance, setClearance] = useState(0);
  const measure = useCallback(() => {
    const anchorRect = readRect(anchor.current);
    if (!anchorRect) {
      return;
    }
    const headerRect = readRect(header?.ref.current ?? null);
    const belowHeader = headerRect ? headerRect.bottom - anchorRect.top : 0;
    const belowStatusBar = statusBar - anchorRect.top;
    setClearance(Math.max(0, belowHeader, belowStatusBar));
  }, [anchor, header, statusBar]);
  useEffect(measure, [measure]);
  return { clearance, onAnchorLayout: measure };
}
