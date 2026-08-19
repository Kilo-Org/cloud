// Collapse an expanded file row when the user marks it viewed.
// Un-marking never re-expands; no-op branches keep the same reference.

/**
 * Returns updated `expanded` after a mark-viewed toggle.
 * `currentlyViewed` is the row's pre-toggle viewed flag — true means this
 * tap is an UN-mark and must not re-expand.
 */
export function collapseOnMarkViewed(
  expanded: Record<string, boolean>,
  path: string,
  currentlyViewed: boolean
) {
  if (currentlyViewed) {
    return expanded;
  }
  if (!expanded[path]) {
    return expanded;
  }
  return { ...expanded, [path]: false };
}
