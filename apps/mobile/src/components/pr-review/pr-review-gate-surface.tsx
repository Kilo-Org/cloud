import { type ReactNode, useState } from 'react';
import { View } from 'react-native';

/**
 * Keeps the PR-review subtree (`children`) mounted once it has mounted, and
 * draws a later gate arm above it instead of replacing it.
 *
 * The gate covers the route's `Stack`, and a `formSheet` route — the
 * conversation or inline comment composer, the submit-review and merge sheets —
 * is a scene of that stack. Replacing the stack while the reader has one of
 * those sheets open tears the sheet's content down and leaves its native
 * surface behind as a dimmed, empty panel (measured on Android: a uniform dim,
 * one empty full-screen group, no title, no body field, no footer). A status
 * change can arrive exactly then: the integration status is re-read after a
 * scope switch, a reconnect check, an organization selection restore, or a
 * failed read.
 *
 * So the first decision still replaces the subtree: a reader who is not
 * connected never mounts the authenticated review queries below, and a deep link
 * straight to a sheet route cannot present a sheet the gate would cover. After
 * that, an arm is an opaque overlay in this layout's own view. The covered
 * scene keeps its mounted state — the reader's tab, scroll position and any
 * presented sheet — while the arm explains the new state above it.
 *
 * The covered tree leaves touch and the accessibility tree while an arm is up,
 * the presentation `CoveredScreenA11yGate` gives a covered scene. A presented
 * route `formSheet` is its own native window on both platforms, so the arm
 * cannot paint over it and neither flag reaches into it: the reader keeps the
 * sheet they are typing in, and the arm takes the screen once they dismiss it.
 * `collapsable={false}` keeps the native view, because Android collapses a view
 * whose only props are styles and then drops its accessibility props.
 */
export function PrReviewGateSurface({
  arm,
  children,
}: Readonly<{
  /** The gate arm to draw above the review subtree; `null` renders it alone. */
  arm: ReactNode | null;
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
  if (!mounted) {
    return <>{arm}</>;
  }
  const covered = arm !== null;
  return (
    <View className="flex-1">
      <View
        className="flex-1"
        collapsable={false}
        pointerEvents={covered ? 'none' : 'auto'}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {covered ? <View className="absolute inset-0">{arm}</View> : null}
    </View>
  );
}
