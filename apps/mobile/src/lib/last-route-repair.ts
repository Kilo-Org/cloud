/**
 * Whether the cold-start relaunch repair should navigate to the recorded
 * route: the record must belong to this account, name a recordable route
 * (never a gate), and differ from the route the process actually restored
 * (the base Intent's destination). Same destination means the OS restore
 * already reopened the right screen and there is nothing to repair.
 *
 * The root layouts' groups (`(app)`, `(tabs)`) are routing groups and are
 * stripped from both sides. A parenthesized tab (`(3_profile)`) or nested
 * layout is a destination and stays, so two sides that differ only by which
 * tab is focused are still different screens.
 */
export function shouldRepairRestoredRoute(input: {
  readonly recordedHref: string | null;
  readonly restoredRoute: string;
}): boolean {
  if (input.recordedHref === null) {
    return false;
  }
  return normalizeRoutePath(input.recordedHref) !== normalizeRoutePath(input.restoredRoute);
}

/** Route groups that name a layout, not a destination. */
const LAYOUT_GROUPS = {
  '(app)': true,
  '(auth)': true,
  '(tabs)': true,
} as const;

function normalizeRoutePath(path: string): string {
  const withoutQuery = path.includes('?') ? path.slice(0, path.indexOf('?')) : path;
  return withoutQuery
    .split('/')
    .filter(part => part.length > 0 && !Object.hasOwn(LAYOUT_GROUPS, part))
    .join('/');
}
