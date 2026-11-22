import { type ReactNode, useState } from 'react';

import { isFormSheetRoute } from '@/lib/form-sheet-routes';

/**
 * Holds a PR-review gate arm back while a form sheet of the review stack is
 * presented, and replaces the review subtree the rest of the time.
 *
 * The gate covers the route's `Stack`, and a `formSheet` route — the
 * conversation or inline comment composer, the submit-review and merge sheets —
 * is a scene of that stack, drawn inside the same native window. Replacing the
 * stack while the reader has one of those sheets open tears the sheet's content
 * down and leaves its native surface behind as a dimmed, empty panel (measured
 * on Android: a uniform dim, one empty full-screen group, no title, no body
 * field, no footer). An arm drawn above the stack instead covers the sheet the
 * same way, so it is no better: a full-bleed surface in the layout's view paints
 * over the sheet's own scene.
 *
 * A status change can arrive exactly while a sheet is open: the integration
 * status is re-read after a scope switch, a reconnect check, an organization
 * selection restore, or a failed read. So:
 *
 *  - Before the subtree has mounted at all, the arm replaces it. A reader who is
 *    not connected never mounts the authenticated review queries below, and a
 *    deep link straight to a sheet route cannot present a sheet the gate would
 *    cover.
 *  - Once the subtree has mounted, an arm that arrives while one of the stack's
 *    sheets is presented waits. The reader keeps the sheet they are typing in —
 *    header, body field and submit stay mounted and live — and the arm takes the
 *    screen on the first frame after the sheet is dismissed, when nothing is
 *    presented to tear down.
 */
export function PrReviewGateSurface({
  arm,
  segments,
  children,
}: Readonly<{
  /** The gate arm to render when the review subtree may be replaced. */
  arm: ReactNode | null;
  /** The current route segments, as `useSegments()` reports them. */
  segments: readonly string[];
  children: ReactNode;
}>) {
  // The subtree has mounted at least once. Adjusted during render, the
  // established "derive state from props" pattern: a discarded render takes the
  // adjustment with it, and the re-render it schedules commits the latch before
  // any later arm can replace the stack.
  const [mounted, setMounted] = useState(arm === null);
  if (arm === null && !mounted) {
    setMounted(true);
  }
  if (arm === null || (mounted && isFormSheetRoute(segments))) {
    return <>{children}</>;
  }
  return <>{arm}</>;
}
