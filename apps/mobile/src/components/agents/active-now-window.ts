/**
 * Cap on the number of pinned "Active now" rows shown while the tray is
 * collapsed. Three keeps the tray (~260-280pt) visible on the smallest
 * supported iPhone class (~667pt viewport) without pushing the history
 * sections off-screen.
 */
export const ACTIVE_NOW_TRAY_CAP = 3;

type TrayWindow<T> = {
  visible: T[];
  hiddenCount: number;
};

/**
 * Pure selection helper for the pinned "Active now" tray window.
 *
 * Rules:
 * - `pinned.length <= cap` → all rows visible, `hiddenCount` is 0, no
 *   expander button should be rendered.
 * - collapsed → first `cap` rows (preserving caller order, which is the
 *   existing `selectPinnedActiveSessions` order), `hiddenCount` is
 *   `pinned.length - cap` and the expander button is `+N more`.
 * - expanded → all rows visible, `hiddenCount` is `pinned.length - cap`
 *   (the caller uses that to render `Show less` whenever some rows are
 *   hidden). When the count drops to `≤ cap` the caller stops rendering
 *   any button; the `expanded` state may stay true harmlessly.
 *
 * No animation, no React, no data fetch — just slice/len arithmetic.
 */
export function selectTrayWindow<T>(pinned: T[], expanded: boolean, cap: number): TrayWindow<T> {
  const hiddenCount = Math.max(0, pinned.length - cap);
  if (pinned.length <= cap) {
    return { visible: pinned, hiddenCount };
  }
  if (expanded) {
    return { visible: pinned, hiddenCount };
  }
  return { visible: pinned.slice(0, cap), hiddenCount };
}
