import { type Href } from 'expo-router';

/**
 * Whether the cold-start relaunch repair should navigate to the recorded
 * route: the record must belong to this account, name a recordable route
 * (never a gate), and differ from the route the process actually restored
 * (the base Intent's destination). Same destination means the OS restore
 * already reopened the right screen and there is nothing to repair.
 *
 * A launch that opened one of the app's own routes is not repaired at all: the
 * OS hands the same base Intent to a killed task and to a fresh link tap, so
 * the only remaining evidence of intent is which link the launch named. A
 * universal link is the shape a killed task replays (a notification or a web
 * session link from an earlier process), so the recorded route replaces it; a
 * route inside the app is a screen this launch was started for, and the pending
 * consumer opens it above the shell instead.
 *
 * The root layouts' groups (`(app)`, `(tabs)`) are routing groups and are
 * stripped from both sides. A parenthesized tab (`(3_profile)`) or nested
 * layout is a destination and stays, so two sides that differ only by which
 * tab is focused are still different screens.
 */
export function shouldRepairRestoredRoute(input: {
  readonly recordedHref: string | null;
  readonly restoredRoute: string;
  readonly launchOpenedAppRoute: boolean;
}): boolean {
  if (input.launchOpenedAppRoute) {
    return false;
  }
  if (input.recordedHref === null) {
    return false;
  }
  return normalizedRoutePath(input.recordedHref) !== normalizedRoutePath(input.restoredRoute);
}

/**
 * Where an automatic restore falls back when the recorded route cannot open:
 * the Home tab, the screen the app starts on.
 */
export const RESTORED_ROUTE_FALLBACK_HREF = '/(app)/(tabs)/(0_home)' as Href;

/** Route groups that name a layout, not a destination. */
const LAYOUT_GROUPS = {
  '(app)': true,
  '(auth)': true,
  '(tabs)': true,
} as const;

/**
 * The path two routes are compared on: the query dropped and the layout groups
 * stripped, so a recorded href (`/(app)/agent-chat/ses_1?at=msg_2`) and the
 * pathname the screen reports (`/agent-chat/ses_1`) name the same destination.
 */
export function normalizedRoutePath(path: string): string {
  const withoutQuery = path.includes('?') ? path.slice(0, path.indexOf('?')) : path;
  return withoutQuery
    .split('/')
    .filter(part => part.length > 0 && !Object.hasOwn(LAYOUT_GROUPS, part))
    .join('/');
}
