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
  useRef,
  useState,
} from 'react';
import { Platform, type ViewInstance } from 'react-native';

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

/**
 * Where the sheet's header ends, measured from the top of `anchor` (a view
 * that fills the sheet's content frame), or `null` while the sheet has no
 * header or it has not been measured. Re-measures when the header lays out
 * and when the returned handler runs from the anchor's own layout.
 */
export function useSheetHeaderBottom(anchor: RefObject<ViewInstance | null>) {
  const header = use(HeaderAnchorContext);
  const [headerBottom, setHeaderBottom] = useState<number | null>(null);
  const request = useRef(0);
  const measure = useCallback(() => {
    request.current += 1;
    const attempt = request.current;
    const anchorNode = anchor.current;
    const headerNode = header?.ref.current;
    if (!anchorNode || !headerNode) {
      setHeaderBottom(null);
      return;
    }
    headerNode.measureLayout(
      anchorNode,
      (...frame) => {
        const [, top, , height] = frame;
        if (attempt === request.current) {
          setHeaderBottom(top + height);
        }
      },
      () => {
        if (attempt === request.current) {
          setHeaderBottom(null);
        }
      }
    );
  }, [anchor, header]);
  useEffect(measure, [measure]);
  return { headerBottom, onAnchorLayout: measure };
}
