import { PortalHost } from '@rn-primitives/portal';
import { createContext, type ReactNode, use, useEffect, useId } from 'react';

import { claimToastHost } from '@/lib/toast-host';

/** How many native sheets the tree below sits in. */
const SheetDepthContext = createContext(0);

/**
 * Wraps a native sheet's content and, while `hosting`, gives the sheet a toast
 * host as its last child: the app's one Toaster (`AppToaster`) renders into the
 * top host (`@/lib/toast-host`), inside the sheet's own views, so a failure the
 * sheet raises is visible over it. The app's default `PortalHost` sits in the
 * main tree the sheet covers; this one is a named host inside the sheet.
 *
 * A sheet hosts only while it is presented: a dismissing or covered sheet hands
 * the toasts back, so a toast raised as it closes stays on screen. A sheet
 * opened from this sheet's content claims one level deeper, so it wins.
 */
export function SheetToastScope({
  hosting,
  children,
}: Readonly<{ hosting: boolean; children: ReactNode }>) {
  const depth = use(SheetDepthContext) + 1;
  return (
    <SheetDepthContext value={depth}>
      {children}
      {hosting ? <SheetToastHost depth={depth} /> : null}
    </SheetDepthContext>
  );
}

function SheetToastHost({ depth }: Readonly<{ depth: number }>) {
  const host = useId();
  useEffect(() => claimToastHost(host, depth), [host, depth]);
  return <PortalHost name={host} />;
}
